// Anonymous usage beacon for the desktop app. The whole wire contract is
// four fields, POSTed to the hosted /api/beacon (see docs/telemetry.md and
// lib/beacon.ts): a random installId minted once per install, the event
// name, the app version, and the macOS version. Never audio, transcripts,
// overlay or deck content, keys, or anything else; that promise is the
// product's spine, so this module is deliberately tiny and auditable.
//
// Posture:
//   - Consent before the first byte: on a FIRST run (settings.json has no
//     `telemetry` key yet) nothing is sent and no installId is minted until
//     the renderer acknowledges that the onboarding disclosure was resolved
//     (welcome step dismissed with the toggle state known, or onboarding
//     already completed in an earlier session). Events raised before that
//     park in a queue and flush, or drop silently, on the acknowledgment.
//     Every later run has the `telemetry` key and sends immediately.
//   - Default ON once disclosed, and `telemetry: false` in
//     userData/settings.json turns it off entirely (the Settings modal and
//     onboarding expose the toggle over IPC; hand-editing the file works too).
//   - Unpackaged builds (npm run electron / electron-dev on this public
//     repo) never talk to production: without an explicit CAPTURIA_BEACON_URL
//     the beacon is hard-off in dev, so dev launches cannot count as installs.
//   - Fire-and-forget: one attempt per event per run, short timeout, and
//     every failure (offline, DNS, 4xx/5xx) is swallowed silently. There is
//     no retry, so the app can never storm the endpoint.
//   - "camera-installed" additionally reports at most once per install
//     (persisted after a successful send): activation is a funnel step, not
//     a heartbeat.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Production beacon endpoint; CAPTURIA_BEACON_URL overrides it (point it at
// http://localhost:3000/api/beacon to watch pings land in the local store
// via the summary endpoint). In an unpackaged build the override is also the
// opt-in: no CAPTURIA_BEACON_URL, no sending at all.
const DEFAULT_BEACON_URL = "https://www.capturia.dev/api/beacon";
const SEND_TIMEOUT_MS = 3000;

// Simple settings store in userData: read-modify-write of a small JSON
// object, resilient to a missing or corrupt file. Holds { telemetry,
// installId, cameraInstalledReported }. Writes go through a temp file +
// rename so a crash mid-write can never truncate the file and lose a
// persisted opt-out.
function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  try {
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...readSettings(), ...patch }));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn("Capturia: could not persist settings:", err);
  }
}

// createTelemetry({ disabled }): `disabled` hard-disables sending for this
// run regardless of the setting (smoke/e2e gates pass isSmoke so unattended
// runs never pollute production counters). The toggle IPC still works.
function createTelemetry({ disabled = false, log = console } = {}) {
  const beaconUrl = process.env.CAPTURIA_BEACON_URL || DEFAULT_BEACON_URL;
  // Dev shells stay silent unless a beacon URL was explicitly pointed
  // somewhere (a local dev server); production metrics must only ever see
  // packaged installs.
  const devWithoutTarget = !app.isPackaged && !process.env.CAPTURIA_BEACON_URL;
  const hardOff = disabled || devWithoutTarget;
  // One attempt per event per run, enforced up front: even a failed send
  // must not repeat until the next launch (no retry storms by construction).
  const attempted = new Set();
  // First-run consent gate: events raised before the disclosure has been on
  // screen wait here. Flushed (or dropped, if the user unchecked the toggle)
  // by ackDisclosure/setEnabled; a run that never resolves consent (user
  // quits at the welcome card) sends nothing and minted nothing.
  let pendingConsent = [];

  // Consent is "resolved" once settings.json carries an explicit telemetry
  // key: either the renderer acknowledged the disclosure (persisting the
  // default) or the user toggled it at some point.
  function consentResolved() {
    return typeof readSettings().telemetry === "boolean";
  }

  // The installId exists only on installs that were allowed to send at
  // least once: minted lazily at the first actual send decision, never
  // before consent and never on an opted-out install.
  function ensureInstallId() {
    const settings = readSettings();
    if (typeof settings.installId === "string" && settings.installId) {
      return settings.installId;
    }
    const installId = crypto.randomUUID();
    writeSettings({ installId });
    return installId;
  }

  function isEnabled() {
    return readSettings().telemetry !== false; // absent means ON (pre-consent default)
  }

  function flushPendingConsent() {
    const queue = pendingConsent;
    pendingConsent = [];
    for (const event of queue) deliver(event);
  }

  // Renderer -> main: the onboarding disclosure was resolved (welcome step
  // dismissed, tour skipped, or onboarding already completed in an earlier
  // session). Persists the toggle state so every later run is a non-first
  // run, then flushes whatever was parked; deliver() drops it all silently
  // when the user unchecked the box.
  function ackDisclosure() {
    if (!consentResolved()) {
      writeSettings({ telemetry: isEnabled() });
    }
    flushPendingConsent();
    return isEnabled();
  }

  function setEnabled(enabled) {
    // An explicit toggle IS the consent decision, whichever surface it came
    // from, so it also releases the parked queue.
    writeSettings({ telemetry: Boolean(enabled) });
    flushPendingConsent();
    return isEnabled();
  }

  // The actual wire attempt; only reachable with consent resolved (or a
  // pre-consent flush, which re-checks the persisted state here).
  function deliver(event) {
    try {
      if (hardOff || !isEnabled() || attempted.has(event)) return;
      if (event === "camera-installed" && readSettings().cameraInstalledReported) return;
      attempted.add(event);
      const payload = {
        installId: ensureInstallId(),
        event,
        appVersion: app.getVersion(),
        macosVersion:
          typeof process.getSystemVersion === "function"
            ? process.getSystemVersion()
            : "0.0",
      };
      fetch(beaconUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
        .then((res) => {
          if (res.ok && event === "camera-installed") {
            writeSettings({ cameraInstalledReported: true });
          }
        })
        .catch(() => {
          // Offline, blocked, or the server is down: silence is the contract.
        });
    } catch (err) {
      // A malformed CAPTURIA_BEACON_URL throws synchronously from fetch; the
      // beacon must never take the shell down with it.
      log.warn("Capturia: telemetry send skipped:", err);
    }
  }

  function send(event) {
    try {
      if (hardOff) return;
      if (!consentResolved()) {
        // First run, disclosure not on screen yet: park it (deduplicated).
        if (!pendingConsent.includes(event)) pendingConsent.push(event);
        return;
      }
      deliver(event);
    } catch (err) {
      // The beacon must never take the shell down with it.
      log.warn("Capturia: telemetry send skipped:", err);
    }
  }

  return { send, isEnabled, setEnabled, ackDisclosure };
}

module.exports = { createTelemetry };
