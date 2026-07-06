// First-launch housekeeping for the packaged app: offer the move to
// /Applications exactly once (the Camo/Krisp pattern). Running from
// Downloads or a DMG breaks permission persistence (macOS ties camera/mic
// TCC grants and, later, the extension approval to the app path), so the
// nudge is worth one dialog, and only one: the answer is recorded in
// userData before the dialog resolves, so neither a decline nor a crash
// ever re-nags.

const { app, dialog } = require("electron");
const fs = require("fs");
const path = require("path");

function flagPath() {
  return path.join(app.getPath("userData"), "first-run.json");
}

function readFlags() {
  try {
    return JSON.parse(fs.readFileSync(flagPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeFlags(patch) {
  try {
    fs.mkdirSync(path.dirname(flagPath()), { recursive: true });
    fs.writeFileSync(flagPath(), JSON.stringify({ ...readFlags(), ...patch }));
  } catch (err) {
    console.warn("Capturia: could not persist first-run flags:", err);
  }
}

// Call at the END of whenReady, once the window and tray exist: the dialog
// then floats over a working app instead of being the only UI. No-ops
// everywhere except a packaged, non-smoke, macOS launch from outside
// /Applications that has not been asked before. On acceptance,
// moveToApplicationsFolder quits and relaunches from the new location.
async function maybeOfferMoveToApplications({ isSmoke, parentWindow }) {
  if (!app.isPackaged || isSmoke) return;
  if (process.platform !== "darwin") return;
  if (app.isInApplicationsFolder()) return;
  if (readFlags().moveOffered) return;
  writeFlags({ moveOffered: true });

  const options = {
    type: "question",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
    message: "Move Capturia to your Applications folder?",
    detail:
      "Capturia works best from Applications: macOS remembers its camera and microphone permissions there, and updates stay tidy.",
  };
  const { response } = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);
  if (response !== 0) return;

  try {
    // Replace a stale copy in /Applications, but never one that is running.
    app.moveToApplicationsFolder({
      conflictHandler: (conflict) => conflict === "exists",
    });
  } catch (err) {
    console.error("Capturia: move to /Applications failed:", err);
  }
}

module.exports = { maybeOfferMoveToApplications };
