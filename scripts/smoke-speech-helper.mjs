// Protocol smoke for the capturia-speech helper: builds a TTS utterance,
// runs the helper in file mode (no mic permission), and asserts the NDJSON
// contract end to end: ready -> interim(s) -> final containing the expected
// words -> done, all parseable. Exits 0 on pass.
//
//   node scripts/smoke-speech-helper.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "native", "capturia-speech", "capturia-speech");
const source = join(root, "native", "capturia-speech", "main.swift");

if (platform() !== "darwin" || Number(release().split(".")[0]) < 25) {
  console.log("[smoke:speech] SpeechAnalyzer needs macOS 26+; skipping");
  process.exit(0);
}
// The binary is never committed; the build script is freshness-checked and
// cheap when the helper is already current, so always call it.
execFileSync(process.execPath, [join(root, "scripts", "build-speech-helper.mjs")], {
  stdio: "inherit",
});
if (!existsSync(helper)) {
  console.log("[smoke:speech] helper unavailable on this machine (no Swift toolchain); skipping");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "capturia-speech-smoke-"));
const aiff = join(dir, "utterance.aiff");
const wav = join(dir, "utterance.wav");
execFileSync("say", ["show a metrics panel with revenue at two million", "-o", aiff]);
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);

// Generous: a first run on a fresh machine downloads the speech model inside
// this window (the helper emits downloading-model while it does).
const run = spawnSync(helper, ["--file", wav], { encoding: "utf8", timeout: 300000 });
const events = run.stdout
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: "UNPARSEABLE", line };
    }
  });

const types = events.map((e) => e.type);
const finals = events.filter((e) => e.type === "final").map((e) => e.text);
const finalText = finals.join(" ").toLowerCase();

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failures += 1;
}

// A timeout kill now exits 0 in mic mode and 1-with-error in file mode, so
// assert the run was not killed at all, not just the exit code.
check(
  "helper ran to completion (no timeout or kill)",
  run.signal === null && !run.error,
  `signal=${run.signal} error=${run.error ?? ""}`
);
check("helper exits 0", run.status === 0, `status=${run.status}`);
check("no unparseable lines", !types.includes("UNPARSEABLE"));
check("ready arrives", types.includes("ready"));
check("interims stream", types.includes("interim"));
check("a final arrives", finals.length > 0);
check(
  "final contains the spoken command",
  finalText.includes("metrics panel") && /2\s?million|two million/.test(finalText),
  finalText
);
check("done closes the stream", types[types.length - 1] === "done");

if (failures > 0 && types.includes("downloading-model")) {
  console.log(
    "[smoke:speech] note: a first-run speech model download happened inside the timeout window; if the failure above is a timeout or truncation, re-run now that the model is cached."
  );
}
console.log(failures === 0 ? "[smoke:speech] PASS" : `[smoke:speech] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
