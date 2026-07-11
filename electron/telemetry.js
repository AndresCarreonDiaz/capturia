// Anonymous usage beacon for the desktop app. The whole wire contract is
// four fields, POSTed to the hosted /api/beacon (see docs/telemetry.md and
// lib/beacon.ts): a random installId minted once per install, the event
// name, the app version, and the macOS version. Never audio, transcripts,
// overlay or deck content, keys, or anything else; that promise is the
// product's spine, so this module is deliberately tiny and auditable.
//
// Posture:
//   - Default ON, and `telemetry: false` in userData/settings.json turns it
//     off entirely (the Settings modal and onboarding expose the toggle over
//     IPC; hand-editing the file works too).
//   - Fire-and-forget: one attempt per event per run, short timeout, and
//     every failure (offline, DNS, 4xx/5xx) is swallowed silently. There is
//     no queue and no retry, so the app can never storm the endpoint.
//   - "camera-installed" additionally reports at most once per install
//     (persisted after a successful send): activation is a funnel step, not
//     a heartbeat.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Production beacon endpoint; CAPTURIA_BEACON_URL overrides it in dev (point
// it at http://localhost:3000/api/beacon to watch pings land in the local
// store via the summary endpoint).
const DEFAULT_BEACON_URL = "https://capturia.app/api/beacon";
const SEND_TIMEOUT_MS = 3000;

// Simple settings store in userData (same pattern as first-run.json):
// read-modify-write of a small JSON object, resilient to a missing or
// corrupt file. Holds { telemetry, installId, cameraInstalledReported }.
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
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }));
  } catch (err) {
    console.warn("Capturia: could not persist settings:", err);
  }
}

// createTelemetry({ disabled }): `disabled` hard-disables sending for this
// run regardless of the setting (smoke/e2e gates pass isSmoke so unattended
// runs never pollute production counters). The toggle IPC still works.
function createTelemetry({ disabled = false, log = console } = {}) {
  const beaconUrl = process.env.CAPTURIA_BEACON_URL || DEFAULT_BEACON_URL;
  // One attempt per event per run, enforced up front: even a failed send
  // must not repeat until the next launch (no retry storms by construction).
  const attempted = new Set();

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
    return readSettings().telemetry !== false; // absent means ON
  }

  function setEnabled(enabled) {
    writeSettings({ telemetry: Boolean(enabled) });
    return isEnabled();
  }

  function send(event) {
    try {
      if (disabled || !isEnabled() || attempted.has(event)) return;
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
      // The beacon must never take the shell down with it.
      log.warn("Capturia: telemetry send skipped:", err);
    }
  }

  return { send, isEnabled, setEnabled };
}

module.exports = { createTelemetry };
