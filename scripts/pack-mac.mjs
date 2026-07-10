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
//   CAPTURIA_PROVISIONING_PROFILE
//                     Path to a .provisionprofile for com.capturia.desktop
//                     that authorizes com.apple.developer.system-extension.
//                     install (development: native/CapturiaCamera/
//                     mint-desktop-profile.sh; distribution: a Developer ID
//                     profile from the portal). When set, the app is signed
//                     WITH the system-extension entitlement (a generated
//                     entitlements file: the committed base plus the
//                     entitlement and, when CAPTURIA_TEAM_ID is set, the
//                     Xcode-style application-identifier claims) and the
//                     profile is embedded, enabling in-app camera-extension
//                     activation. Without it the app signs exactly as before
//                     and the install UI reports itself unavailable. The
//                     entitlement is NEVER claimed without a profile: AMFI
//                     SIGKILLs any app claiming this restricted entitlement
//                     bare, Developer ID included (verified on this repo's
//                     machine; docs/virtual-camera.md has the whole story).
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
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveDeveloperIdIdentity, validateExtDistSignEnv } from "./ext-dist-sign.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(`[pack-mac] FAIL: ${message}`);
  process.exit(1);
}

// Extension distribution signing (release builds): with
// CAPTURIA_EXT_PROVISIONING_PROFILE set, the afterPack hook re-signs the
// embedded camera extension into the Developer ID flavor (scripts/
// ext-dist-sign.mjs has the whole contract). The contract is validated HERE
// first because it is pure environment + keychain inspection: a broken
// profile or a missing Developer ID identity fails in milliseconds instead
// of after minutes of building. afterPack re-validates (it also serves
// direct electron-builder invocations) and performs the actual re-sign.
if (process.env.CAPTURIA_EXT_PROVISIONING_PROFILE) {
  if (!(process.env.CSC_NAME || process.env.CSC_LINK)) {
    fail(
      "CAPTURIA_EXT_PROVISIONING_PROFILE is set but no CSC_NAME/CSC_LINK; a " +
        "distribution-signed extension inside an unsigned app cannot ship."
    );
  }
  try {
    const distSign = validateExtDistSignEnv(process.env, root);
    resolveDeveloperIdIdentity(process.env, distSign.team);
  } catch (error) {
    fail(error.message);
  }
  console.log(
    "[pack-mac] extension distribution signing enabled (CAPTURIA_EXT_PROVISIONING_PROFILE + Developer ID identity verified)"
  );
}

run(process.execPath, [join(root, "scripts", "build-electron-export.mjs")]);
run(process.execPath, [join(root, "scripts", "build-speech-helper.mjs"), "--strict"]);
run(process.execPath, [join(root, "scripts", "build-frames-addon.mjs"), "--strict"]);
run(process.execPath, [join(root, "scripts", "build-sysext-addon.mjs"), "--strict"]);
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

