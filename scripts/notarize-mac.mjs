// Notarizes and staples the packed release artifacts (called by dist:mac,
// runnable standalone: node scripts/notarize-mac.mjs). Gated on ONE env var:
//
//   CAPTURIA_NOTARY_PROFILE   Name of an `xcrun notarytool store-credentials`
//                             keychain profile (one-time setup documented in
//                             docs/release.md). Unset: a clear skip line and
//                             exit 0, so credential-less builds stay green.
//
// The profile NAME is the only thing this script ever handles; the Apple ID
// and app-specific password live in the login keychain where store-credentials
// put them, are read by notarytool itself, and never appear in env, argv
// echoes, or logs here. Nothing credential-shaped is ever printed.
//
// Flow (Apple's "Customizing the notarization workflow", TN3147):
//
//   1. Submit the DMG: xcrun notarytool submit --keychain-profile --wait.
//      One submission covers every nested item (the .app inside the image
//      gets its own ticket, keyed by its code-directory hash).
//   2. On anything but Accepted: FAIL LOUDLY, fetching and printing the
//      developer log (notarytool serves the log content directly; unlike the
//      old altool there is no separate LogFileURL to print).
//   3. Staple the .app in dist-app (possible precisely because tickets are
//      per-item: the same build outside the image staples fine, while the
//      copy INSIDE the read-only DMG can never be stapled in place) and
//      staple the DMG itself, whose ticket covers Gatekeeper evaluation of
//      the image and its contents offline.
//   4. Re-assert with spctl --assess: the app must now pass ("accepted",
//      source Notarized Developer ID), the exact check that rejects a signed
//      but unnotarized build.
//
// Notarization only ever Accepts Developer ID signatures with hardened
// runtime and a secure timestamp (pack:mac's signing path provides both). A
// real but non-Developer-ID signature (an Apple Development pack) gets a
// WARNING here and is submitted anyway: the operator explicitly opted in by
// setting the profile, and Apple's rejection plus its log is the
// authoritative answer, not a local guess. An ad-hoc/unsigned pack is
// refused outright: submitting it could never work and the profile being set
// means someone expected a notarized artifact, so degrading silently is the
// one forbidden outcome.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = join(root, "dist-app", "mac-arm64", "Capturia.app");
const distDir = join(root, "dist-app");

function fail(message) {
  console.error(`[notarize] FAIL: ${message}`);
  process.exit(1);
}

const profile = process.env.CAPTURIA_NOTARY_PROFILE;
if (!profile) {
  console.log(
    "[notarize] skipped: CAPTURIA_NOTARY_PROFILE not set (the artifact is NOT notarized; " +
      "Gatekeeper will reject it when downloaded. docs/release.md covers the one-time credential setup.)"
  );
  process.exit(0);
}

if (!existsSync(appPath)) fail(`no packed app at ${appPath}; run npm run dist:mac first`);
const dmgName = readdirSync(distDir).find((name) => name.endsWith(".dmg"));
if (!dmgName) fail("no .dmg in dist-app; run npm run dist:mac first");
const dmgPath = join(distDir, dmgName);

// Signature triage before spending an upload. codesign -dvv reports on stderr.
const detail = spawnSync("codesign", ["-dvv", appPath], { encoding: "utf8" });
const report = `${detail.stderr || ""}${detail.stdout || ""}`;
const team = /TeamIdentifier=(.+)/.exec(report)?.[1]?.trim();
if (detail.status !== 0 || /Signature=adhoc/.test(report) || !team || team === "not set") {
  fail(
    "CAPTURIA_NOTARY_PROFILE is set but the packed app has no real signature; " +
      "notarization needs a Developer ID signed pack (CSC_NAME + npm run dist:mac)."
  );
}
if (!report.includes("Developer ID Application")) {
  console.log(
    "[notarize] WARNING: the app signature is not Developer ID; Apple will reject this " +
      "submission. Submitting anyway so the rejection (and its log) is authoritative."
  );
}

// Submit and wait. Output is streamed (a wait can take minutes) AND captured,
// because the submission id and final status ride the same text.
function runCaptured(cmd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on("close", (code) => resolvePromise({ code, output }));
  });
}

console.log("[notarize] CAPTURIA_NOTARY_PROFILE is set: submitting the DMG to the notary service");
const submit = await runCaptured("xcrun", [
  "notarytool",
  "submit",
  dmgPath,
  "--keychain-profile",
  profile,
  "--wait",
]);
const submissionId = /^\s*id: ([0-9a-f-]+)$/m.exec(submit.output)?.[1];
if (submit.code !== 0) {
  fail(
    "notarytool submit failed (a missing/typo'd keychain profile fails here; " +
      "docs/release.md covers store-credentials)."
  );
}
const statusMatches = [...submit.output.matchAll(/^\s*status: (.+)$/gm)];
const status = statusMatches.at(-1)?.[1]?.trim();
if (status !== "Accepted") {
  if (submissionId) {
    console.error(`[notarize] submission ${submissionId} ended ${status ?? "without a status"}; fetching the developer log:`);
    // notarytool serves the log content itself; print it inline (there is no
    // user-facing URL to hand out) plus the command to re-fetch it later.
    const log = await runCaptured("xcrun", [
      "notarytool",
      "log",
      submissionId,
      "--keychain-profile",
      profile,
    ]);
    if (log.code !== 0) console.error("[notarize] (log fetch failed; re-run it manually)");
    console.error(
      `[notarize] re-fetch: xcrun notarytool log ${submissionId} --keychain-profile "$CAPTURIA_NOTARY_PROFILE"`
    );
  }
  fail(`notarization was not Accepted (status: ${status ?? "unknown"})`);
}
console.log(`[notarize] Accepted (submission ${submissionId ?? "id not parsed"})`);

// Staple both artifacts. The app first: its ticket exists independently of
// the DMG's, and a stapled dist-app bundle is what ad-hoc distribution (a
// bare .zip of the app) would ship.
for (const [what, target] of [["app", appPath], ["dmg", dmgPath]]) {
  const staple = spawnSync("xcrun", ["stapler", "staple", target], { stdio: "inherit" });
  if ((staple.status ?? 1) !== 0) fail(`stapler staple failed for the ${what}`);
  console.log(`[notarize] stapled the ${what}`);
}

// The assertion notarization exists to flip: Gatekeeper's own verdict.
const assess = spawnSync("spctl", ["--assess", "--type", "exec", "-vv", appPath], {
  encoding: "utf8",
});
const verdict = `${assess.stderr || ""}${assess.stdout || ""}`.trim();
console.log(verdict);
if (assess.status !== 0 || !/:\s*accepted/.test(verdict)) {
  fail("spctl --assess still rejects the notarized app");
}
console.log("[notarize] PASS: notarized, stapled, and accepted by Gatekeeper");
