// Builds the mac RELEASE artifact (npm run dist:mac): a drag-to-Applications
// DMG around the app that pack:mac just built and verified, then (when notary
// credentials exist in the environment) notarization + stapling via
// scripts/notarize-mac.mjs. This is deliberately a SEPARATE script from
// pack:mac so the fast dev loop stays directory-only; nothing here changes
// what pack:mac produces.
//
// Steps:
//
//   1. scripts/pack-mac.mjs        the full existing pipeline, including every
//                                  signing assertion (see that file's header).
//   2. electron-builder --prepackaged <the packed .app> --mac dmg
//                                  packages the ALREADY-BUILT app into a DMG.
//                                  --prepackaged makes doPack a no-op: no
//                                  rebuild, no afterPack, no app signing, the
//                                  bundle the assertions blessed goes into the
//                                  image byte-for-byte. dmg.sign stays false
//                                  (electron-builder.yml): a signed container
//                                  adds nothing (notarization tickets ride the
//                                  app signature and the stapled DMG) and
//                                  re-signing here is exactly what this script
//                                  must never do.
//   3. DMG verification            mount read-only, assert the layout (app +
//                                  /Applications symlink), assert the embedded
//                                  app is THE SAME build (CDHash equality with
//                                  the dist-app original), and, when signing
//                                  was requested, codesign --verify --deep
//                                  --strict on the embedded app. Unmount.
//   4. scripts/notarize-mac.mjs    gated on CAPTURIA_NOTARY_PROFILE; prints a
//                                  clear skip line without it. Standalone too:
//                                  when credentials arrive after a build, run
//                                  node scripts/notarize-mac.mjs directly.
//
// Why electron-builder's dmg target and not create-dmg: it is already a dep,
// it reuses the same appId/productName/icon the app was packed with (volume
// name and icon stay consistent by construction), its default layout is the
// standard drag-to-Applications window, and --prepackaged gives the exact
// build-once guarantee this script exists to enforce. create-dmg would add a
// dependency to do strictly less.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = join(root, "dist-app", "mac-arm64", "Capturia.app");

function fail(message) {
  console.error(`[dist-mac] FAIL: ${message}`);
  process.exit(1);
}

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

// codesign -dvvv reports on stderr; the CDHash line identifies a build
// exactly (same seal, same content), signed or ad-hoc alike.
function cdhash(bundle) {
  const detail = spawnSync("codesign", ["-dvvv", bundle], { encoding: "utf8" });
  if (detail.status !== 0) fail(`codesign could not read ${bundle}`);
  const hash = /CDHash=([0-9a-f]+)/.exec(`${detail.stderr || ""}${detail.stdout || ""}`)?.[1];
  if (!hash) fail(`no CDHash reported for ${bundle}`);
  return hash;
}

// 1. The existing pack pipeline, assertions included. Signing (or the
// explicit ad-hoc fallback) is decided there from the environment.
run(process.execPath, [join(root, "scripts", "pack-mac.mjs")]);
const signingRequested = Boolean(process.env.CSC_NAME || process.env.CSC_LINK);

// 2. The DMG, from the prepackaged app. Stale images go first so the
// verification below cannot pick up a previous run's artifact.
const distDir = join(root, "dist-app");
for (const name of readdirSync(distDir)) {
  if (name.endsWith(".dmg") || name.endsWith(".dmg.blockmap")) {
    rmSync(join(distDir, name), { force: true });
  }
}
// Identity auto-discovery off for the DMG step: the app is already signed (or
// deliberately ad-hoc) and nothing in this step may touch a keychain.
run(
  join(root, "node_modules", ".bin", "electron-builder"),
  ["--prepackaged", appPath, "--mac", "dmg", "--arm64"],
  { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
);

const dmgName = readdirSync(distDir).find((name) => name.endsWith(".dmg"));
if (!dmgName) fail("electron-builder reported success but dist-app contains no .dmg");
const dmgPath = join(distDir, dmgName);

// 3. Verify the image actually delivers what a user drags out of it.
const mountPoint = mkdtempSync(join(tmpdir(), "capturia-dmg-"));
const attach = spawnSync(
  "hdiutil",
  ["attach", dmgPath, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint],
  { encoding: "utf8" }
);
if (attach.status !== 0) fail(`hdiutil attach failed:\n${attach.stderr}`);
try {
  const mountedApp = join(mountPoint, "Capturia.app");
  if (!existsSync(mountedApp)) fail("mounted DMG has no Capturia.app");
  const applicationsLink = join(mountPoint, "Applications");
  let linkTarget;
  try {
    if (!lstatSync(applicationsLink).isSymbolicLink()) fail("mounted DMG's Applications entry is not a symlink");
    linkTarget = readlinkSync(applicationsLink);
  } catch {
    fail("mounted DMG has no Applications symlink (drag-to-Applications layout missing)");
  }
  if (linkTarget !== "/Applications") fail(`Applications symlink points at ${linkTarget}, not /Applications`);

  // The build-once guarantee, asserted: the app in the image IS the app the
  // pack assertions verified, not a rebuild or a re-sign.
  const packed = cdhash(appPath);
  const shipped = cdhash(mountedApp);
  if (packed !== shipped) {
    fail(`the app inside the DMG (CDHash=${shipped}) is not the packed app (CDHash=${packed})`);
  }

  if (signingRequested) {
    // Deep-verify the embedded copy itself: a signature that survived the
    // trip into the image and back out of a read-only mount.
    const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", mountedApp], {
      encoding: "utf8",
    });
    if (verify.status !== 0) {
      fail(`codesign --verify --deep --strict failed on the app inside the DMG:\n${verify.stderr}`);
    }
    console.log("[dist-mac] embedded app signature verified (deep, strict)");
  } else {
    // The explicit ad-hoc fallback has no resource seal to deep-verify; the
    // CDHash equality above is the whole integrity story for that flavor.
    console.log("[dist-mac] ad-hoc pack: layout + CDHash verified, no signature to deep-verify");
  }
  console.log(`[dist-mac] DMG verified: ${dmgName} (app + Applications symlink)`);
} finally {
  const detach = spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
  if (detach.status !== 0) {
    // One retry after a beat; Spotlight sometimes holds fresh mounts briefly.
    spawnSync("sleep", ["2"]);
    const again = spawnSync("hdiutil", ["detach", mountPoint, "-force"], { encoding: "utf8" });
    if (again.status !== 0) console.error(`[dist-mac] WARN: could not detach ${mountPoint}`);
  }
}

// 4. Notarization + stapling, or its clear skip line (see that script).
run(process.execPath, [join(root, "scripts", "notarize-mac.mjs")]);
