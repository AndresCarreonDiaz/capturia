// Smoke test for electron/runtime-server.js under plain Node (no Electron):
// starts the server with a stub keychain and drives the auth + protocol
// surface end to end over real HTTP. Exercises exactly what a renderer does
// short of running a model: preflight, origin gate, token gate, the
// {method:"info"} passthrough, the capturia-keycheck probe, and the
// RENDERER_PROVIDERS fence (a header naming a main-internal vault slot must
// read as "no stored key" and must never reach the keychain).
//
//   node scripts/smoke-runtime-server.mjs
//
// Exits 0 when every check passes. Compiles electron/gen/ first so it is
// self-contained.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts", "build-electron-libs.mjs")], {
  stdio: "inherit",
});

const require = createRequire(import.meta.url);
const { startRuntimeServer } = require(join(root, "electron", "runtime-server.js"));

// A vault mirroring the real contract (electron/keychain.js): a gemini key
// stored like a real desktop after onboarding, plus the two hosted slots the
// vault also holds: the renderer-nameable "capturia-hosted" JWT and the
// main-internal "capturia-hosted-refresh" token. The internal slot returns a
// real value on purpose; if the RENDERER_PROVIDERS fence in runtime-server.js
// were removed, that secret would surface as a stored key and the fence
// checks below would go red (a stub that throws for it would mask exactly
// that regression). getKey throws only for names the real keychain rejects,
// and getKeyCalls records every lookup so the checks can assert the vault is
// never even consulted for the internal slot.
const stubVault = {
  gemini: "smoke-stored-key",
  claude: null,
  openai: null,
  "capturia-hosted": "eyJhbGciOiJIUzI1NiJ9.eyJzbW9rZSI6dHJ1ZX0.c21va2Utc2ln",
  "capturia-hosted-refresh": "smoke-refresh-secret",
};
const getKeyCalls = [];
const stubKeychain = {
  getKey(provider) {
    getKeyCalls.push(provider);
    if (!(provider in stubVault)) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return stubVault[provider];
  },
};

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const server = await startRuntimeServer({
  keychain: stubKeychain,
  isDev: false,
  env: {}, // no env keys: the env-fallback path must fail keycheck
});

const post = (body, headers = {}) =>
  fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const tokenHeader = { "x-capturia-token": server.token };

try {
  check("returns loopback url + token", /^http:\/\/127\.0\.0\.1:\d+\/api\/copilotkit$/.test(server.url) && server.token.length === 64, server.url);

  let r = await post({ method: "capturia-keycheck" });
  check("no token -> 401", r.status === 401, `status ${r.status}`);

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, origin: "https://evil.example" });
  check("disallowed origin -> 403 even with token", r.status === 403, `status ${r.status}`);

  r = await fetch(server.url, {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST" },
  });
  check(
    "preflight from file:// renderer -> 204 + CORS",
    r.status === 204 && r.headers.get("access-control-allow-origin") === "null",
    `status ${r.status}`
  );

  r = await post({ method: "info" }, tokenHeader);
  check("info handshake passes the key guard", r.status === 200, `status ${r.status}`);

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "gemini", origin: "null" });
  let body = await r.json();
  check("keycheck ok with a stored key (BYOK)", r.status === 200 && body.ok === true, JSON.stringify(body));
  check("CORS reflected on actual response", r.headers.get("access-control-allow-origin") === "null");

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "claude" });
  body = await r.json();
  check("keycheck fails without stored or env key", body.ok === false && typeof body.error === "string", String(body.error).slice(0, 60));

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "not-a-provider" });
  body = await r.json();
  check("hostile provider header -> no throw, keycheck answers", r.status === 200 && body.ok === false);

  // The RENDERER_PROVIDERS fence. "capturia-hosted" is renderer-nameable
  // (electron/ipc-schemas.js), so its stored JWT legitimately satisfies the
  // keycheck; "capturia-hosted-refresh" is main-internal, so even though the
  // stub vault holds a real secret for it, every endpoint that consults
  // storedKeyFor must treat it as "no stored key".
  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "capturia-hosted" });
  body = await r.json();
  check("keycheck ok for capturia-hosted (renderer-nameable JWT slot)", r.status === 200 && body.ok === true, JSON.stringify(body));

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "capturia-hosted-refresh" });
  body = await r.json();
  check(
    "main-internal refresh slot reads as no stored key on keycheck",
    r.status === 200 && body.ok === false && typeof body.error === "string",
    JSON.stringify(body)
  );

  r = await post({ method: "agent/run" }, { ...tokenHeader, "x-capturia-provider": "capturia-hosted-refresh" });
  check("refresh-slot header on a model-running method -> 503, never a run", r.status === 503, `status ${r.status}`);

  r = await post({ method: "info" }, { ...tokenHeader, "x-capturia-provider": "capturia-hosted-refresh" });
  check("info handshake unaffected by an internal-slot header", r.status === 200, `status ${r.status}`);

  r = await post({ method: "agent/run" }, tokenHeader);
  check("model-running method without any key -> 503 fail-fast", r.status === 503, `status ${r.status}`);

  // Call-log assertions: the fence must stop internal slots BEFORE the vault,
  // so the refresh secret can never reach resolveDesktopAgentSpec, while the
  // hosted JWT lookup stays a real keychain read (its exposure to the
  // Capturia proxy is the intended mechanism, not a leak).
  check(
    "vault never consulted for the refresh slot",
    !getKeyCalls.includes("capturia-hosted-refresh"),
    `getKey saw: ${[...new Set(getKeyCalls)].join(", ")}`
  );
  check("vault consulted for the hosted JWT slot", getKeyCalls.includes("capturia-hosted"));
} finally {
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll runtime-server smoke checks passed.");
