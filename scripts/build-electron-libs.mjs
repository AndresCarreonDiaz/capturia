// Compiles the framework-free lib/ modules that Electron main needs (shared
// model/key routing, the desktop runtime decisions, the system prompt) to
// CommonJS in electron/gen/. Main is CJS and cannot load the app's TypeScript
// directly, and duplicating the logic in JS would let web and desktop drift.
// Runs via the preelectron hook and as the first step of build:electron.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "lib/server-keys.ts",
  "lib/system-prompt.ts",
  "lib/desktop-runtime.ts",
  "lib/tray-menu.ts",
  "lib/speech-events.ts",
];
const outDir = join(root, "electron", "gen");

rmSync(outDir, { recursive: true, force: true });
// Explicit file list => tsc ignores tsconfig.json, so the flags below are the
// whole config. lib includes dom for the URL global used by desktop-runtime.
execFileSync(
  join(root, "node_modules", ".bin", "tsc"),
  [
    ...files,
    "--module", "commonjs",
    "--target", "es2022",
    "--lib", "es2022,dom",
    "--moduleResolution", "node",
    "--outDir", outDir,
    "--skipLibCheck",
    "--noEmitOnError",
  ],
  { cwd: root, stdio: "inherit" }
);
console.log(`[build-electron-libs] compiled ${files.length} modules -> electron/gen/`);