// In-app extension activation (M8 slice 2): with a provisioning profile for
// com.capturia.desktop, the app signs with the (restricted, profile-gated)
// system-extension entitlement and embeds the profile. The entitlements file
// is GENERATED into a temp dir: the entitlement must never sit in the default
// committed plist (a profile-less signed build claiming it is SIGKILLed by
// AMFI at launch), and the optional application-identifier claims carry the
// team id, which never enters a committed file.
const profileSource = env.CAPTURIA_PROVISIONING_PROFILE;
if (profileSource) {
  if (!signingRequested) {
    fail("CAPTURIA_PROVISIONING_PROFILE is set but no CSC_NAME/CSC_LINK; a profile without a signature cannot be honored.");
  }
  const profilePath = resolve(root, profileSource);
  if (!existsSync(profilePath)) {
    fail(`CAPTURIA_PROVISIONING_PROFILE points at nothing: ${profilePath}`);
  }
  // The profile must actually authorize the entitlement we are about to
  // claim, or the packed app dies at launch; catching that here beats
  // debugging a SIGKILL. security cms decodes the CMS-wrapped plist.
  const decoded = spawnSync("security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8",
  });
  if (decoded.status !== 0 || !decoded.stdout.includes("com.apple.developer.system-extension.install")) {
    fail("the provisioning profile does not authorize com.apple.developer.system-extension.install; re-mint it (native/CapturiaCamera/mint-desktop-profile.sh).");
  }
  if (env.CAPTURIA_TEAM_ID && !decoded.stdout.includes(`${env.CAPTURIA_TEAM_ID}.com.capturia.desktop`)) {
    fail("the provisioning profile's app id is not <CAPTURIA_TEAM_ID>.com.capturia.desktop.");
  }

  const base = readFileSync(join(root, "build", "entitlements.mac.plist"), "utf8");
  let extra = "    <key>com.apple.developer.system-extension.install</key>\n    <true/>\n";
  if (env.CAPTURIA_TEAM_ID) {
    // The Xcode-style identity claims, so the system can match the app to
    // its profile the documented way (TN3125). Empirically macOS 26 accepts
    // the embedded profile without them, but they cost nothing and match
    // what Xcode produces for the dev host app.
    extra +=
      "    <key>com.apple.application-identifier</key>\n" +
      `    <string>${env.CAPTURIA_TEAM_ID}.com.capturia.desktop</string>\n` +
      "    <key>com.apple.developer.team-identifier</key>\n" +
      `    <string>${env.CAPTURIA_TEAM_ID}</string>\n`;
  }
  const generated = base.replace(/([\t ]*)<\/dict>/, `${extra}  </dict>`);
  if (!generated.includes("system-extension.install")) {
    fail("could not inject the system-extension entitlement into build/entitlements.mac.plist.");
  }
  const entDir = mkdtempSync(join(tmpdir(), "capturia-entitlements-"));
  const entPath = join(entDir, "entitlements.mac.plist");
  writeFileSync(entPath, generated);
  builderArgs.push(`-c.mac.provisioningProfile=${profilePath}`);
  builderArgs.push(`-c.mac.entitlements=${entPath}`);
  console.log("[pack-mac] in-app extension activation enabled (entitlement + provisioning profile)");
} else if (signingRequested) {
  console.log(
    "[pack-mac] CAPTURIA_PROVISIONING_PROFILE not set: signing WITHOUT the system-extension entitlement (in-app camera install will report itself unavailable)"
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

  // Activation-capable packs must actually carry both halves of the contract:
  // the entitlement in the app signature AND the embedded profile that
  // authorizes it (either alone produces an app that cannot activate, or one
  // that AMFI kills at launch).
  if (profileSource) {
    const entitlements = spawnSync(
      "codesign",
      ["-d", "--entitlements", "-", appPath],
      { encoding: "utf8" }
    );
    const entReport = `${entitlements.stdout || ""}${entitlements.stderr || ""}`;
    if (!entReport.includes("com.apple.developer.system-extension.install")) {
      fail("the packed app's signature lacks com.apple.developer.system-extension.install.");
    }
    const embedded = join(appPath, "Contents", "embedded.provisionprofile");
    if (!existsSync(embedded)) {
      fail("the packed app has no Contents/embedded.provisionprofile.");
    }
    // The profile must belong to the team that ACTUALLY signed the app (a
    // two-team keychain can resolve CSC_NAME to one team while the profile
    // was minted under another; AMFI would kill that app at launch, and no
    // CAPTURIA_TEAM_ID needs to be set for the mismatch to happen).
    const embeddedDecoded = spawnSync("security", ["cms", "-D", "-i", embedded], {
      encoding: "utf8",
    });
    const profileTeam = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(
      embeddedDecoded.stdout || ""
    )?.[1];
    if (embeddedDecoded.status !== 0 || !profileTeam) {
      fail("could not read the embedded profile's TeamIdentifier.");
    }
    if (profileTeam !== team) {
      fail(
        "the embedded provisioning profile belongs to a different team than the app's signature; " +
          "the app would be killed at launch. Re-mint the profile under the signing team."
      );
    }
    console.log("[pack-mac] system-extension entitlement + embedded profile verified (teams match)");
  }
}
