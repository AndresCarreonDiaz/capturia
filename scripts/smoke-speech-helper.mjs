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

if (platform() !== "darwin" || Number(release().split(".")[0]) < 25) {
  console.log("[smoke:speech] SpeechAnalyzer needs macOS 26+; skipping");
  process.exit(0);
}
if (!existsSync(helper)) {
  console.error("[smoke:speech] helper not built; run node scripts/build-speech-helper.mjs");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "capturia-speech-smoke-"));
const aiff = join(dir, "utterance.aiff");
const wav = join(dir, "utterance.wav");
execFileSync("say", ["show a metrics panel with revenue at two million", "-o", aiff]);
execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);

const run = spawnSync(helper, ["--file", wav], { encoding: "utf8", timeout: 120000 });
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

console.log(failures === 0 ? "[smoke:speech] PASS" : `[smoke:speech] ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
