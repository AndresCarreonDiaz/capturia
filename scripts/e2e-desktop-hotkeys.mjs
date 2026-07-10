// Headed desktop E2E for the silent cue hotkeys: launches the real Electron
// shell against the dev server and proves the whole lifecycle end to end.
//   1. no deck loaded  -> no cue shortcuts registered (nothing squatted)
//   2. deck loads      -> Cmd/Ctrl+Alt+1..N (deck size, max 9) plus
//                         Cmd/Ctrl+Alt+Right register globally; the voice
//                         hotkey stays registered untouched
//   3. presses arrive  -> cards land in the Control Room, and a back-to-back
//                         repeat burst lands exactly ONE card (the renderer
//                         debounce; simulated on the same "hotkey" channel
//                         the globalShortcut callbacks send on, since nothing
//                         can synthesize a real OS-level keypress headless)
//   4. deck clears     -> every cue shortcut unregisters, voice remains
//
// Requirements:
//   - Next dev server up on http://localhost:3000 (npm run dev)
//
// The shell runs against a throwaway userData dir (CAPTURIA_USER_DATA, honored
// by dev builds only) plus Chromium's mock keychain, so the run neither
// contends with an installed Capturia.app's single-instance lock nor touches
// any real profile, vault, or OS keychain item.
//
// Run: node scripts/e2e-desktop-hotkeys.mjs
// Exits 0 on pass, 2 when the environment can't run it, 1 on a real failure.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _electron } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Two cards on purpose: proves digits register up to the DECK size (Alt+3
// must stay free), not blanket 1..9.
const CARDS = [1, 2].map((n) => ({
  id: `cue-hk-${n}`,
  label: `Hotkey Card ${n}`,
  aliases: [`hotkey card ${n}`],
  slideIndex: n - 1,
  specs: [
    {
      id: `hk-overlay-${n}`,
      type: "LowerThird",
      position: "bottom-left",
      props: { name: `Desktop Hotkey Proof ${n}`, subtitle: "silent trigger" },
    },
  ],
  adapted: false,
}));
const DRIVE_CUES_JS = (cards) =>
  `window.capturiaDrive ? (window.capturiaDrive.setCues(${JSON.stringify(cards)}), true) : false`;

function fail(msg, code = 1) {
  console.error(`[hotkey-e2e] FAIL: ${msg}`);
  process.exit(code);
}

// Polls until fn returns truthy. A throwing poll counts as "not yet": an
// executeJavaScript can race the page's own navigation/reload during startup
// (destroyed execution context), which is a retry, not a failure.
async function waitFor(what, fn, timeoutMs, everyMs = 250) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn().catch(() => null);
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

const userData = mkdtempSync(join(tmpdir(), "capturia-hotkey-e2e-"));
process.on("exit", () => {
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

console.log("[hotkey-e2e] launching the Electron shell (isolated userData)");
const app = await _electron.launch({
  args: [".", "--use-mock-keychain"],
  cwd: root,
  env: { ...process.env, CAPTURIA_USER_DATA: userData },
});

// Registration snapshot straight from main's globalShortcut.
const registrations = () =>
  app.evaluate(({ globalShortcut }) => ({
    digit1: globalShortcut.isRegistered("CommandOrControl+Alt+1"),
    digit2: globalShortcut.isRegistered("CommandOrControl+Alt+2"),
    digit3: globalShortcut.isRegistered("CommandOrControl+Alt+3"),
    next: globalShortcut.isRegistered("CommandOrControl+Alt+Right"),
    voice: globalShortcut.isRegistered("CommandOrControl+Alt+Space"),
  }));

// Locate the visible Control Room window (not the offscreen ?out=1 one).
const controlRoom = await waitFor(
  "the Control Room window",
  async () => {
    const all = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({ id: w.id, url: w.webContents.getURL() }))
    );
    return all.find((w) => w.url.includes("/studio") && !w.url.includes("out=1")) ?? null;
  },
  30_000
);
console.log(`[hotkey-e2e] control room: ${controlRoom.url}`);

