// Smoke-runs the PACKAGED app (dist-app/mac-arm64/Capturia.app): launches its
// binary directly with CAPTURIA_SMOKE=1 and asserts the clean-boot gate main
// runs in that mode (static UI bundle executed, preload bridge up, loopback
// runtime keycheck answered). When the Capturia camera extension is installed
// and approved on this machine (or CAPTURIA_SMOKE_CAMERA=1 forces it), the
// run also asserts the packaged camera stack end to end: addon loads, the
// offscreen Program Output paints, the sink connects, frames pump.
//
// Run:  npm run pack:mac && node scripts/smoke-packaged-app.mjs
// Pass --no-camera to skip the camera leg even with the extension present.
// Exits 0 on pass, 1 on failure (including a missing build).

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = join(
  root,
  "dist-app",
  "mac-arm64",
  "Capturia.app",
  "Contents",
  "MacOS",
  "Capturia"
);

function fail(msg) {
  console.error(`[smoke-packaged] FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(binary)) {
  fail(`no packaged app at ${binary}; run npm run pack:mac first`);
}

// Camera leg: forced by env, skippable by flag, otherwise auto-detected from
// the installed-and-enabled extension (systemextensionsctl lists it without
// privileges). Detection failure just means "skip", never a smoke failure.
// systemextensionsctl prints ONE ROW PER VERSION of the extension: a stale
// "[terminated waiting to uninstall]" row can precede the live one, so the
// gate is "ANY row for the bundle id says activated enabled".
function extensionEnabled() {
  const out = spawnSync("systemextensionsctl", ["list"], { encoding: "utf8" });
  return (out.stdout || "")
    .split("\n")
    .filter((l) => l.includes("com.capturia.camera.extension"))
    .some((l) => l.includes("activated enabled"));
}
let camera;
if (process.argv.includes("--no-camera")) camera = false;
else if (process.env.CAPTURIA_SMOKE_CAMERA === "1") camera = true;
else camera = extensionEnabled();
console.log(`[smoke-packaged] camera leg: ${camera ? "ON" : "off"}`);

// Can THIS build request activation at all? Mirrors the app's own capability
// probe (electron/sysext.js): embedded extension present + the
// system-extension entitlement in the app signature. The sysext status
// expectation below depends on it: a profile-less pack correctly reports
// "unsupported" no matter what the machine has enabled, and demanding
// "installed" from it would fail a perfectly good pack.
function buildCanInstall() {
  const appBundle = join(root, "dist-app", "mac-arm64", "Capturia.app");
  const embedded = join(
    appBundle,
    "Contents",
    "Library",
    "SystemExtensions",
    "com.capturia.camera.extension.systemextension"
  );
  if (!existsSync(embedded)) return false;
  const out = spawnSync("codesign", ["-d", "--entitlements", "-", appBundle], {
    encoding: "utf8",
  });
  return `${out.stdout || ""}${out.stderr || ""}`.includes(
    "com.apple.developer.system-extension.install"
  );
}
const capable = buildCanInstall();
console.log(`[smoke-packaged] build can install the extension: ${capable ? "yes" : "no"}`);

// Build the child env explicitly: an inherited CAPTURIA_SMOKE_CAMERA=1 must
// not ride through the spread when the leg is off (--no-camera has to mean
// off, full stop).
const childEnv = { ...process.env, CAPTURIA_SMOKE: "1" };
if (camera) childEnv.CAPTURIA_SMOKE_CAMERA = "1";
else delete childEnv.CAPTURIA_SMOKE_CAMERA;

// Extension-activation state leg (M8 slice 2): always on; it is read-only
// (reports the status mapping, fires no request) and must hold on every
// machine: "installed" where the extension is enabled, any other mapped
// status elsewhere. CAPTURIA_SMOKE_SYSEXT_ACTIVATE=1 (opt-in via the caller's
// environment, like the live packaged verify) additionally drives a real
// activation request; it is never forced on here so unattended runs stay
// deterministic and dialog-free.
childEnv.CAPTURIA_SMOKE_SYSEXT = "1";

const child = spawn(binary, [], {
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
}

// Generous ceiling: smoke's own page gate is 15s and the camera gate 45s.
const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail("packaged app did not finish its smoke run within 120s");
}, 120000);

child.on("close", (code) => {
  clearTimeout(timer);
  if (code !== 0) fail(`packaged app exited ${code}`);
  if (!output.includes("[smoke] PASS")) fail("exit 0 but no [smoke] PASS in output");
  if (camera && !/"camera":\{"ok":true/.test(output.replace(/\s/g, ""))) {
    fail("camera leg requested but no passing camera evidence in output");
  }
  const compact = output.replace(/\s/g, "");
  if (!/"sysext":\{"ok":true/.test(compact)) {
    fail("no passing sysext evidence in output");
  }
  // The runner's own detection and the app's status mapping must agree,
  // capability first: a build without the entitlement reports "unsupported"
  // regardless of the machine, and only a CAPABLE build on a machine with
  // the extension enabled must report "installed".
  if (!capable && !compact.includes('"status":"unsupported"')) {
    fail("profile-less build should report sysext status unsupported");
  }
  if (capable && camera && !compact.includes('"status":"installed"')) {
    fail("extension is enabled on this machine but the capable app did not report status installed");
  }
  console.log("[smoke-packaged] PASS");
});
