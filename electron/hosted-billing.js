// Desktop side of the Capturia Pro upgrade flow (M11 slice 2). Owns the
// three main-process jobs the renderer must never do itself:
//
//   1. startCheckout(): asks the billing origin for a Stripe Checkout URL
//      (the renderer only triggers it; the URL opens in the OS browser).
//   2. activate(code): trades the one-time activation code for a refresh
//      token + first JWT and stores BOTH in the OS-keychain vault
//      (electron/keychain.js); the plaintext never touches a renderer.
//   3. a refresh loop that keeps the short-lived JWT fresh from the refresh
//      token, so a presenter's hosted session survives beyond one JWT
//      lifetime without ever re-pasting anything.
//
// All decisions (origin derivation, response validation, refresh timing and
// failure classification) live in lib/hosted-billing.ts via electron/gen;
// this file is just wiring: fetch, keychain, timers, and a device id.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");
const {
  billingOriginFromEnv,
  classifyRefreshFailure,
  computeRefreshDelayMs,
  normalizeActivationCode,
  parseActivateResponse,
  parseTokenResponse,
  RETRY_TRANSIENT_MS,
  RETRY_UNENTITLED_MS,
} = require("./gen/hosted-billing");

const HOSTED_SLOT = "capturia-hosted";

// One stable, random device id per install, minted on first activation. Its
// own file (not settings.json) so this module never races the telemetry
// module's read-modify-write of that file. Not secret: it only counts
// device seats server-side; the credentials live in the keychain.
function deviceIdPath() {
  return path.join(app.getPath("userData"), "hosted-device.json");
}

function getOrMintDeviceId() {
  try {
    const parsed = JSON.parse(fs.readFileSync(deviceIdPath(), "utf8"));
    if (typeof parsed.deviceId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(parsed.deviceId)) {
      return parsed.deviceId;
    }
  } catch {
    // first run or unreadable: mint below
  }
  const deviceId = `mac-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(deviceIdPath()), { recursive: true });
  fs.writeFileSync(deviceIdPath(), JSON.stringify({ deviceId }), { mode: 0o600 });
  return deviceId;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

// env is main's effective env (dev .env files merged under the OS env, same
// resolver the runtime server and deck codegen use), so a dev
// CAPTURIA_HOSTED_URL override points checkout, activation, and token
// refresh at the same deployment as the proxy itself.
function createHostedBilling({ keychain, env = process.env, log = console } = {}) {
  let refreshTimer = null;
  let stopped = false;

  function scheduleRefresh(delayMs) {
    if (stopped) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshNow().catch(() => {
        // refreshNow never throws by design; belt and suspenders.
      });
    }, delayMs);
    // A pending refresh must never hold the app open at quit.
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
  }

  function origin() {
    return billingOriginFromEnv(env);
  }

  async function startCheckout() {
    const { status, ok, json } = await postJson(`${origin()}/api/billing/checkout`);
    const url = json && typeof json.url === "string" ? json.url : null;
    if (!ok || !url) {
      const detail = json && typeof json.error === "string" ? json.error : `HTTP ${status}`;
      throw new Error(`Could not start checkout: ${detail}`);
    }
    return url;
  }

  async function activate(rawCode) {
    const code = normalizeActivationCode(rawCode);
    if (!code) {
      throw new Error("That does not look like a Capturia activation code (CAPTURIA-XXXX-XXXX-XXXX-XXXX).");
    }
    const deviceId = getOrMintDeviceId();
    const { status, ok, json } = await postJson(`${origin()}/api/billing/activate`, {
      code,
      deviceId,
    });
    if (!ok) {
      const detail = json && typeof json.error === "string" ? json.error : `HTTP ${status}`;
      throw new Error(detail);
    }
    const result = parseActivateResponse(json);
    if (!result) throw new Error("Activation returned an unexpected response; try again.");
    // Refresh token first: if the second write fails the worst case is a
    // token refresh on next launch, never a stored JWT with no way to renew.
    keychain.saveKey(keychain.REFRESH_SLOT, result.refreshToken);
    keychain.saveKey(HOSTED_SLOT, result.token);
    scheduleRefresh(computeRefreshDelayMs(result.expiresAt, Date.now()));
    log.log(`capturia billing: activated (device seats used: ${result.devices})`);
    return { ok: true, devices: result.devices };
  }

  // Never throws: refresh outcomes are state transitions, not errors the
  // caller can act on. 401/403 drop the credentials (revoked token or
  // deactivated device: the user re-activates with a fresh code); 402 keeps
  // the refresh token and retries slowly (Stripe may recover the
  // subscription); anything else is transient and retries soon.
  async function refreshNow() {
    const refreshToken = keychain.getKey(keychain.REFRESH_SLOT);
    if (!refreshToken) return { refreshed: false, reason: "no_refresh_token" };
    let status = 0;
    let json = null;
    try {
      ({ status, json } = await postJson(`${origin()}/api/billing/token`, { refreshToken }));
    } catch {
      scheduleRefresh(RETRY_TRANSIENT_MS);
      return { refreshed: false, reason: "network" };
    }
    const result = status === 200 ? parseTokenResponse(json) : null;
    if (result) {
      keychain.saveKey(HOSTED_SLOT, result.token);
      scheduleRefresh(computeRefreshDelayMs(result.expiresAt, Date.now()));
      return { refreshed: true };
    }
    const failure = classifyRefreshFailure(status);
    if (failure === "drop_credentials") {
      keychain.clearKey(keychain.REFRESH_SLOT);
      keychain.clearKey(HOSTED_SLOT);
      log.log(`capturia billing: hosted credentials dropped (HTTP ${status})`);
      return { refreshed: false, reason: "revoked" };
    }
    scheduleRefresh(failure === "keep_and_retry_slowly" ? RETRY_UNENTITLED_MS : RETRY_TRANSIENT_MS);
    return { refreshed: false, reason: `http_${status}` };
  }

  // App boot: if an install has a refresh token, get a fresh JWT right away
  // (the stored one may have expired while the app was closed).
  function start() {
    if (keychain.getKey(keychain.REFRESH_SLOT)) {
      refreshNow().catch(() => {});
    }
  }

  // The user cleared the Pro row: both slots go, and the pending refresh
  // with them.
  function deactivateLocal() {
    clearTimeout(refreshTimer);
    keychain.clearKey(keychain.REFRESH_SLOT);
    keychain.clearKey(HOSTED_SLOT);
  }

  function stop() {
    stopped = true;
    clearTimeout(refreshTimer);
  }

  return { startCheckout, activate, refreshNow, start, deactivateLocal, stop };
}

module.exports = { createHostedBilling, HOSTED_SLOT };
