// Headed desktop E2E for the camera mirror: launches the real Electron shell,
// drives an overlay into the visible Control Room (through the dev-only
// window.capturiaDrive hook), and proves the overlay text renders inside the
// OFFSCREEN camera window while the sink pumps at ~30fps, then quits cleanly.
//
// Requirements:
//   - Next dev server up on http://localhost:3000 (npm run dev)
//   - the Capturia camera extension installed and approved
//   - native/capturia-frames built (npx node-gyp rebuild in that dir)
//   - no other Capturia instance running (single-instance lock)
//
// Run: node scripts/e2e-desktop-camera.mjs
// Exits 0 on pass, 2 when the environment can't run it (extension/addon
// missing), 1 on a real failure.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _electron } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY_NAME = "Desktop Mirror Proof";
const DRIVE_JS = `window.capturiaDrive && (window.capturiaDrive.setOverlays([{
  id: "lt-desktop-e2e",
  type: "LowerThird",
  position: "bottom-left",
  props: { name: ${JSON.stringify(OVERLAY_NAME)}, subtitle: "via the mirror channel" },
}]), true)`;

function fail(msg, code = 1) {
  console.error(`[desktop-e2e] FAIL: ${msg}`);
  process.exit(code);
}

async function waitFor(what, fn, timeoutMs, everyMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// The dev server must already be serving the studio.
try {
  const res = await fetch("http://localhost:3000/studio", { method: "HEAD" });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  fail("dev server not reachable on http://localhost:3000 (run `npm run dev` first)", 2);
}

// Same prep `npm run electron` does via its preelectron hook.
for (const script of ["build-electron-libs.mjs", "build-speech-helper.mjs"]) {
  execFileSync(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    stdio: "inherit",
  });
}

console.log("[desktop-e2e] launching the Electron shell (CAPTURIA_CAMERA_LOG=1)");
const app = await _electron.launch({
  args: ["."],
  cwd: root,
  env: { ...process.env, CAPTURIA_CAMERA_LOG: "1" },
});

// Everything main logs, kept for the fps + lifecycle gates below.
const logLines = [];
for (const stream of [app.process().stdout, app.process().stderr]) {
  stream?.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) logLines.push(line);
    }
  });
}
const sawLog = (needle) => logLines.some((l) => l.includes(needle));

// Gate 1: the sink connects (page loaded AND painted, then the extension
// accepted the connect). If the environment can't do it, skip loudly.
await waitFor(
  "sink connect",
  async () => {
    if (sawLog("camera extension not found") || sawLog("Native camera module not built")) {
      await app.close().catch(() => {});
      fail("camera extension or native addon unavailable on this machine", 2);
    }
    return sawLog("connected to the Capturia camera sink");
  },
  60_000
);
console.log("[desktop-e2e] sink connected");

// Locate both windows from the main process: the visible Control Room and
// the offscreen ?out=1 camera window.
const windows = await waitFor(
  "both studio windows",
  async () => {
    const all = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        id: w.id,
        url: w.webContents.getURL(),
      }))
    );
    const out = all.find((w) => w.url.includes("out=1"));
    const main = all.find((w) => w.url.includes("/studio") && !w.url.includes("out=1"));
    return out && main ? { out, main } : null;
  },
  30_000
);
console.log(`[desktop-e2e] windows: main=${windows.main.url} out=${windows.out.url}`);

// Gate 2: drive an overlay into the VISIBLE window only.
await waitFor(
  "the Control Room's capturiaDrive hook",
  () =>
    app.evaluate(
      ({ BrowserWindow }, { id, js }) =>
        BrowserWindow.fromId(id).webContents.executeJavaScript(js, true),
      { id: windows.main.id, js: DRIVE_JS }
    ),
  30_000
);
console.log("[desktop-e2e] overlay driven into the Control Room");

// Gate 3: the overlay text renders inside the OFFSCREEN camera window.
await waitFor(
  "the overlay to appear in the offscreen camera window",
  () =>
    app.evaluate(
      ({ BrowserWindow }, { id, name }) =>
        BrowserWindow.fromId(id).webContents.executeJavaScript(
          `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(name)}))`,
          true
        ),
      { id: windows.out.id, name: OVERLAY_NAME }
    ),
  30_000
);
console.log("[desktop-e2e] overlay visible in the offscreen camera window");

// Gate 4: the pump keeps delivering ~30fps AFTER the mirror landed
// (CAPTURIA_CAMERA_LOG prints stats every 5s).
const statsBefore = logLines.length;
const fpsLine = await waitFor(
  "a healthy pump stats line",
  () => {
    const line = logLines
      .slice(statsBefore)
      .find((l) => /\[camera\] fps=(\d+)/.test(l) && Number(l.match(/fps=(\d+)/)[1]) >= 25);
    return line || null;
  },
  20_000
);
console.log(`[desktop-e2e] pump healthy after mirror: ${fpsLine.trim()}`);

// Gate 5: quit cleanly (app.quit walks before-quit/will-quit, so the sink
// disconnects and the extension's splash resumes).
const exited = new Promise((resolve) => app.process().once("exit", resolve));
await app.evaluate(({ app: electronApp }) => electronApp.quit());
const code = await Promise.race([
  exited,
  new Promise((r) => setTimeout(() => r("timeout"), 15_000)),
]);
if (code === "timeout") {
  app.process().kill("SIGKILL");
  fail("app did not exit within 15s of app.quit()");
}
if (!sawLog("disconnected from the camera sink")) {
  fail("no clean sink disconnect logged on quit");
}
console.log(`[desktop-e2e] clean exit (code ${code})`);
console.log("[desktop-e2e] PASS");
