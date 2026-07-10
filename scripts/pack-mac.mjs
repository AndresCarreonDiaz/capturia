// Packs the mac desktop app (npm run pack:mac). Replaces the old inline npm
// chain so the signing decision can come from the ENVIRONMENT, never from a
// committed value (public repo: no identity strings, no team ids). Steps:
//
//   1. build:electron           electron/gen libs + the out/ static export
//   2. build-speech-helper      --strict (streaming speech ships or the pack stops)
//   3. build-frames-addon       --strict (the native camera ships or the pack stops)
//   4. check-whisper-assets     provisioning visibility (warns, never fails)
//   5. stage-whisper-resources  self-contained nodejs-whisper copy
//   6. electron-builder --mac   packaging + signing per the contract below
//
// Signing contract (see also electron-builder.yml and scripts/after-pack.mjs):
//
//   CSC_NAME          Keychain codesigning identity, WITHOUT the certificate
//                     type prefix (electron-builder rejects prefixed names;
//                     "Jane Doe" or a team id suffix like "ABCDE12345" both
//                     work). electron-builder resolves it against Developer ID
//                     Application certificates first.
//   CSC_LINK          electron-builder's standard CI mechanism instead of a
//   CSC_KEY_PASSWORD  pre-installed keychain identity: a base64 (or file/http)
//                     .p12 imported into a temporary keychain for the build.
//   CAPTURIA_TEAM_ID  Apple Team ID. Lets the afterPack hook build (via
//                     native/CapturiaCamera/build-signed.sh) and verify the
//                     embedded CMIO camera extension, and pins the post-pack
//                     signature assertion to that team. Without it a prebuilt
//                     dist-signed extension is still embedded when present.
//
//   None of CSC_NAME/CSC_LINK set: the explicit ad-hoc fallback. Identity
//   auto-discovery is DISABLED (a keychain identity must never be picked up
//   by surprise, and CI has none anyway), electron-builder skips signing, and
//   the app runs on the ad-hoc signatures the Electron binaries ship with.
//   Same output as before signing existed, so unsigned contributor/CI packs
//   keep working.
//
//   When signing IS requested it must never degrade silently: electron-builder
//   only WARNS and packs unsigned when the identity cannot be resolved (typo'd
//   CSC_NAME, missing cert), and skips signing outright on PR builds unless
//   CSC_FOR_PULL_REQUEST=true. forceCodeSigning turns identity-resolution
//   failure into a build failure, and the post-pack codesign assertion below
//   catches every remaining skip path by requiring a real (non ad-hoc)
//   signature, team-matched when CAPTURIA_TEAM_ID is set.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [join(root, "scripts", "build-electron-export.mjs")]);
run(process.execPath, [join(root, "scripts", "build-speech-helper.mjs"), "--strict"]);
run(process.execPath, [join(root, "scripts", "build-frames-addon.mjs"), "--strict"]);
run(process.execPath, [join(root, "scripts", "check-whisper-assets.mjs")]);
run(process.execPath, [join(root, "scripts", "stage-whisper-resources.mjs")]);

const env = { ...process.env };
const signingRequested = Boolean(env.CSC_NAME || env.CSC_LINK);
const builderArgs = ["--mac"];
if (signingRequested) {
  // Never echo the identity or link; pack logs get pasted into public issues.
  console.log("[pack-mac] signing enabled (CSC_NAME/CSC_LINK is set)");
  builderArgs.push("-c.forceCodeSigning=true");
} else {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  console.log(
    "[pack-mac] no CSC_NAME/CSC_LINK: explicit ad-hoc fallback (no identity auto-discovery, signing skipped)"
  );
}
if (!env.CAPTURIA_TEAM_ID) {
  console.log(
    "[pack-mac] CAPTURIA_TEAM_ID not set: the camera extension is embedded only if a dist-signed build already exists"
  );
}

run(join(root, "node_modules", ".bin", "electron-builder"), builderArgs, env);

// Post-pack signature assertion: catches every way a requested signature can
// silently not happen (PR-build skip, custom sign hooks, future
// electron-builder behavior drift). codesign -dv reports on stderr; an
// unsigned bundle exits non-zero, an ad-hoc one shows Signature=adhoc and no
// real TeamIdentifier.
if (signingRequested) {
  const appPath = join(root, "dist-app", "mac-arm64", "Capturia.app");
  const detail = spawnSync("codesign", ["-dv", appPath], { encoding: "utf8" });
  const report = `${detail.stderr || ""}${detail.stdout || ""}`;
  const team = /TeamIdentifier=(.+)/.exec(report)?.[1]?.trim();
  const adhoc = /Signature=adhoc/.test(report) || !team || team === "not set";
  if (detail.status !== 0 || adhoc) {
    console.error(
      "[pack-mac] FAIL: signing was requested but the packed app carries no real signature " +
        "(unresolvable CSC_NAME? PR build without CSC_FOR_PULL_REQUEST?)."
    );
    process.exit(1);
  }
  if (env.CAPTURIA_TEAM_ID && team !== env.CAPTURIA_TEAM_ID) {
    console.error(
      "[pack-mac] FAIL: the packed app is signed by a different team than CAPTURIA_TEAM_ID."
    );
    process.exit(1);
  }
  console.log(`[pack-mac] signature verified (TeamIdentifier=${team})`);
}
