// Shared helpers for the release scripts (dist-mac.mjs, notarize-mac.mjs).
// Everything here THROWS on failure instead of exiting: process.exit skips
// finally blocks, and the one invariant this module exists to hold is that a
// mounted image always gets detached, even when an assertion inside the mount
// fails (a leaked mount is worse than a failed build: the next run's
// stale-artifact sweep would rmSync the file backing a live mount).

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// codesign -dvvv reports on stderr; the CDHash line identifies a build
// exactly (same seal, same content), signed or ad-hoc alike.
export function cdhash(bundle) {
  const detail = spawnSync("codesign", ["-dvvv", bundle], { encoding: "utf8" });
  if (detail.status !== 0) throw new Error(`codesign could not read ${bundle}`);
  const hash = /CDHash=([0-9a-f]+)/.exec(`${detail.stderr || ""}${detail.stdout || ""}`)?.[1];
  if (!hash) throw new Error(`no CDHash reported for ${bundle}`);
  return hash;
}

// Attaches the image read-only at a fresh mountpoint, runs fn(mountPoint),
// and ALWAYS detaches in a finally. fn must throw (never process.exit) so the
// finally can run; the caller catches and decides the exit code.
export async function withMountedDmg(dmgPath, fn) {
  const mountPoint = mkdtempSync(join(tmpdir(), "capturia-dmg-"));
  const attach = spawnSync(
    "hdiutil",
    ["attach", dmgPath, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint],
    { encoding: "utf8" }
  );
  if (attach.status !== 0) throw new Error(`hdiutil attach failed:\n${attach.stderr}`);
  try {
    return await fn(mountPoint);
  } finally {
    const detach = spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
    if (detach.status !== 0) {
      // One retry after a beat; Spotlight sometimes holds fresh mounts briefly.
      spawnSync("sleep", ["2"]);
      const again = spawnSync("hdiutil", ["detach", mountPoint, "-force"], { encoding: "utf8" });
      if (again.status !== 0) console.error(`[dmg-util] WARN: could not detach ${mountPoint}`);
    }
  }
}
