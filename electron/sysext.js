// In-app camera-extension activation (M8 slice 2). The packaged Capturia.app
// embeds the CMIO extension at Contents/Library/SystemExtensions, and macOS
// only accepts an activation request from the app that embeds it; this module
// owns that request from Electron main via the capturia-sysext addon, plus
// the machine-state detection around it.
//
// State comes from three places, all reduced by the pure lib (lib/sysext.ts,
// via electron/gen):
//   1. `systemextensionsctl list` (no privileges needed): is the extension
//      activated+enabled on this machine, or parked on the System Settings
//      approval? This is why a machine where the dev host app already
//      activated the extension immediately reports "installed" without any
//      request being fired.
//   2. The live OSSystemExtensionRequest delegate events forwarded by the
//      addon (requesting / awaiting approval / completed / failed).
//   3. Build capabilities: only a packaged app that actually embeds the
//      extension AND was signed with com.apple.developer.system-extension.
//      install (profile-authorized; see docs/virtual-camera.md) can request
//      activation. The dev shell (npm run electron) is never supported; its
//      workflow stays the dev host app in native/CapturiaCamera. Unsupported
//      builds report exactly that and the tray/onboarding hide the install.
//
// Failure posture matches camera-feed.js: never crash the shell. A missing
// addon, an unsigned build, or a failed request all land in getState(),
// never as exceptions.

const { app } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const {
  SYSEXT_BUNDLE_ID,
  formatExtensionVersion,
  parseSystemExtensionsList,
  reduceRequestEvent,
  sysextNeedsUpgrade,
  sysextUiStatus,
  sysextVersionRelation,
} = require("./gen/sysext");

// How often to re-poll systemextensionsctl while an install could still
// land out-of-band (the user approving in System Settings, the extension
// enumerating late after login). Stops mattering once enabled.
const LIST_POLL_MS = 15_000;

const ADDON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "capturia_sysext.node")
  : path.join(
      __dirname,
      "..",
      "native",
      "capturia-sysext",
      "build",
      "Release",
      "capturia_sysext.node"
    );

// The .app bundle root, derived from the executable path
// (Capturia.app/Contents/MacOS/Capturia); only meaningful when packaged.
function appBundlePath() {
  return path.resolve(app.getPath("exe"), "..", "..", "..");
}

function embeddedExtensionPath() {
  return path.resolve(
    app.getPath("exe"),
    "..",
    "..",
    "Library",
    "SystemExtensions",
    `${SYSEXT_BUNDLE_ID}.systemextension`
  );
}

