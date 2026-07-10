// Builds the capturia-frames N-API addon (native/capturia-frames), the bridge
// that copies offscreen paints into the CMIO camera sink. Skips politely on
// non-macOS (the addon IS the macOS virtual-camera path) and reuses a fresh
// build. Runs from pack:mac with --strict (a packaged app without the addon
// has no native camera, so a build failure must stop the pack) and can be run
// standalone. The addon is pure N-API, so one build serves both the system
// Node and Electron; no electron-rebuild pass needed.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "native", "capturia-frames");
const built = join(dir, "build", "Release", "capturia_frames.node");
const sources = [join(dir, "src", "addon.cc"), join(dir, "binding.gyp")];

if (platform() !== "darwin") {
  console.log("[build-frames-addon] non-macOS host; skipping (no native camera)");
  process.exit(0);
}

const strict = process.argv.includes("--strict");

// The binary is never committed (native/*/build/ is ignored); this freshness
// check keeps repeated pack/dev runs cheap.
const fresh =
  existsSync(built) && sources.every((s) => statSync(built).mtimeMs > statSync(s).mtimeMs);
if (fresh) {
  console.log("[build-frames-addon] up to date");
  process.exit(0);
}

try {
  execFileSync(join(root, "node_modules", ".bin", "node-gyp"), ["rebuild"], {
    cwd: dir,
    stdio: "inherit",
  });
  console.log(`[build-frames-addon] built ${built}`);
} catch {
  if (strict) {
    console.error(
      "[build-frames-addon] node-gyp FAILED. Refusing to package without the native camera; fix the toolchain (Xcode command line tools) and re-run."
    );
    process.exit(1);
  }
  console.warn(
    "[build-frames-addon] WARNING: node-gyp failed; continuing without the native camera. pack:mac runs this with --strict and would stop here."
  );
}
