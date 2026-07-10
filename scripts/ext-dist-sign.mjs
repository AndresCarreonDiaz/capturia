// Distribution (Developer ID) re-signing for the embedded CMIO camera
// extension. The extension bundle that scripts/after-pack.mjs embeds comes out
// of native/CapturiaCamera/build-signed.sh, which is Xcode AUTOMATIC signing:
// an Apple Development certificate plus a device-limited development profile.
// That flavor is exactly right for the dev loop and exactly wrong for
// distribution: the notary service rejects Apple Development signatures on any
// nested executable, and a development profile cannot activate on customer
// machines. This module turns the embedded COPY into the distribution flavor,
// leaving the dev build in native/CapturiaCamera/dist-signed untouched.
//
// Gated on one env var (the whole feature is inert without it):
//
//   CAPTURIA_EXT_PROVISIONING_PROFILE
//     Path to the portal-minted DEVELOPER ID provisioning profile for the
//     extension's own App ID (com.capturia.camera.extension). Minting it is a
//     one-time portal step documented in docs/release.md ("One-time portal
//     setup"). When set, the embedded extension is re-signed with the
//     Developer ID Application identity from the keychain: regenerated
//     entitlements (app sandbox + the team-prefixed app group + the
//     Xcode-style identity claims, and NO get-task-allow, which only the
//     development flavor carries and the notary rejects), this profile as
//     Contents/embedded.provisionprofile, hardened runtime, and a secure
//     timestamp; i.e. everything notarization requires of nested code.
//
// Everything identity-like stays out of logs and errors: the identity is
// resolved to its keychain SHA-1 and never echoed, and no team id or legal
// name is printed (pack logs get pasted into public issues).
//
// Why regenerate the entitlements instead of copying the dev signature's:
// the dev flavor's set is this exact set PLUS com.apple.security.get-task-allow
// (verified against a build-signed.sh product), which must not survive into a
// Developer ID signature, and the identity claims must be rebuilt anyway if
// the signing team ever differs from the dev team. The app group needs no
// profile entry: macOS authorizes team-id-prefixed app groups locally when the
// prefix equals the signing team, which the assertions below pin.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const EXT_ID = "com.capturia.camera.extension";
const APP_GROUP = "com.capturia.camera";

function decodeProfile(profilePath) {
  const decoded = spawnSync("security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8",
  });
  if (decoded.status !== 0 || !decoded.stdout) {
    throw new Error(
      `CAPTURIA_EXT_PROVISIONING_PROFILE is not a decodable provisioning profile: ${profilePath}`
    );
  }
  return decoded.stdout;
}

function plistString(xml, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(xml)?.[1];
}

// The profile's TeamIdentifier is a one-element array of strings.
function profileTeam(xml) {
  return /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1];
}

// TN3125 matching: the profile's application-identifier entitlement is either
// the explicit App ID or a wildcard prefix ending in *.
function profileAuthorizesAppId(profileAppId, appId) {
  if (profileAppId === appId) return true;
  if (profileAppId.endsWith("*")) return appId.startsWith(profileAppId.slice(0, -1));
  return false;
}

