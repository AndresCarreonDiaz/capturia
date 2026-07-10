// electron-builder afterPack hook. Runs after the app directory is assembled
// and BEFORE electron-builder signs it, so everything placed here ends up
// inside the signed seal. Four jobs:
//
// 1. Copy the staged self-contained nodejs-whisper into Contents/Resources.
//    This cannot ride extraResources: electron-builder's default file-set
//    excludes silently strip node_modules directories from the copy, and the
//    staged package NEEDS its nested node_modules to resolve shelljs & co.
// 2. Copy the capturia-speech helper binary (optional: a build without it
//    degrades to the whisper engine; pack:mac builds it with --strict first).
// 3. Copy the capturia-frames N-API addon the native camera requires. A .node
//    cannot load from inside the asar, so it ships as a real file in
//    Contents/Resources and electron/camera-feed.js requires it from
//    process.resourcesPath when packaged. Required: a packaged app without
//    the native camera is the bug this hook exists to prevent.
// 4. Embed the CMIO camera extension at Contents/Library/SystemExtensions.
//    The extension bundle comes out of native/CapturiaCamera/build-signed.sh
//    (Xcode automatic signing: real entitlements + provisioning profile), is
//    built here on demand when CAPTURIA_TEAM_ID is set, and is copied as-is;
//    electron-builder's signIgnore (see electron-builder.yml) keeps its inner
//    binary from being re-signed with Electron's inherit entitlements, which
//    would strip the app group + sandbox entitlements it needs. ACTIVATION of
//    the embedded copy is not wired yet: until the in-app request flow lands
//    (M8 slice 2) the extension still gets activated via the dev host app,
//    and the embedded copy only has to be correctly placed and signed.
//
// The identity/team never comes from a committed file: build-signed.sh reads
// CAPTURIA_TEAM_ID from the environment, and this hook only VERIFIES that the
// embedded extension's team matches it.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ID = "com.capturia.camera.extension";

function embedCameraExtension(resourcesSiblingContents) {
  const distSigned = join(
    root,
    "native",
    "CapturiaCamera",
    "dist-signed",
    "CapturiaCameraHost.app",
    "Contents",
    "Library",
    "SystemExtensions",
    `${EXT_ID}.systemextension`
  );
  const teamId = process.env.CAPTURIA_TEAM_ID;

  if (!existsSync(distSigned)) {
    if (!teamId) {
      console.log(
        "  • afterPack: no dist-signed camera extension and no CAPTURIA_TEAM_ID; " +
          "packaging WITHOUT an embedded extension (an already-activated extension still works)"
      );
      return;
    }
    console.log("  • afterPack: building the camera extension (build-signed.sh)");
    execFileSync("bash", [join(root, "native", "CapturiaCamera", "build-signed.sh")], {
      stdio: "inherit",
    });
  }

  const destDir = join(resourcesSiblingContents, "Library", "SystemExtensions");
  const dest = join(destDir, `${EXT_ID}.systemextension`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  // cp -R, not cpSync: preserves the bundle byte-for-byte the way codesign
  // sealed it (build-signed.sh uses the same to stage its dist).
  execFileSync("cp", ["-R", distSigned, dest]);

  // The copy must still verify, and its team must match the environment's.
  execFileSync("codesign", ["--verify", "--deep", "--strict", dest]);
  // codesign -dv writes its details to stderr.
  const detail = spawnSync("codesign", ["-dv", dest], { encoding: "utf8" });
  const team = /TeamIdentifier=(\S+)/.exec(detail.stderr || "")?.[1];
  if (teamId && team !== teamId) {
    throw new Error(
      `afterPack: embedded extension team (${team}) does not match CAPTURIA_TEAM_ID; rebuild it with build-signed.sh under the right team.`
    );
  }
  console.log(`  • afterPack embedded ${EXT_ID}.systemextension (team verified)`);
}

export default async function afterPack(context) {
  const stage = join(root, ".whisper-stage", "nodejs-whisper");
  if (!existsSync(stage)) {
    throw new Error(
      "afterPack: .whisper-stage missing; run node scripts/stage-whisper-resources.mjs (pack:mac does this)."
    );
  }
  const contents = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents"
  );
  const resources = join(contents, "Resources");
  const dest = join(resources, "nodejs-whisper");
  rmSync(dest, { recursive: true, force: true });
  // verbatimSymlinks: keep the staged dylib symlink chain relative; the
  // default would rewrite it to absolute paths into the packer's checkout.
  cpSync(stage, dest, { recursive: true, verbatimSymlinks: true });
  console.log(`  • afterPack copied self-contained nodejs-whisper -> ${dest}`);

  // The on-device streaming speech helper (macOS 26+). Optional: a build
  // without it degrades to the whisper engine. electron-builder signs it
  // afterwards like any other binary (hardened runtime + the inherit
  // entitlements, which carry the audio-input entitlement it needs).
  const speechHelper = join(root, "native", "capturia-speech", "capturia-speech");
  if (existsSync(speechHelper)) {
    cpSync(speechHelper, join(resources, "capturia-speech"));
    console.log("  • afterPack copied capturia-speech helper");
  } else {
    console.log("  • afterPack: capturia-speech helper not built; whisper engine only");
  }

  // The native camera addon. Not optional: without it the packaged app has no
  // virtual camera, which is exactly the shipped-broken state this hook fixes.
  const addon = join(root, "native", "capturia-frames", "build", "Release", "capturia_frames.node");
  if (!existsSync(addon)) {
    throw new Error(
      "afterPack: capturia_frames.node not built; run node scripts/build-frames-addon.mjs (pack:mac does this)."
    );
  }
  cpSync(addon, join(resources, "capturia_frames.node"));
  console.log("  • afterPack copied capturia_frames.node");

  embedCameraExtension(contents);
}
