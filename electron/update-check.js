// Minimum-viable update check (issue #50): ask GitHub which release is
// latest, compare it against the running version (decision logic in
// lib/update-check.ts, compiled to electron/gen), and point the user at the
// download page when it is newer. Deliberately no updater dependency and no
// release-pipeline change: Download opens the browser and the new DMG
// installs over this one. Two entry points, two postures:
//   - Launch check: once per launch, delayed past startup, and main gates it
//     to packaged builds outside smoke. Nobody asked, so failures (offline,
//     rate-limited, GitHub down) stay in the console and being current shows
//     nothing at all.
//   - Tray check (Check for Updates): the user asked, so it always answers
//     with a dialog: the update offer, "You are up to date", or the failure,
//     honestly.

const { app, dialog, shell } = require("electron");

const FETCH_TIMEOUT_MS = 10000;
// Long enough that the window, tray, and runtime are settled before any
// update dialog can land on top of them; short enough to catch the session.
const LAUNCH_CHECK_DELAY_MS = 15000;

// getParentWindow() names the window dialogs parent on while it is visible;
// a sheet attached to a window hidden to the tray never reaches the screen,
// so those dialogs stand alone instead (same rule as main's failure
// dialogs). Throws when electron/gen is missing, like tray.js: main catches
// and degrades to a shell that simply never checks.
function createUpdateCheck({ getParentWindow }) {
  const { decideUpdate, UPDATE_DOWNLOAD_URL, UPDATE_FEED_URL } = require("./gen/update-check");

  function showDialog(options) {
    const win = getParentWindow ? getParentWindow() : null;
    return win && !win.isDestroyed() && win.isVisible()
      ? dialog.showMessageBox(win, options)
      : dialog.showMessageBox(options);
  }

  async function fetchDecision() {
    const res = await fetch(UPDATE_FEED_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return decideUpdate(app.getVersion(), await res.json());
  }

  async function offerDownload(latestVersion) {
    const { response } = await showDialog({
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Capturia ${latestVersion} is available`,
      detail:
        `You are running ${app.getVersion()}. Download opens capturia.dev ` +
        "in your browser; installing the new version replaces this one.",
    });
    // The target is a pinned https constant (lib/update-check.ts); nothing
    // user- or server-controlled ever reaches openExternal here.
    if (response === 0) await shell.openExternal(UPDATE_DOWNLOAD_URL);
  }

  // Scheduled at most once, so a launch gets at most one automatic
  // notification no matter how the caller wires it.
  let launchCheckScheduled = false;
  function scheduleLaunchCheck() {
    if (launchCheckScheduled) return;
    launchCheckScheduled = true;
    const timer = setTimeout(() => {
      fetchDecision()
        .then(({ newer, latestVersion }) => {
          if (newer) return offerDownload(latestVersion);
        })
        .catch((err) => {
          console.warn("Capturia: launch update check skipped:", err);
        });
    }, LAUNCH_CHECK_DELAY_MS);
    // A pending check must never hold the process open past a quit.
    timer.unref?.();
  }

  // One manual check at a time: a second tray click while the first dialog
  // waits must not stack another fetch and another dialog on top of it.
  let manualCheckRunning = false;
  async function checkNow() {
    if (manualCheckRunning) return;
    manualCheckRunning = true;
    try {
      const { newer, latestVersion } = await fetchDecision();
      if (newer) {
        await offerDownload(latestVersion);
      } else if (latestVersion) {
        await showDialog({
          type: "info",
          buttons: ["OK"],
          message: "You are up to date",
          detail: `Capturia ${app.getVersion()} is the latest version.`,
        });
      } else {
        // GitHub answered but the tag is not a readable version; for the
        // person who clicked, that is a failed check, not "up to date".
        throw new Error("The latest release does not name a version.");
      }
    } catch (err) {
      console.warn("Capturia: update check failed:", err);
      await showDialog({
        type: "warning",
        buttons: ["OK"],
        message: "Could not check for updates",
        detail:
          `${(err && err.message) || String(err)}\n\n` +
          "The latest release is always at capturia.dev/download.",
      });
    } finally {
      manualCheckRunning = false;
    }
  }

  return { scheduleLaunchCheck, checkNow };
}

module.exports = { createUpdateCheck };
