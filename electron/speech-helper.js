// Lifecycle owner for the capturia-speech helper (native on-device streaming
// transcription, macOS 26+). One mic session at a time: main spawns the
// helper, parses its NDJSON stdout, and forwards events to the renderer.
// The helper exits on SIGTERM or when its stdin closes, so a dead Electron
// never leaves an orphaned mic capture.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const { parseSpeechEvent, createLineSplitter } = require("./gen/speech-events");

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "capturia-speech")
    : path.join(__dirname, "..", "native", "capturia-speech", "capturia-speech");
}

// Darwin 25 == macOS 26, the first release with SpeechAnalyzer.
function isAppleSpeechAvailable() {
  if (process.platform !== "darwin") return false;
  const darwinMajor = Number(os.release().split(".")[0]);
  if (!Number.isFinite(darwinMajor) || darwinMajor < 25) return false;
  try {
    fs.accessSync(helperPath(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let current = null;
let sessionCounter = 0;

// SIGTERM first, SIGKILL if the helper has not exited after a grace period:
// a wedged helper must never hold the mic forever. Scoped to the child, not
// `current`, so a superseded session's helper still gets the escalation
// after tracking moves on to the new session.
function killWithEscalation(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    return; /* already gone */
  }
  const hardKill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 4000);
  hardKill.unref();
  child.once("close", () => clearTimeout(hardKill));
}

// Start the one mic session. onEvent receives every parsed helper event plus
// a synthesized {type:"error"} on spawn failure and {type:"done"} when the
// process ends. Returns the session id; stopSpeechSession(id) ends it.
function startSpeechSession({ locale, onEvent }) {
  stopSpeechSession(current?.id ?? -1);
  const id = ++sessionCounter;

  let child;
  try {
    child = spawn(helperPath(), ["--mic", "--locale", locale || "en_US"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch (err) {
    onEvent({ type: "error", message: `helper spawn failed: ${err.message}` });
    return id;
  }
  current = { id, child, onEvent };

  const feed = createLineSplitter((line) => {
    if (current?.id !== id) return;
    const event = parseSpeechEvent(line);
    if (event) onEvent(event);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", feed);
  child.on("error", (err) => {
    if (current?.id !== id) return;
    onEvent({ type: "error", message: `helper: ${err.message}` });
    current = null;
  });
  // "close" and not "exit": close waits for stdout to drain, so the trailing
  // finals the helper flushes while dying reach the splitter before "done".
  child.on("close", (code, signal) => {
    if (current?.id !== id) return;
    const requested = current.stopRequested;
    current = null;
    // Non-zero without a prior error event still needs to surface, but a
    // death the user asked for is not an error (a stop that lands before
    // the helper installs its signal handlers kills it with code null).
    if (code !== 0 && !requested) {
      onEvent({ type: "error", message: `helper exited ${signal ?? code}` });
    }
    onEvent({ type: "done" });
  });
  return id;
}

function stopSpeechSession(id) {
  if (!current || current.id !== id) return;
  // Keep the pipe until close: trailing finals after SIGTERM still flow (the
  // helper finalizes before exiting).
  current.stopRequested = true;
  killWithEscalation(current.child);
}

function stopAllSpeechSessions() {
  if (current) {
    current.stopRequested = true;
    killWithEscalation(current.child);
    current = null;
  }
}

module.exports = {
  isAppleSpeechAvailable,
  startSpeechSession,
  stopSpeechSession,
  stopAllSpeechSessions,
};
