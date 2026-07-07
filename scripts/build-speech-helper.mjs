// Builds the capturia-speech helper (native on-device streaming speech,
// macOS 26+) with swiftc. Skips politely on non-macOS or when the toolchain
// or SDK is too old: the app degrades to the chunked-whisper engine, so a
// missing helper is a capability loss, not a build failure. Runs from
// pack:mac and can be run standalone.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
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
// The binary is never committed (arch-specific); every consumer (preelectron,
// pack:mac, smoke:speech) calls this script, and this check makes that cheap.
if (existsSync(out) && statSync(out).mtimeMs > statSync(source).mtimeMs) {
  console.log("[build-speech-helper] up to date");
  process.exit(0);
}
try {
  execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
} catch {
  // No toolchain at all is a capability loss by design (whisper remains);
  // a toolchain that FAILS to compile is a build error and falls through
  // to the loud exit below.
  console.log("[build-speech-helper] swiftc not found; skipping (whisper engine remains)");
  process.exit(0);
}
// --strict (pack:mac): a compile failure must fail the build rather than
// silently package without the streaming engine. Default (preelectron, dev):
// warn loudly but keep the shell bootable; an SDK without SpeechAnalyzer
// (swiftc present, macOS 26 host, old Xcode) must not brick electron-dev.
const strict = process.argv.includes("--strict");
try {
  execFileSync("swiftc", ["-O", source, "-o", out], { stdio: "inherit" });
  console.log(`[build-speech-helper] built ${out}`);
} catch {
  if (strict) {
    console.error(
      "[build-speech-helper] swiftc FAILED: main.swift does not compile. Refusing to package silently without the streaming engine; fix the source (or the SDK) and re-run."
    );
    process.exit(1);
  }
  console.warn(
    "[build-speech-helper] WARNING: swiftc failed; continuing without the streaming engine (whisper fallback). pack:mac runs this with --strict and would stop here."
  );
}