// Validates the CAPTURIA_EXT_PROVISIONING_PROFILE contract without touching
// the app: returns null when the env var is unset (feature off), otherwise
// { profilePath, team } or throws. Called fail-fast by scripts/pack-mac.mjs
// (before minutes of building) and again by the afterPack hook (which also
// runs under direct electron-builder invocations). Relative profile paths
// resolve against root (the repo), same as CAPTURIA_PROVISIONING_PROFILE.
export function validateExtDistSignEnv(env, root) {
  const source = env.CAPTURIA_EXT_PROVISIONING_PROFILE;
  if (!source) return null;

  const profilePath = resolve(root, source);
  if (!existsSync(profilePath)) {
    throw new Error(`CAPTURIA_EXT_PROVISIONING_PROFILE points at nothing: ${profilePath}`);
  }
  const xml = decodeProfile(profilePath);

  const team = profileTeam(xml);
  if (!team) {
    throw new Error("the extension profile has no TeamIdentifier; it is not a usable provisioning profile.");
  }
  if (env.CAPTURIA_TEAM_ID && team !== env.CAPTURIA_TEAM_ID) {
    throw new Error(
      "the extension profile belongs to a different team than CAPTURIA_TEAM_ID; " +
        "an extension signed under it could never activate. Re-mint it under the right team."
    );
  }

  // Authorization: the profile must be FOR the extension's App ID. This is
  // what rejects, say, the desktop app's profile handed to the wrong env var.
  const appId = `${team}.${EXT_ID}`;
  const profileAppId = plistString(xml, "com.apple.application-identifier");
  if (!profileAppId || !profileAuthorizesAppId(profileAppId, appId)) {
    throw new Error(
      `the extension profile does not authorize ${EXT_ID} (its application-identifier ` +
        "is for a different App ID). Mint a Developer ID profile for the extension's " +
        "own App ID (docs/release.md, 'One-time portal setup')."
    );
  }

  // Flavor: distribution (Developer ID) profiles provision all devices; a
  // DEVELOPMENT profile (device list) could never activate on customer
  // machines, so it is refused even when it names the right App ID.
  if (/<key>ProvisionedDevices<\/key>/.test(xml) || !/<key>ProvisionsAllDevices<\/key>\s*<true\/>/.test(xml)) {
    throw new Error(
      "the extension profile is a DEVELOPMENT profile (device-limited), not a Developer ID " +
        "distribution profile; it cannot activate on customer machines. Mint the Developer ID " +
        "flavor in the portal (docs/release.md, 'One-time portal setup')."
    );
  }

  return { profilePath, team };
}

// Resolves the Developer ID Application identity for the profile's team to
// its keychain SHA-1 (codesign accepts the hash, and the hash is the one form
// that never spells out a legal name in argv or logs). CSC_NAME, when set,
// must agree; ambiguity or absence fails loudly instead of guessing. Note the
// identity must live in a searchable keychain: the CSC_LINK temp-keychain flow
// happens inside electron-builder AFTER this hook, so the extension step
// supports the keychain (CSC_NAME) flow only.
export function resolveDeveloperIdIdentity(env, team) {
  const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  let lines = (found.stdout || "")
    .split("\n")
    .filter((line) => line.includes('"Developer ID Application'))
    .filter((line) => line.includes(`(${team})`));
  if (env.CSC_NAME) lines = lines.filter((line) => line.includes(env.CSC_NAME));
  if (lines.length === 0) {
    throw new Error(
      "CAPTURIA_EXT_PROVISIONING_PROFILE is set but no Developer ID Application identity " +
        "for the profile's team is in the keychain (CSC_NAME, when set, must match it too); " +
        "the extension cannot be distribution-signed. docs/release.md covers the certificate setup."
    );
  }
  if (lines.length > 1) {
    throw new Error(
      "more than one Developer ID Application identity matches; set CSC_NAME so the " +
        "extension re-sign cannot pick one by surprise."
    );
  }
  const hash = /([0-9A-F]{40})/.exec(lines[0])?.[1];
  if (!hash) throw new Error("could not parse the Developer ID identity's keychain hash.");
  return hash;
}

function entitlementsPlist(team) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${team}.${APP_GROUP}</string>
  </array>
  <key>com.apple.application-identifier</key>
  <string>${team}.${EXT_ID}</string>
  <key>com.apple.developer.team-identifier</key>
  <string>${team}</string>
