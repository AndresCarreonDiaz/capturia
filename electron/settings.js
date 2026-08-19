// Simple settings store in userData: read-modify-write of a small JSON
// object, resilient to a missing or corrupt file. Holds { voiceLocale,
// cameraDevice }. Writes go through a temp file + rename so a crash
// mid-write can never truncate the file and lose a persisted preference.
// One shared read-modify-write path for every main-process consumer, so two
// writers never race against the same file.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// Keys the removed telemetry beacon left behind in older installs. Dropped on
// the next write so the old install identifier does not live on disk forever.
const DEAD_KEYS = ["telemetry", "installId", "cameraInstalledReported"];

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
    const next = { ...readSettings(), ...patch };
    for (const key of DEAD_KEYS) delete next[key];
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn("Capturia: could not persist settings:", err);
  }
}

module.exports = { readSettings, writeSettings };