// createSysext({ onStateChange, onInstalled, offerMove, log }):
//   onStateChange(state)  push on every status transition (tray + renderer).
//   onInstalled()         the cue to nudge the camera feed to connect. Fires
//                         when an activation request completes AND when the
//                         list poll observes the extension flipping to
//                         enabled out-of-band (the System Settings approval
//                         landing after the requesting app session is gone).
//   offerMove()           the /Applications move offer; wired to first-run's
//                         dialog so the "needs-move" install click has a path
//                         forward instead of a guaranteed OS error.
function createSysext({ onStateChange, onInstalled, offerMove, log = console } = {}) {
  let disposed = false;
  let addon; // undefined = never tried, null = load failed
  // Build capability, resolved asynchronously at create time; until then the
  // status reads "unsupported", which flips within moments on capable builds.
  // `ready` resolves once the probe settles, so the packaged smoke can wait
  // for a truthful status instead of racing the codesign exec.
  let supported = false;
  let readyResolve;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });
  let list = { present: false, enabled: false, awaitingApproval: false, enabledVersion: null };
  let request = { phase: "idle", completed: false, error: null };
  // The embedded extension's version ("short/bundle", matching how
  // systemextensionsctl prints versions), read from its Info.plist during the
  // capability probe; null until known. Drives the launch upgrade check.
  let embeddedVersion = null;
  // The app auto-requests a replacement at most once per run when the
  // embedded version is NEWER than the enabled one (the OBS launch pattern);
  // same versions stay a deliberate no-request (a request WOULD no-op
  // quietly, but firing one every launch is noise).
  let upgradeRequested = false;
  // Warned once per run that this build embeds an OLDER extension than the
  // enabled one; the auto-upgrade must never downgrade a machine.
  let downgradeWarned = false;
  let pollTimer = null;
  let lastPushed = "";

  function loadAddon() {
    if (addon !== undefined) return addon;
    try {
      addon = require(ADDON_PATH);
    } catch (err) {
      addon = null;
      log.error(
        app.isPackaged
          ? `Capturia: capturia-sysext addon missing from the packaged app (${ADDON_PATH}); repack with npm run pack:mac:`
          : "Capturia: capturia-sysext addon not built (node scripts/build-sysext-addon.mjs):",
        err.message
      );
    }
    return addon;
  }

  function getState() {
    const status = sysextUiStatus({
      supported,
      enabled: list.enabled,
      awaitingApproval: list.awaitingApproval,
      phase: request.phase,
      error: request.error,
      inApplications: inApplications(),
    });
    return { status, error: request.error };
  }

  function inApplications() {
    try {
      return app.isInApplicationsFolder();
    } catch {
      return false; // unpackaged builds cannot answer; unsupported anyway
    }
  }

  function notify() {
    const state = getState();
    const key = JSON.stringify(state);
    if (key === lastPushed) return;
    lastPushed = key;
    if (typeof onStateChange === "function") {
      try {
        onStateChange(state);
      } catch (err) {
        log.error("[sysext] onStateChange threw:", err);
      }
    }
  }

  function fireInstalled() {
    if (typeof onInstalled !== "function") return;
    try {
      onInstalled();
    } catch (err) {
      log.error("[sysext] onInstalled threw:", err);
    }
  }

  // Launch-time upgrade check (the OBS pattern): a capable build whose
  // embedded extension version is NEWER than the enabled one auto-requests a
  // replacement, once per run. Same-team replacement of an already-approved
  // extension does not re-prompt, and same versions never fire at all, so
  // this can run unconditionally after every list refresh and capability
  // probe (whichever settles last triggers it). Direction matters: an OLDER
  // embedded version (stale dist-signed build, an old app relaunched after
  // an upgrade) warns instead of silently downgrading the machine.
  function maybeAutoUpgrade() {
    if (disposed || upgradeRequested || !supported || request.phase !== "idle") return;
    if (!sysextNeedsUpgrade(embeddedVersion, list)) {
      if (
        !downgradeWarned &&
        list.enabled &&
        sysextVersionRelation(embeddedVersion, list.enabledVersion) === "older"
      ) {
        downgradeWarned = true;
        log.warn(
          `[sysext] embedded extension ${embeddedVersion} is OLDER than enabled ${list.enabledVersion}; not downgrading (is this a stale build?)`
        );
      }
      return;
    }
    upgradeRequested = true;
    log.log(
      `[sysext] embedded extension ${embeddedVersion} is newer than enabled ${list.enabledVersion}; requesting the upgrade`
    );
    install();
  }

  // Async, safe to fire-and-forget: parses systemextensionsctl list into the
  // machine-state half of the snapshot. A FAILED exec keeps the last-known
  // list (a transient spawn failure must not flip an installed camera to
  // "Install camera" in the tray); only real output updates it.
  function refresh() {
    return new Promise((resolve) => {
      execFile("systemextensionsctl", ["list"], { timeout: 5000 }, (err, stdout) => {
        if (!disposed) {
          if (err) {
            log.warn("[sysext] systemextensionsctl list failed; keeping last state:", err.message);
          } else {
            const wasEnabled = list.enabled;
            list = parseSystemExtensionsList(String(stdout || ""));
            // Enabled flipped on outside a live request (approval landing
            // from a previous session, manual install): the camera feed
            // deserves the same nudge a completed request gives it.
            if (!wasEnabled && list.enabled) fireInstalled();
            notify();
            maybeAutoUpgrade();
          }
        }
        resolve(getState());
      });
    });
  }

  // Build-capability probe: packaged macOS app + embedded extension + the
  // system-extension entitlement in the app's signature + a loadable addon.
  // codesign prints the entitlements of the OUTER bundle signature, which is
  // exactly what AMFI checks when the request is submitted. Along the way it
  // reads the embedded extension's version for the launch upgrade check.
  function detectSupport() {
    if (process.platform !== "darwin" || !app.isPackaged) return readyResolve();
    if (!fs.existsSync(embeddedExtensionPath())) {
      log.log("[sysext] no embedded camera extension in this build; install unavailable");
      return readyResolve();
    }
    if (!loadAddon()) return readyResolve();
    // Xcode writes the bundle plist binary; plutil normalizes either format.
    execFile(
      "plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(embeddedExtensionPath(), "Contents", "Info.plist"),
      ],
      { timeout: 5000 },
      (plistErr, plistOut) => {
        if (disposed) return readyResolve();
        if (!plistErr) {
          try {
            const info = JSON.parse(String(plistOut || "{}"));
            embeddedVersion = formatExtensionVersion(
              info.CFBundleShortVersionString,
              info.CFBundleVersion
            );
          } catch {
            embeddedVersion = null;
          }
        }
        if (!embeddedVersion) {
          // Not fatal: install still works, only the automatic upgrade check
          // stays off (it never fires on an unknown version by design).
          log.warn("[sysext] could not read the embedded extension version");
        }
        execFile(
          "codesign",
          ["-d", "--entitlements", "-", appBundlePath()],
          { timeout: 5000 },
          (err, stdout, stderr) => {
            if (disposed) return readyResolve();
            const report = `${stdout || ""}${stderr || ""}`;
            if (err || !report.includes("com.apple.developer.system-extension.install")) {
              log.log(
                "[sysext] app signature lacks the system-extension entitlement; install unavailable (see docs/virtual-camera.md for the signing contract)"
              );
              return readyResolve();
            }
            supported = true;
            notify();
            maybeAutoUpgrade();
            // From here approval can land out-of-band; keep the list fresh.
            pollTimer = setInterval(() => {
              if (!list.enabled) void refresh();
            }, LIST_POLL_MS);
            // Timers must never keep a quitting app alive.
            if (typeof pollTimer.unref === "function") pollTimer.unref();
            readyResolve();
          }
        );
      }
    );
  }

  // Fire the activation request. The already-enabled short-circuit is
  // VERSION-AWARE: an enabled extension matching this build's embedded
  // version has nothing to install, but a version mismatch (app upgraded
  // under an older running extension) must go through, which is what makes
  // the replacement path reachable in the product. Options exist for the
  // packaged smoke only: force bypasses the short-circuit outright (to
  // exercise the request path on a machine where versions match), and
  // onEvent taps the raw delegate events. Product callers pass nothing.
  function install({ force = false, onEvent } = {}) {
    const tap = (event) => {
      if (typeof onEvent === "function") {
        try {
          onEvent(event);
        } catch (err) {
          log.error("[sysext] onEvent tap threw:", err);
        }
      }
    };
    const nothingToInstall =
      list.enabled && !force && !sysextNeedsUpgrade(embeddedVersion, list);
    if (!supported || request.phase !== "idle" || nothingToInstall) {
      tap({ phase: "not-started", reason: getState().status });
      return getState();
    }
    if (!inApplications()) {
      // Preempt the guaranteed OSSystemExtensionErrorDomain code 3 with the
      // move offer; after the move the app relaunches from /Applications and
      // the next click can actually install.
      tap({ phase: "not-started", reason: "needs-move" });
      if (typeof offerMove === "function") offerMove();
      return getState();
    }
    const native = loadAddon();
    if (!native) {
      tap({ phase: "not-started", reason: "addon-missing" });
      return getState();
    }
    const started = native.requestActivation(SYSEXT_BUNDLE_ID, (event) => {
      if (disposed) return;
      tap(event);
      request = reduceRequestEvent(request, event);
      if (event.phase === "replacing") {
        log.log(
          `[sysext] replacing embedded extension ${event.existingVersion} -> ${event.newVersion}`
        );
        return; // informational; no state transition to push
      }
      if (event.phase === "completed") {
        log.log(`[sysext] activation completed (${event.result})`);
        void refresh();
        // Direct cue too (refresh's enabled-transition detection cannot see
        // an upgrade, where enabled was already true throughout); the camera
        // feed's start() is idempotent, so overlapping cues are harmless.
        fireInstalled();
      } else if (event.phase === "failed") {
        log.warn(`[sysext] activation failed: ${event.message} (code ${event.code})`);
      } else if (event.phase === "needsApproval") {
        log.log("[sysext] activation needs the System Settings approval");
      }
      notify();
    });
    if (started) {
      request = { phase: "requesting", completed: false, error: null };
      log.log(`[sysext] submitted activation request for ${SYSEXT_BUNDLE_ID}`);
      notify();
    } else {
      tap({ phase: "not-started", reason: "request-in-flight" });
    }
    return getState();
  }

  function dispose() {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  detectSupport();
  void refresh();

  return { getState, install, refresh, dispose, ready };
}

module.exports = { createSysext };