</dict>
</plist>
`;
}

// The codesign invocation itself, shared by the real flow and the no-profile
// mechanics rehearsal in verification: --force replaces the development
// signature in place, --options runtime + --timestamp are notarization's hard
// requirements for nested code.
export function codesignExtension({ bundlePath, identityHash, team }) {
  const entDir = mkdtempSync(join(tmpdir(), "capturia-ext-entitlements-"));
  try {
    const entPath = join(entDir, "extension.entitlements.plist");
    writeFileSync(entPath, entitlementsPlist(team));
    execFileSync("codesign", [
      "--force",
      "--sign",
      identityHash,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      entPath,
      bundlePath,
    ]);
  } finally {
    rmSync(entDir, { recursive: true, force: true });
  }
}

// Post-sign assertions, pack-mac style: every silent way the re-sign could
// have produced an unshippable bundle fails loudly here. requireProfile is
// false only for the no-profile mechanics rehearsal.
export function assertDistSignedExtension({ bundlePath, team, requireProfile = true }) {
  // The seal must hold, nested and strict.
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundlePath]);

  // codesign -dvv reports on stderr. The Authority chain spells out the
  // identity, so the report is only ever TESTED, never printed.
  const detail = spawnSync("codesign", ["-dvv", bundlePath], { encoding: "utf8" });
  const report = `${detail.stderr || ""}${detail.stdout || ""}`;
  if (detail.status !== 0) throw new Error("codesign -dvv failed on the re-signed extension.");
  if (!report.includes("Developer ID Application")) {
    throw new Error("the re-signed extension's signature is not the Developer ID flavor.");
  }
  const signedTeam = /TeamIdentifier=(\S+)/.exec(report)?.[1];
  if (signedTeam !== team) {
    throw new Error(
      "the re-signed extension's TeamIdentifier does not match the profile's team; " +
        "the keychain resolved an identity from another team."
    );
  }
  if (!/flags=.*\(runtime\)/.test(report)) {
    throw new Error("the re-signed extension lacks the hardened runtime flag.");
  }
  // A SECURE timestamp prints as "Timestamp="; "Signed Time=" alone is the
  // unauthenticated local time notarization rejects.
  if (!/^Timestamp=/m.test(report)) {
    throw new Error("the re-signed extension has no secure timestamp (Timestamp= missing).");
  }

  // The signature must claim exactly the distribution entitlement set: the
  // sandbox, the team-prefixed app group (what the extension and app share
  // frames through), the identity claims the profile authorizes, and no
  // development-only get-task-allow (an instant notarization rejection).
  const ent = spawnSync("codesign", ["-d", "--entitlements", "-", bundlePath], {
    encoding: "utf8",
  });
  const entReport = `${ent.stdout || ""}${ent.stderr || ""}`;
  for (const needed of [
    "com.apple.security.app-sandbox",
    `${team}.${APP_GROUP}`,
    `${team}.${EXT_ID}`,
  ]) {
    if (!entReport.includes(needed)) {
      throw new Error(`the re-signed extension's entitlements lack ${needed}.`);
    }
  }
  if (entReport.includes("get-task-allow")) {
    throw new Error(
      "the re-signed extension still claims get-task-allow (development flavor); " +
        "notarization would reject it."
    );
  }

  if (requireProfile) {
    const embedded = join(bundlePath, "Contents", "embedded.provisionprofile");
    if (!existsSync(embedded)) {
      throw new Error("the re-signed extension has no Contents/embedded.provisionprofile.");
    }
  }
}

// The real flow: embed the Developer ID profile, re-sign, assert. Runs on the
// embedded COPY inside the app bundle, before electron-builder signs the
// outer app, so the outer seal covers the distribution flavor.
export function distSignEmbeddedExtension({ bundlePath, profilePath, team, identityHash }) {
  const embedded = join(bundlePath, "Contents", "embedded.provisionprofile");
  copyFileSync(profilePath, embedded);
  codesignExtension({ bundlePath, identityHash, team });
  assertDistSignedExtension({ bundlePath, team, requireProfile: true });
  // The profile inside the sealed bundle must BE the profile the operator
  // pointed at (a stale dev profile surviving the copy is exactly the bug
  // class this closes).
  if (!readFileSync(embedded).equals(readFileSync(profilePath))) {
    throw new Error("the embedded extension profile is not the CAPTURIA_EXT_PROVISIONING_PROFILE file.");
  }
}
