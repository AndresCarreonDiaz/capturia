// Builds the capturia-sysext N-API addon (native/capturia-sysext), the
// OSSystemExtensionRequest bridge that lets the packaged app activate its own
// embedded camera extension. Same contract as build-frames-addon.mjs: skips
// politely on non-macOS, reuses a fresh build, and runs from pack:mac with
// --strict (a packaged app that cannot offer the camera install would ship
// the M8 gap this addon exists to close). Pure N-API, so one build serves
// both the system Node and Electron.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "native", "capturia-sysext");
const built = join(dir, "build", "Release", "capturia_sysext.node");
const sources = [join(dir, "src", "addon.mm"), join(dir, "binding.gyp")];

if (platform() !== "darwin") {
  console.log("[build-sysext-addon] non-macOS host; skipping (no system extensions)");
  process.exit(0);
}

const strict = process.argv.includes("--strict");

const fresh =
  existsSync(built) && sources.every((s) => statSync(built).mtimeMs > statSync(s).mtimeMs);
if (fresh) {
  console.log("[build-sysext-addon] up to date");
  process.exit(0);
}

try {
  execFileSync(join(root, "node_modules", ".bin", "node-gyp"), ["rebuild"], {
    cwd: dir,
    stdio: "inherit",
  });
  console.log(`[build-sysext-addon] built ${built}`);
} catch {
  if (strict) {
    console.error(
      "[build-sysext-addon] node-gyp FAILED. Refusing to package without the extension activator; fix the toolchain (Xcode command line tools) and re-run."
    );
    process.exit(1);
  }
  console.warn(
    "[build-sysext-addon] WARNING: node-gyp failed; continuing without in-app extension activation. pack:mac runs this with --strict and would stop here."
  );
}
