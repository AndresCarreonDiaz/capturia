// Append-only local crash log for the desktop shell (issue #51): the only
// crash visibility Capturia has, by design (no third-party crash service
// without consent). Record shape and the size cap live in lib/crash-log.ts
// (compiled to electron/gen); this module only does the I/O: resolve the file
// under app.getPath("logs") (macOS: ~/Library/Logs/Capturia), trim when
// oversized, append one line. Same degrade posture as the other gen
// consumers: every caller is already on a failure path, so logging must never
// become a second crash; without the gen build entries reach the console only.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

let gen = null;
try {
  gen = require("./gen/crash-log");
} catch {
  // electron/gen not built (bare `npx electron .`); console-only below.
}

function crashLogPath() {
  try {
    return path.join(app.getPath("logs"), "crash.log");
  } catch {
    return null;
  }
}

// Fire-and-forget. The console line comes first so the failure is visible
// even when the file write itself fails.
function logCrash({ source, reason, detail }) {
  console.error(`Capturia ${source} failure: ${reason}${detail ? ` (${detail})` : ""}`);
  const file = crashLogPath();
  if (!gen || !file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // stat measures bytes against a character cap; bytes only over-count, so
    // the trim errs early, the safe direction for a cap.
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // No file yet: the append below creates it.
    }
    if (size > gen.CRASH_LOG_MAX_CHARS) {
      fs.writeFileSync(file, gen.truncateCrashLog(fs.readFileSync(file, "utf8")));
    }
    fs.appendFileSync(
      file,
      gen.formatCrashRecord({ source, reason, detail, appVersion: app.getVersion(), at: Date.now() })
    );
  } catch (err) {
    console.error("Capturia: could not write the crash log:", err);
  }
}

module.exports = { logCrash, crashLogPath };