const inControlRoom = (js) =>
  app.evaluate(
    ({ BrowserWindow }, { id, code }) =>
      BrowserWindow.fromId(id).webContents.executeJavaScript(code, true),
    { id: controlRoom.id, code: js }
  );

// Gate 1: pre-deck, nothing is squatted; the voice hotkey exists as usual.
// Wait for the page's first state:report (the voice hotkey registers earlier,
// at whenReady) so a slow renderer can't fake a pass.
await waitFor("the studio's capturiaDrive hook", () => inControlRoom("Boolean(window.capturiaDrive)"), 30_000);
const before = await registrations();
if (before.digit1 || before.digit2 || before.next) {
  fail(`cue shortcuts registered with no deck loaded: ${JSON.stringify(before)}`);
}
if (!before.voice) fail("the voice hotkey is not registered at startup");
console.log("[hotkey-e2e] no deck: no cue shortcuts bound");

// Gate 2: deck loads -> digits register up to the deck size, plus Right.
if (!(await inControlRoom(DRIVE_CUES_JS(CARDS)))) fail("could not drive cues into the studio");
const bound = await waitFor(
  "cue shortcuts to register after deck load",
  async () => {
    const r = await registrations();
    return r.digit1 && r.digit2 && r.next ? r : null;
  },
  15_000
);
if (bound.digit3) fail("Alt+3 registered for a 2-card deck (digits must track deck size)");
if (!bound.voice) fail("the voice hotkey disappeared when the cue shortcuts registered");
console.log("[hotkey-e2e] deck loaded: digits 1..2 + Right bound, Alt+3 free, voice intact");

// Gate 3: presses land cards, and a repeat burst lands ONE. Simulated on the
// "hotkey" channel because a real OS-level keypress cannot be synthesized
// here; the messages are byte-identical to what the globalShortcut callbacks
// send. The back-to-back pair models Windows RegisterHotKey's WM_HOTKEY
// auto-repeat stream: the renderer's sliding 150ms debounce must collapse it
// into one fire, or a held combo would walk the whole deck onto the feed.
const landed = (name) =>
  inControlRoom(`Boolean(document.body && document.body.innerText.includes(${JSON.stringify(name)}))`);
await app.evaluate(
  ({ BrowserWindow }, { id }) => {
    const wc = BrowserWindow.fromId(id).webContents;
    wc.send("hotkey", { action: "fire-cue-next" });
    wc.send("hotkey", { action: "fire-cue-next" });
  },
  { id: controlRoom.id }
);
await waitFor("card 1's overlay after the next press", () => landed("Desktop Hotkey Proof 1"), 10_000);
// Give a wrongly-accepted second fire time to render before asserting.
await new Promise((r) => setTimeout(r, 400));
if (await landed("Desktop Hotkey Proof 2")) {
  fail("a repeat press inside the debounce window fired a second card");
}
console.log("[hotkey-e2e] next-press burst fired exactly one card");
// A distinct combo after the window: the digit press for card 2 proves both
// the digit path and that different combos are not debounced against "next".
await app.evaluate(
  ({ BrowserWindow }, { id }) =>
    BrowserWindow.fromId(id).webContents.send("hotkey", { action: "fire-cue", index: 1 }),
  { id: controlRoom.id }
);
await waitFor("card 2's overlay after the digit press", () => landed("Desktop Hotkey Proof 2"), 10_000);
console.log("[hotkey-e2e] digit fired card 2");

// Gate 4: deck clears -> every cue shortcut unregisters, voice remains.
if (!(await inControlRoom(DRIVE_CUES_JS([])))) fail("could not clear the driven cues");
await waitFor(
  "cue shortcuts to unregister after deck clear",
  async () => {
    const r = await registrations();
    return !r.digit1 && !r.digit2 && !r.next && r.voice;
  },
  15_000
);
console.log("[hotkey-e2e] deck cleared: cue shortcuts released, voice intact");

// Quit cleanly (app.quit walks before-quit/will-quit, releasing shortcuts).
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
console.log(`[hotkey-e2e] clean exit (code ${code})`);
console.log("[hotkey-e2e] PASS");
