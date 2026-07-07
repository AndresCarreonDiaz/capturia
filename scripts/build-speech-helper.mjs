// Builds the capturia-speech helper (native on-device streaming speech,
// macOS 26+) with swiftc. Skips politely on non-macOS or when the toolchain
// or SDK is too old: the app degrades to the chunked-whisper engine, so a
// missing helper is a capability loss, not a build failure. Runs from
// pack:mac and can be run standalone.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform, release } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "native", "capturia-speech");
const source = join(dir, "main.swift");
const out = join(dir, "capturia-speech");

if (platform() !== "darwin") {
  console.log("[build-speech-helper] non-macOS host; skipping (whisper engine remains)");
  process.exit(0);
}
if (Number(release().split(".")[0]) < 25) {
  console.log("[build-speech-helper] macOS < 26; SpeechAnalyzer unavailable, skipping");
  process.exit(0);
}
if (!existsSync(source)) {
  console.error("[build-speech-helper] main.swift missing");
  process.exit(1);
}
try {
  execFileSync("swiftc", ["-O", source, "-o", out], { stdio: "inherit" });
  console.log(`[build-speech-helper] built ${out}`);
} catch {
  console.warn(
    "[build-speech-helper] WARNING: swiftc failed; packaging continues without the streaming engine (whisper fallback)."
  );
}
