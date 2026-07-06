// Produces everything the Electron shell loads: the compiled main-process libs
// (electron/gen/) and the static export of the web app (out/studio.html, the
// path electron/main.js expects).
//
// Next's output:"export" hard-errors on any server-only surface, and the
// desktop bundle must not ship one anyway: app/api/* (POST/SSE route handlers)
// is replaced by the runtime hosted in Electron main, and app/vote/* (dynamic
// room route) lives on the hosted web deployment that phones reach via the QR
// origin (NEXT_PUBLIC_CAPTURIA_ORIGIN). There is no config switch to exclude
// routes from a build, so this script relocates those directories aside for
// the duration of the build and restores them afterwards, even on Ctrl-C.
// Do not run it while `next dev` is serving this checkout.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOLD = join(root, ".electron-export-hold");
const EXCLUDED = [
  ["app/api", "app-api"],
  ["app/vote", "app-vote"],
];

// Refuse to run under a live dev server: this build renames app/api and
// app/vote out of the source tree and rewrites .next/, which 404s live
// sessions and can corrupt the dev server's compile state.
const devPort = process.env.PORT ?? "3000";
try {
  await fetch(`http://localhost:${devPort}/`, { signal: AbortSignal.timeout(750) });
  console.error(
    `[build-electron-export] something is answering on http://localhost:${devPort} ` +
      "(next dev / electron-dev?). Stop it first, or set PORT if that is not a dev server."
  );
  process.exit(1);
} catch {
  // nothing listening: safe to proceed
}

if (existsSync(HOLD)) {
  console.error(
    `[build-electron-export] ${HOLD} already exists; a previous build died mid-restore. ` +
      "Move its contents back under app/ (app-api -> app/api, app-vote -> app/vote), " +
      "delete the directory, then re-run."
  );
  process.exit(1);
}

const moved = [];
function restore() {
  while (moved.length) {
    const [src, dest] = moved.pop();
    renameSync(dest, src);
  }
  rmSync(HOLD, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});

function run(cmd, args, extraEnv = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  return result.status ?? 1;
}

let status = run(process.execPath, [join(root, "scripts", "build-electron-libs.mjs")]);
if (status !== 0) process.exit(status);
// prebuild only fires for `npm run build`, so vendor the pdf worker here too.
status = run(process.execPath, [join(root, "scripts", "copy-pdf-worker.mjs")]);
if (status !== 0) process.exit(status);

mkdirSync(HOLD, { recursive: true });
try {
  for (const [rel, holdName] of EXCLUDED) {
    const src = join(root, ...rel.split("/"));
    if (!existsSync(src)) continue;
    const dest = join(HOLD, holdName);
    renameSync(src, dest);
    moved.push([src, dest]);
  }
  status = run(join(root, "node_modules", ".bin", "next"), ["build"], {
    CAPTURIA_ELECTRON_BUILD: "1",
  });
} finally {
  restore();
}

if (status === 0 && !existsSync(join(root, "out", "studio.html"))) {
  console.error(
    "[build-electron-export] build succeeded but out/studio.html is missing; " +
      "electron/main.js loads exactly that file (trailingSlash must stay unset)."
  );
  status = 1;
}

// The export build also writes its internals into .next/, which would leave a
// stale electron-flavored production build that `next start` happily serves.
// Remove the serve markers (keeping the cache) so `next start` fails loudly
// with "no production build" until the next `npm run build`.
if (status === 0) {
  for (const marker of ["BUILD_ID", "required-server-files.json"]) {
    rmSync(join(root, ".next", marker), { force: true });
  }
}
process.exit(status);
