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
function extensionEnabled() {
  const out = spawnSync("systemextensionsctl", ["list"], { encoding: "utf8" });
  const line = (out.stdout || "")
    .split("\n")
    .find((l) => l.includes("com.capturia.camera.extension"));
  return Boolean(line && line.includes("enabled"));
}
let camera;
if (process.argv.includes("--no-camera")) camera = false;
else if (process.env.CAPTURIA_SMOKE_CAMERA === "1") camera = true;
else camera = extensionEnabled();
console.log(`[smoke-packaged] camera leg: ${camera ? "ON" : "off"}`);

const child = spawn(binary, [], {
  env: {
    ...process.env,
    CAPTURIA_SMOKE: "1",
    ...(camera ? { CAPTURIA_SMOKE_CAMERA: "1" } : {}),
  },
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
  console.log("[smoke-packaged] PASS");
});
