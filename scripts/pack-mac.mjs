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
//   CAPTURIA_TEAM_ID  Apple Team ID. Lets the afterPack hook build (via
//                     native/CapturiaCamera/build-signed.sh) and verify the
//                     embedded CMIO camera extension. Without it a prebuilt
//                     dist-signed extension is still embedded when present.
//
//   Neither set: the explicit ad-hoc fallback. Identity auto-discovery is
//   DISABLED (a keychain identity must never be picked up by surprise, and CI
//   has none anyway), electron-builder skips signing, and the app runs on the
//   ad-hoc signatures the Electron binaries ship with. Same output as before
//   signing existed, so unsigned contributor/CI packs keep working.

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
if (env.CSC_NAME) {
  // Never echo the identity itself; pack logs are pasted into public issues.
  console.log("[pack-mac] signing enabled (CSC_NAME is set)");
} else {
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  console.log(
    "[pack-mac] CSC_NAME not set: explicit ad-hoc fallback (no identity auto-discovery, signing skipped)"
  );
}
if (!env.CAPTURIA_TEAM_ID) {
  console.log(
    "[pack-mac] CAPTURIA_TEAM_ID not set: the camera extension is embedded only if a dist-signed build already exists"
  );
}

run(join(root, "node_modules", ".bin", "electron-builder"), ["--mac"], env);
