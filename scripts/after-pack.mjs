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
//    would strip the app group + sandbox entitlements it needs. With
//    CAPTURIA_EXT_PROVISIONING_PROFILE set (release builds), the embedded
//    COPY is then re-signed into the Developer ID distribution flavor by
//    scripts/ext-dist-sign.mjs (that file's header has the whole contract);
//    without it, the dev flavor ships untouched, exactly as before.
//
// The identity/team never comes from a committed file: build-signed.sh reads
// CAPTURIA_TEAM_ID from the environment, and this hook only VERIFIES that the
// embedded extension's team matches it.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EXT_ID,
  distSignEmbeddedExtension,
  resolveDeveloperIdIdentity,
  validateExtDistSignEnv,
} from "./ext-dist-sign.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  // Validated here as well as in pack-mac (this hook also runs under direct
  // electron-builder invocations); throws on any broken contract.
  const distSign = validateExtDistSignEnv(process.env, root);

  if (!existsSync(distSigned)) {
    if (!teamId) {
      if (distSign) {
        throw new Error(
          "afterPack: CAPTURIA_EXT_PROVISIONING_PROFILE is set but there is no extension to " +
            "embed (no dist-signed build and no CAPTURIA_TEAM_ID to build one); a release " +
            "expecting a distribution-signed extension cannot silently pack without one."
        );
      }
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

  // Release flavor: re-sign the embedded copy with the Developer ID identity,
  // the regenerated distribution entitlements, and the portal profile, then
  // assert the result (deep-strict, Developer ID, hardened runtime, secure
  // timestamp, entitlements, profile). The dev build in dist-signed stays
  // untouched, and the outer app signing (after this hook) seals the result.
  if (distSign) {
    distSignEmbeddedExtension({
      bundlePath: dest,
      profilePath: distSign.profilePath,
      team: distSign.team,
      identityHash: resolveDeveloperIdIdentity(process.env, distSign.team),
    });
    console.log(`  • afterPack distribution-signed the embedded ${EXT_ID}.systemextension`);
  }

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

// Every staged Mach-O must run in (or beside) the arm64 app. The reference
// arch comes from the app's own main executable, so this stays correct if the
// target arch ever changes; the classic failure it catches is an x86_64 Node
// (Rosetta terminal) having built an x86_64 addon for an arm64 app, which
// would ship a camera that cannot load.
function assertMachOArch(appArchs, file, what) {
  const archs = spawnSync("lipo", ["-archs", file], { encoding: "utf8" })
    .stdout.trim()
    .split(/\s+/);
  if (!archs.some((a) => appArchs.includes(a))) {
    throw new Error(
      `afterPack: ${what} is [${archs.join(", ")}] but the app is [${appArchs.join(", ")}]; ` +
        "rebuild it with a matching toolchain (a Rosetta/x86_64 Node builds x86_64 addons)."
    );
  }
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
  const appArchs = spawnSync(
    "lipo",
    ["-archs", join(contents, "MacOS", context.packager.appInfo.productFilename)],
    { encoding: "utf8" }
  )
    .stdout.trim()
    .split(/\s+/);
  const dest = join(resources, "nodejs-whisper");
  rmSync(dest, { recursive: true, force: true });
  // verbatimSymlinks: keep the staged dylib symlink chain relative; the
  // default would rewrite it to absolute paths into the packer's checkout.
  cpSync(stage, dest, { recursive: true, verbatimSymlinks: true });
  const whisperCli = join(dest, "cpp", "whisper.cpp", "build", "bin", "whisper-cli");
  if (existsSync(whisperCli)) assertMachOArch(appArchs, whisperCli, "whisper-cli");
  console.log(`  • afterPack copied self-contained nodejs-whisper -> ${dest}`);

  // The on-device streaming speech helper (macOS 26+). Optional: a build
  // without it degrades to the whisper engine. electron-builder signs it
  // afterwards like any other binary (hardened runtime + the inherit
  // entitlements, which carry the audio-input entitlement it needs).
  const speechHelper = join(root, "native", "capturia-speech", "capturia-speech");
  if (existsSync(speechHelper)) {
    assertMachOArch(appArchs, speechHelper, "capturia-speech helper");
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
  assertMachOArch(appArchs, addon, "capturia_frames.node");
  cpSync(addon, join(resources, "capturia_frames.node"));
  console.log("  • afterPack copied capturia_frames.node");

  // The extension-activation addon (OSSystemExtensionRequest bridge). Also
  // not optional: a packaged app that cannot even offer the camera install is
  // the M8 gap this ships. Whether a given BUILD can actually activate is a
  // runtime decision (electron/sysext.js checks the signed entitlement).
  const sysextAddon = join(
    root,
    "native",
    "capturia-sysext",
    "build",
    "Release",
    "capturia_sysext.node"
  );
  if (!existsSync(sysextAddon)) {
    throw new Error(
      "afterPack: capturia_sysext.node not built; run node scripts/build-sysext-addon.mjs (pack:mac does this)."
    );
  }
  assertMachOArch(appArchs, sysextAddon, "capturia_sysext.node");
  cpSync(sysextAddon, join(resources, "capturia_sysext.node"));
  console.log("  • afterPack copied capturia_sysext.node");

  embedCameraExtension(contents);
}
