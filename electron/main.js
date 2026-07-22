// Capturia desktop wrapper. Loads the studio in a BrowserWindow and hosts the
// CopilotKit runtime on a loopback server (electron/runtime-server.js), so
// the BYOK key stays in main and the packaged app needs no Next server.
// In dev: the UI comes from http://localhost:3000/studio (Next dev server).
// In prod: the UI is the static export at out/studio.html (npm run
// build:electron). CAPTURIA_STATIC_UI=1 forces the static UI while unpackaged
// to smoke-test the export; CAPTURIA_SMOKE=1 additionally runs headless-ish
// (hidden window, no media permission) and exits with a pass/fail code.

const {
  app,
  BrowserWindow,
  dialog,
  session,
  globalShortcut,
  ipcMain,
  shell,
} = require("electron");
const path = require("path");
const { transcribeWav } = require("./whisper");
const keychain = require("./keychain");
const deckGen = require("./deck-generate");
const { startRuntimeServer, loadDevEnvFiles } = require("./runtime-server");
const { createHostedBilling } = require("./hosted-billing");
// Vault-clear routing decision, pinned by lib/hosted-billing.test.ts. Plain
// require (no degrade path): ./hosted-billing above already hard-requires
// this same gen module.
const { classifyVaultClear } = require("./gen/hosted-billing");
const { createTray } = require("./tray");
const { logCrash, crashLogPath } = require("./crash-log");
const { maybeOfferMoveToApplications, offerMoveToApplications } = require("./first-run");
const { createTelemetry, readSettings, writeSettings } = require("./telemetry");
const { normalizeVoiceLocale, appleSpeechLocale } = require("./gen/voice-locale");
const { normalizeCameraPreference } = require("./gen/camera-select");
const speechHelper = require("./speech-helper");
const {
  isTrustedSender,
  isAllowedUrl,
  assertProvider,
  assertNonEmptyString,
  assertBytes,
  assertStateReport,
} = require("./ipc-schemas");

// Webcam control script for the hidden Control Room (see below). Same
// degrade-not-crash posture as the other electron/gen consumers: without the
// gen build the hidden window simply keeps its capture (the old behavior).
let webcamControlScript = null;
try {
  ({ webcamControlScript } = require("./gen/camera-feed"));
} catch {
  // electron/gen not built; camera-feed.js will log the actionable message.
}

// Push-to-talk hotkey. Cmd+Alt+Space on Mac, Ctrl+Alt+Space elsewhere.
// Chosen to avoid Spotlight (Cmd+Space) and the macOS character viewer.
const HOTKEY_TOGGLE_VOICE = "CmdOrCtrl+Alt+Space";

// Silent cue-card hotkeys: Cmd/Ctrl+Alt+<digit> fires the deck rail card at
// that position, Cmd/Ctrl+Alt+Right fires the renderer's next-unfired card.
// Global on purpose (the presenter is focused on Zoom, not Capturia), but
// registered ONLY while the renderer reports a loaded deck (state:report
// carries cueCount) and only up to the deck's size, so an empty studio never
// squats on nine system-wide combos. Cmd+Alt avoids everything the app
// already binds (Cmd+Alt+Space above, in-page Cmd+Shift+O / Cmd+Shift+A /
// Cmd+,) and the OS-default Cmd+1..9 tab switching, which is Cmd-only.
const CUE_HOTKEY_MAX = 9;
const CUE_NEXT_HOTKEY = "CmdOrCtrl+Alt+Right";
const cueHotkey = (index) => `CmdOrCtrl+Alt+${index + 1}`;
// How many digit shortcuts are currently registered; 0 means the next-card
// shortcut is unbound too.
let cueHotkeysBound = 0;

const isDev = !app.isPackaged;
const isSmoke = process.env.CAPTURIA_SMOKE === "1";
// Dev-only: test harnesses (scripts/e2e-desktop-hotkeys.mjs) point userData
// at a throwaway directory so a headed run never contends with a real
// install's single-instance lock (the lock is scoped to userData, which the
// unpackaged shell otherwise SHARES with an installed Capturia.app) and
// never touches its profile. Must run before the lock request below.
if (isDev && process.env.CAPTURIA_USER_DATA) {
  app.setPath("userData", process.env.CAPTURIA_USER_DATA);
}
// Smoke runs must never block on a macOS keychain consent: Chromium's network
// service opens the "<app> Safe Storage" keychain item at startup, and when a
// DIFFERENTLY SIGNED build of the same app touched it first (dev shell vs
// packaged app on one machine) that read hangs the whole main process on a
// user prompt. The mock keychain skips OSCrypt entirely; smoke saves no keys
// and keeps no cookies, so nothing of value gets encrypted with the mock key.
if (isSmoke) app.commandLine.appendSwitch("use-mock-keychain");
const useStaticUi = !isDev || isSmoke || process.env.CAPTURIA_STATIC_UI === "1";
const STUDIO_URL = useStaticUi
  ? `file://${path.join(__dirname, "../out/studio.html")}`
  : "http://localhost:3000/studio";
// Trust follows the UI source, not packaging: a static (file://) UI must be
// trusted as file: even while unpackaged, or IPC/permissions would reject the
// very renderer we loaded (isAllowedUrl trusts localhost in "dev" and file:
// otherwise).
const trustOpts = { isDev: !useStaticUi };

let mainWindow = null;
// Set once the loopback CopilotKit runtime is up; null means it failed. The
// dev renderer then falls back to /api/copilotkit (which Next serves), while
// the static (file://) UI has no such route: runtime:info reports an explicit
// disabled state instead, and the restart flow below owns recovery.
let runtimeServer = null;
// The virtual-camera feed (electron/camera-feed.js): the offscreen Program
// Output window pumping frames into the Capturia CMIO extension's sink. null
// when the module could not load (electron/gen not built).
let cameraFeed = null;
// In-app camera-extension activation (electron/sysext.js): the packaged app
// installing its own embedded CMIO extension. null when the module could not
// load; it internally reports "unsupported" for builds that cannot request
// activation (dev shell, unsigned pack), which hides the install UI.
let sysext = null;
// Menu-bar tray; created in whenReady, rebuilt whenever renderer state lands.
let tray = null;
// Closing the Control Room hides it to the tray; only a real quit (Cmd+Q,
// tray Quit, app menu) tears the window down. before-quit flips this.
let isQuitting = false;
// Last state the studio renderer reported (drives the tray status + toggle
// plus the cue-hotkey registration). reported=false until the first
// state:report of this launch.
let rendererState = { reported: false, listening: false, voiceSupported: false, cueCount: 0 };
// A tray action aimed at a renderer that hasn't mounted its listeners yet
// (e.g. Settings clicked during startup) would be a silently dropped message;
// it parks here and flushes on the next state:report, which can only come
// from a mounted page.
let pendingRendererAction = null;
// Capturia Pro billing (electron/hosted-billing.js): checkout, activation,
// and the JWT refresh loop. Created in registerIpc (it shares the deck
// codegen effective env) and started after boot.
let hostedBilling = null;
// Anonymous usage beacon (electron/telemetry.js, docs/telemetry.md): four
// fields, opt-out, fire-and-forget. Hard-disabled in smoke mode so
// unattended gate runs never pollute production counters. Created after the
// CAPTURIA_USER_DATA override above so the settings store lands in the same
// profile the run uses.
const telemetry = createTelemetry({ disabled: isSmoke });

// Main-process crash visibility (issue #51): without these, an escaped throw
// or orphaned rejection in main dies in a console nobody attached. Log and
// keep the shell alive: main hosts the virtual camera mid-call, so
// degrade-and-log beats the default hard exit (registering uncaughtException
// deliberately replaces it). At module load so even whenReady failures land.
process.on("uncaughtException", (err) => {
  logCrash({
    source: "main",
    reason: "uncaughtException",
    detail: (err && err.stack) || String(err),
  });
});
process.on("unhandledRejection", (reason) => {
  logCrash({
    source: "main",
    reason: "unhandledRejection",
    detail: (reason && reason.stack) || String(reason),
  });
});

// Parent failure dialogs on the Control Room only while it is visible; a
// sheet attached to a window hidden to the tray never reaches the screen,
// so hidden (and early-startup) dialogs stand alone instead.
function showFailureDialog(options) {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

// Every failure dialog ends by pointing at the local crash log, the only
// evidence trail there is (no third-party crash service without consent).
function withLogHint(text) {
  const file = crashLogPath();
  return file ? `${text}\n\nDetails logged to: ${file}` : text;
}

// Wrap every privileged IPC handler so it first rejects calls from an
// untrusted sender (a navigated-away or injected renderer), then runs the
// handler. Errors propagate back to the renderer's invoke() as a rejection.
function guarded(handler) {
  return async (event, ...args) => {
    if (!isTrustedSender(event, trustOpts)) {
      throw new Error("Capturia: IPC rejected from an untrusted sender.");
    }
    return handler(event, ...args);
  };
}

function registerIpc() {
  // Renderer → main: transcribe an in-memory WAV buffer with local whisper.
  ipcMain.handle(
    "whisper:transcribe",
    guarded((_event, wavBuffer) => transcribeWav(assertBytes(wavBuffer, "WAV")))
  );

  // Encrypted BYOK key vault. The plaintext key never leaves main: the
  // renderer only names a provider, and the runtime server reads the key from
  // the keychain itself (there is deliberately no keys:get anymore).
  ipcMain.handle(
    "keys:save",
    guarded((_event, payload) => {
      const provider = assertProvider(payload && payload.provider);
      const key = assertNonEmptyString(payload && payload.key, "Key");
      keychain.saveKey(provider, key);
      return keychain.listKeys();
    })
  );
  ipcMain.handle(
    "keys:clear",
    guarded((_event, provider) => {
      const named = assertProvider(provider);
      // Clearing the Pro row is a local deactivation: the refresh token and
      // its pending timer must go with the JWT, or the refresh loop would
      // quietly re-mint what the user just cleared (the why lives with
      // classifyVaultClear in lib/hosted-billing.ts). With billing missing
      // the row degrades to a plain key delete, as before.
      if (classifyVaultClear(named) === "deactivate_hosted" && hostedBilling) {
        hostedBilling.deactivateLocal();
      } else {
        keychain.clearKey(named);
      }
      return keychain.listKeys();
    })
  );
  ipcMain.handle("keys:list", guarded(() => keychain.listKeys()));

  // Renderer -> main: where the loopback CopilotKit runtime listens this
  // launch (URL + per-launch bearer token). With the server down the answer
  // depends on the UI source: the dev renderer gets null and stays on the
  // Next-served /api/copilotkit route, but the static (file://) renderer has
  // no such route, so it gets an explicit disabled marker instead of a
  // fallback URL that cannot work (issue #51).
  ipcMain.handle(
    "runtime:info",
    guarded(() => {
      if (runtimeServer) return { url: runtimeServer.url, token: runtimeServer.token };
      return useStaticUi ? { disabled: true } : null;
    })
  );

  // Deck codegen on the user's key, in main. Returns raw model text (JSON the
  // renderer validates). The prompt is built in the renderer (lib/deck/prompt).
  // Codegen sees the SAME effective env as the runtime server (dev .env files
  // merged under the OS environment), so a dev CAPTURIA_HOSTED_URL override
  // applies to both hosted call paths and the vault token can never be sent
  // to production by only one of them.
  let deckEnvCache = null;
  const deckCodegenEnv = () => {
    if (!deckEnvCache) {
      deckEnvCache = isDev
        ? { ...loadDevEnvFiles(path.join(__dirname, "..")), ...process.env }
        : process.env;
    }
    return deckEnvCache;
  };
  ipcMain.handle(
    "deck:generate",
    guarded((_event, payload) => {
      const provider = assertProvider(payload && payload.provider);
      const prompt = assertNonEmptyString(payload && payload.prompt, "Prompt");
      return deckGen.generateCues(prompt, provider, deckCodegenEnv());
    })
  );

  // Capturia Pro upgrade flow (M11 slice 2). Billing shares the deck
  // codegen effective env so a dev CAPTURIA_HOSTED_URL override points
  // checkout, activation, and token refresh at the same server as the
  // proxy. The renderer only ever sees { ok, devices } or an error message;
  // tokens live in the keychain and travel main -> proxy only.
  hostedBilling = createHostedBilling({ keychain, env: deckCodegenEnv() });
  hostedBilling.start();
  ipcMain.handle(
    "billing:checkout",
    guarded(async () => {
      const url = await hostedBilling.startCheckout();
      await shell.openExternal(url);
      return { ok: true };
    })
  );
  ipcMain.handle(
    "billing:activate",
    guarded((_event, payload) => {
      const code = assertNonEmptyString(payload && payload.code, "Activation code");
      return hostedBilling.activate(code);
    })
  );
  // No payload to validate (the call carries none); guarded() gates the
  // caller and main authenticates with the keychain JWT itself.
  ipcMain.handle(
    "billing:usage",
    guarded(() => hostedBilling.getUsage())
  );
  // Server-side seat release only: the renderer follows up with the normal
  // keys:clear("capturia-hosted"), which routes to deactivateLocal above, so
  // the vault clear has exactly one path (issue #10 self-serve deactivation).
  ipcMain.handle(
    "billing:deactivate",
    guarded(() => hostedBilling.deactivateRemote())
  );
  // Stripe customer portal (issue #48): like checkout, the URL opens in the
  // OS browser from main and never crosses to the renderer; getPortalUrl
  // enforces https before shell.openExternal sees anything.
  ipcMain.handle(
    "billing:portal",
    guarded(async () => {
      const url = await hostedBilling.getPortalUrl();
      await shell.openExternal(url);
      return { ok: true };
    })
  );

  // On-device streaming speech (macOS 26+ helper). One session at a time;
  // events flow back over the "speech" channel. Availability is a cheap
  // sync check the renderer uses to pick its engine.
  ipcMain.handle("speech:available", guarded(() => speechHelper.isAppleSpeechAvailable()));
  ipcMain.handle(
    "speech:start",
    guarded((event, locale) => {
      const sender = event.sender;
      // Tag every forwarded event with its session id: a restart overlaps
      // the old session's trailing finals/done with the new session's
      // stream on the same channel, and the renderer must be able to tell
      // them apart (an untagged stale "done" would clobber the live
      // session's id and orphan the mic).
      let sessionId;
      sessionId = speechHelper.startSpeechSession({
        // Whatever the renderer sends lands on a curated language in the
        // helper's underscore form; a stale or hostile payload cannot put
        // an arbitrary string on the helper's command line.
        locale: appleSpeechLocale(locale),
        onEvent: (e) => {
          if (!sender.isDestroyed()) sender.send("speech", { ...e, sessionId });
        },
      });
      return sessionId;
    })
  );
  ipcMain.handle(
    "speech:stop",
    guarded((_event, id) => {
      if (typeof id === "number") speechHelper.stopSpeechSession(id);
    })
  );

  // Virtual camera: feed state for the renderer, plus start/stop. No payloads
  // to validate (the calls carry none); guarded() gates the callers. null when
  // the camera module is unavailable, which callers must treat as "no camera".
  ipcMain.handle("camera:state", guarded(() => (cameraFeed ? cameraFeed.getState() : null)));
  ipcMain.handle("camera:start", guarded(() => (cameraFeed ? cameraFeed.start() : null)));
  ipcMain.handle("camera:stop", guarded(() => (cameraFeed ? cameraFeed.stop() : null)));

  // Camera-extension activation: status for the renderer plus the install
  // trigger. Same shape as camera:* (no payloads, guarded callers, null when
  // the module is unavailable). state kicks a background refresh so a stale
  // systemextensionsctl read self-corrects on the next push.
  ipcMain.handle(
    "sysext:state",
    guarded(() => {
      if (!sysext) return null;
      void sysext.refresh();
      return sysext.getState();
    })
  );
  ipcMain.handle("sysext:install", guarded(() => (sysext ? sysext.install() : null)));

  // Telemetry toggle for the Settings modal and onboarding: read the current
  // state, or set it. The renderer only ever sees the boolean; the installId
  // and the sending itself stay in main (electron/telemetry.js).
  ipcMain.handle("telemetry:get", guarded(() => ({ enabled: telemetry.isEnabled() })));
  ipcMain.handle(
    "telemetry:set",
    guarded((_event, enabled) => {
      if (typeof enabled !== "boolean") {
        throw new Error("Capturia: telemetry:set expects a boolean.");
      }
      return { enabled: telemetry.setEnabled(enabled) };
    })
  );
  // Renderer -> main: the onboarding disclosure was resolved (welcome step
  // dismissed with the toggle state known, or onboarding already completed
  // in an earlier session). Releases the first-run consent gate holding the
  // launch ping (electron/telemetry.js); idempotent on later runs.
  ipcMain.handle("telemetry:ack", guarded(() => ({ enabled: telemetry.ackDisclosure() })));

  // Voice recognition language (issue #53): the renderer reads and sets the
  // canonical BCP-47 tag; it persists in the same userData/settings.json as
  // the telemetry consent. Both directions run through the curated-list
  // normalizer, so a hand-edited or stale file can only ever yield a tag the
  // speech engines actually support.
  ipcMain.handle(
    "voice-locale:get",
    guarded(() => ({ locale: normalizeVoiceLocale(readSettings().voiceLocale) }))
  );
  ipcMain.handle(
    "voice-locale:set",
    guarded((_event, tag) => {
      if (typeof tag !== "string") {
        throw new Error("Capturia: voice-locale:set expects a string.");
      }
      const locale = normalizeVoiceLocale(tag);
      writeSettings({ voiceLocale: locale });
      return { locale };
    })
  );

  // Camera pick (issue #12): the renderer reads and sets the persisted
  // {deviceId, label} the stage should capture; null means automatic (the
  // physical-input heuristic). Normalized both ways so a hand-edited
  // settings.json can never aim the stage at the Capturia camera itself. A
  // set is pushed straight into the offscreen Program Output page, so the
  // published feed re-aims live without a camera restart.
  ipcMain.handle(
    "camera-device:get",
    guarded(() => ({ preference: normalizeCameraPreference(readSettings().cameraDevice) }))
  );
  ipcMain.handle(
    "camera-device:set",
    guarded((_event, raw) => {
      const preference = normalizeCameraPreference(raw);
      if (raw !== null && preference === null) {
        throw new Error("Capturia: camera-device:set expects { deviceId, label } or null.");
      }
      writeSettings({ cameraDevice: preference });
      cameraFeed?.applyCameraDevice();
      return { preference };
    })
  );

  // Renderer -> main: voice state for the tray (listening on/off, whether the
  // speech engine exists) plus the loaded deck size for the cue hotkeys.
  // Fire-and-forget from the renderer's point of view.
  ipcMain.handle(
    "state:report",
    guarded((_event, payload) => {
      rendererState = { reported: true, ...assertStateReport(payload) };
      tray?.update();
      syncCueHotkeys(rendererState.cueCount);
      // The reporting page is mounted and listening on the hotkey channel,
      // so a parked tray action can be delivered now.
      if (pendingRendererAction) {
        const action = pendingRendererAction;
        pendingRendererAction = null;
        mainWindow?.webContents.send("hotkey", { action });
      }
    })
  );
}

// Reconcile the registered cue shortcuts with the deck the renderer reports:
// digits 1..min(cueCount, 9) plus the next-card arrow while any digit is
// bound. Idempotent per count, so every state:report can call it. A combo
// another app owns fails register() and just logs; the renderer's in-page
// fallback still covers the focused-window case.
function syncCueHotkeys(cueCount) {
  const target = Math.max(0, Math.min(CUE_HOTKEY_MAX, Number.isInteger(cueCount) ? cueCount : 0));
  if (target === cueHotkeysBound) return;
  for (let i = target; i < cueHotkeysBound; i++) globalShortcut.unregister(cueHotkey(i));
  for (let i = cueHotkeysBound; i < target; i++) {
    const index = i;
    const ok = globalShortcut.register(cueHotkey(index), () => {
      mainWindow?.webContents.send("hotkey", { action: "fire-cue", index });
    });
    if (!ok) console.warn(`Failed to register cue hotkey ${cueHotkey(index)} (in use?)`);
  }
  if (cueHotkeysBound === 0 && target > 0) {
    const ok = globalShortcut.register(CUE_NEXT_HOTKEY, () => {
      mainWindow?.webContents.send("hotkey", { action: "fire-cue-next" });
    });
    if (!ok) console.warn(`Failed to register cue hotkey ${CUE_NEXT_HOTKEY} (in use?)`);
  } else if (target === 0) {
    globalShortcut.unregister(CUE_NEXT_HOTKEY);
  }
  cueHotkeysBound = target;
}

// Deliver a UI action to the renderer, or park it until the page proves it is
// mounted (its first state:report) when it isn't yet.
function sendRendererAction(action) {
  if (rendererState.reported && mainWindow) {
    mainWindow.webContents.send("hotkey", { action });
  } else {
    pendingRendererAction = action;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#000000",
    title: "Capturia",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The whole point of the app is to keep listening and rendering while
      // hidden behind Zoom; never let Chromium throttle the hidden renderer.
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Navigation lockdown: never let the renderer navigate away from the studio
  // origin, and never spawn in-app windows. External links open in the user's
  // real browser instead (CVE-2026-34765: unscoped window.open is a risk).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedUrl(url, trustOpts)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    if (!isSmoke) mainWindow?.show();
  });

  // Menu-bar-first: closing the Control Room hides it (the shell keeps
  // listening from the tray); only a real quit destroys it. Smoke mode keeps
  // real closes so app.exit paths stay untouched, and if the tray failed to
  // come up there is nothing to reopen from, so close means close.
  mainWindow.on("close", (event) => {
    if (isQuitting || isSmoke || !tray) return;
    event.preventDefault();
    // Hiding a native-fullscreen window strands an empty fullscreen Space on
    // macOS; leave fullscreen first, hide once that lands.
    if (mainWindow.isFullScreen()) {
      mainWindow.once("leave-full-screen", () => mainWindow?.hide());
      mainWindow.setFullScreen(false);
    } else {
      mainWindow.hide();
    }
  });

  // Privacy: the Control Room's webcam preview (components/WebcamFeed.tsx)
  // holds the PHYSICAL webcam, and close-to-tray hides the window without
  // unmounting the page, so without this the green camera LED stays lit for
  // an app nobody can see (issue #38). backgroundThrottling:false keeps the
  // hidden page's visibilityState "visible", so the page cannot detect the
  // hide itself; main tells it through the same executeJavaScript contract
  // the offscreen camera window uses. The offscreen feed is independent: it
  // idles on the extension's consumer count (electron/camera-feed.js), so
  // hiding the window never blanks a live call.
  const sendWebcamControl = (paused) => {
    if (!webcamControlScript || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.executeJavaScript(webcamControlScript(paused)).catch(() => {});
  };
  mainWindow.on("hide", () => sendWebcamControl(true));
  mainWindow.on("show", () => sendWebcamControl(false));
  // A page (re)loaded while the window is hidden must not relight the LED;
  // the injected flag lands before React mounts the preview.
  mainWindow.webContents.on("did-finish-load", () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      sendWebcamControl(true);
    }
  });

  // A crashed or reloaded renderer is not listening anymore: drop its last
  // report so the tray falls back to "starting" (toggle disabled) until the
  // fresh page reports, instead of advertising a mic loop that is gone.
  // did-navigate covers main-frame loads only, including reloads.
  const resetRendererState = () => {
    rendererState = { reported: false, listening: false, voiceSupported: false, cueCount: 0 };
    tray?.update();
    // The deck that justified the cue shortcuts is gone with the page.
    syncCueHotkeys(0);
    // The page that owned the mic session is gone; without this a reload
    // mid-session leaves the helper capturing with nothing able to stop it.
    speechHelper.stopAllSpeechSessions();
  };
  mainWindow.webContents.on("render-process-gone", resetRendererState);
  mainWindow.webContents.on("did-navigate", resetRendererState);

  // Crash surfacing for the same event (issue #51): the reset above keeps the
  // tray honest, this keeps the USER in the loop instead of a dead window.
  // clean-exit is a normal teardown, not a crash. Reload reuses this same
  // webContents, so the navigation lockdown above stays in force. No dialogs
  // in smoke mode (its gates already turn a dead renderer into a FAIL exit)
  // or mid-quit (a renderer killed by the teardown must not block the exit).
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    logCrash({
      source: "renderer",
      reason: details.reason,
      detail: `exit code ${details.exitCode}`,
    });
    if (isSmoke || isQuitting) return;
    void showFailureDialog({
      type: "warning",
      buttons: ["Reload", "Quit Capturia"],
      defaultId: 0,
      cancelId: 0,
      message: "The Capturia window crashed",
      detail: withLogHint(
        `The studio page ended unexpectedly (${details.reason}). Reload to pick up where the session left off.`
      ),
    }).then(({ response }) => {
      if (response === 1) app.quit();
      else mainWindow?.webContents.reload();
    });
  });

  // A hung page may recover on its own (a long GC, a wedged await), so Wait
  // is the default; Reload is the way out when it does not. One dialog at a
  // time: the event re-fires while the page stays hung.
  let unresponsiveDialogOpen = false;
  mainWindow.on("unresponsive", () => {
    logCrash({ source: "renderer", reason: "unresponsive" });
    if (isSmoke || isQuitting || unresponsiveDialogOpen) return;
    unresponsiveDialogOpen = true;
    void showFailureDialog({
      type: "warning",
      buttons: ["Wait", "Reload"],
      defaultId: 0,
      cancelId: 0,
      message: "Capturia is not responding",
      detail: withLogHint(
        "The studio window stopped responding. It may recover on its own; reloading restarts the page."
      ),
    }).then(({ response }) => {
      unresponsiveDialogOpen = false;
      if (response === 1) mainWindow?.webContents.reload();
    });
  });

  // A failed main-frame load in the packaged app (broken update, disk issue)
  // used to be an indistinguishable black window: log it and offer the load
  // again. -3 (ERR_ABORTED) is a superseded navigation, not a failure. Dev
  // fails here when the Next server is down, which its console already
  // covers, and smoke exits through its own did-fail-load gate below.
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, failedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      logCrash({ source: "window-load", reason: `${code} ${description}`, detail: failedUrl });
      if (isSmoke || isQuitting || !useStaticUi) return;
      void showFailureDialog({
        type: "warning",
        buttons: ["Retry", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: "Capturia could not load its window",
        detail: withLogHint(
          `The studio page failed to load (${description}). Retry reloads it; if this keeps happening, reinstall Capturia.`
        ),
      }).then(({ response }) => {
        if (response === 0) mainWindow?.loadURL(STUDIO_URL);
      });
    }
  );

  // Dock icon only while the Control Room is open (the Krisp pattern): the
  // app lives in the menu bar, the dock entry exists for Cmd+Tab while the
  // window is up. app.dock is macOS-only.
  mainWindow.on("show", () => {
    app.dock?.show();
  });
  mainWindow.on("hide", () => {
    app.dock?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // A real destroy (the no-tray degrade path, where close means close, or
    // any other genuine teardown) takes the page and its deck with it, but
    // macOS keeps the app alive after the last window: without this reset
    // the cue shortcuts would stay registered system-wide with no renderer
    // to receive them, silently swallowing those combos in every other app.
    resetRendererState();
  });

  // Smoke mode: prove the static export + bridge + loopback runtime work end
  // to end, then exit. Checks, from inside the page: the preload bridge is up,
  // the page's own JS bundle executed (window.capturiaCatalog is set at studio
  // module load, so broken file:// asset paths fail here), and a real fetch to
  // the runtime with the bridge-provided URL + token answers the keycheck
  // (which also exercises CORS from the file:// origin). With
  // CAPTURIA_SMOKE_CAMERA=1 (opt-in: it needs the extension installed AND
  // approved, so unattended runs on other machines stay deterministic) the
  // smoke additionally proves the whole packaged camera stack: the addon
  // loads, the offscreen Program Output paints, the sink connects, and frames
  // actually pump.
  if (isSmoke) {
    const smokeJs = `
      new Promise((resolve) => {
        const t0 = Date.now();
        (function poll() {
          if (window.capturiaCatalog) return resolve(true);
          if (Date.now() - t0 > 15000) return resolve(false);
          setTimeout(poll, 200);
        })();
      }).then(async (bundleRan) => {
        const raw = window.capturia && window.capturia.runtimeInfo
          ? await window.capturia.runtimeInfo()
          : null;
        // The disabled marker (runtime down on the static UI) is not a usable
        // endpoint; only a real URL feeds the keycheck that proves AI works.
        const info = raw && raw.url ? raw : null;
        let keycheck = null;
        if (info) {
          const r = await fetch(info.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-capturia-token": info.token },
            body: JSON.stringify({ method: "capturia-keycheck" }),
          });
          keycheck = { status: r.status, body: await r.json() };
        }
        return { bundleRan, hasBridge: Boolean(window.capturia), info: Boolean(info), keycheck };
      })
    `;
    // The camera leg of the smoke. Resolves {ok, ...evidence}; never rejects.
    // Waits for delivered frames, not just a connected sink, so a pump that
    // connects and immediately starves still fails. dispose() runs before
    // app.exit (which skips will-quit) so the sink is handed back cleanly and
    // the extension's splash resumes after every run.
    const smokeCamera = () =>
      new Promise((resolve) => {
        if (!cameraFeed) return resolve({ ok: false, reason: "camera module unavailable" });
        const t0 = Date.now();
        cameraFeed.start();
        (function poll() {
          const state = cameraFeed.getState();
          if (state.running && state.pumped > 0) {
            return resolve({ ok: true, pumped: state.pumped, fps: state.fps });
          }
          if (state.error) return resolve({ ok: false, reason: state.error });
          if (Date.now() - t0 > 45000) {
            return resolve({ ok: false, reason: "timeout", state });
          }
          setTimeout(poll, 500);
        })();
      });
    // The extension-activation leg of the smoke. Base mode is read-only: it
    // reports the state mapping for this machine (a machine with the
    // extension enabled must read "installed" without any request firing).
    // CAPTURIA_SMOKE_SYSEXT_ACTIVATE=1 additionally drives a REAL activation
    // request (force: the extension being enabled must not short-circuit the
    // path under test) and reports the raw delegate outcome; a request that
    // parks on the System Settings approval reports requiresApproval and
    // stops there, per the OS contract that only the user can approve.
    const smokeSysext = () =>
      new Promise((resolve) => {
        if (!sysext) return resolve({ ok: false, reason: "sysext module unavailable" });
        // ready settles the async build-capability probe first, so the
        // reported status is truthful, not a race with codesign.
        void sysext.ready.then(() => sysext.refresh()).then((state) => {
          if (process.env.CAPTURIA_SMOKE_SYSEXT_ACTIVATE !== "1") {
            return resolve({ ok: typeof state.status === "string", ...state });
          }
          const events = [];
          let settled = false;
          const done = (extra) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // ok stays the FIRST key (spread overwrites the value in place)
            // so the runner's `"sysext":{"ok":true` evidence check holds in
            // activate mode too.
            resolve({ ok: false, statusBefore: state.status, events, ...extra });
          };
          const timer = setTimeout(() => done({ ok: false, reason: "activation timeout" }), 60000);
          sysext.install({
            force: true,
            onEvent: (event) => {
              events.push(event);
              if (event.phase === "completed") {
                void sysext.refresh().then((after) => done({ ok: true, ...after }));
              } else if (event.phase === "needsApproval") {
                done({ ok: true, requiresApproval: true });
              } else if (event.phase === "failed" || event.phase === "not-started") {
                done({ ok: false, ...event });
              }
            },
          });
        });
      });
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(smokeJs);
        let pass =
          result.bundleRan && result.hasBridge && result.info && result.keycheck?.status === 200;
        if (pass && process.env.CAPTURIA_SMOKE_SYSEXT === "1") {
          result.sysext = await smokeSysext();
          pass = result.sysext.ok;
        }
        if (pass && process.env.CAPTURIA_SMOKE_CAMERA === "1") {
          result.camera = await smokeCamera();
          cameraFeed?.dispose();
          pass = result.camera.ok;
        }
        console.log(`[smoke] ${JSON.stringify(result)}`);
        console.log(pass ? "[smoke] PASS" : "[smoke] FAIL");
        app.exit(pass ? 0 : 1);
      } catch (err) {
        console.error("[smoke] FAIL:", err);
        app.exit(1);
      }
    });
    mainWindow.webContents.once("did-fail-load", (_event, code, desc) => {
      console.error("[smoke] FAIL did-fail-load:", code, desc);
      app.exit(1);
    });
  }

  mainWindow.loadURL(STUDIO_URL);
}

// Start the loopback CopilotKit runtime with ONE silent retry: a transient
// bind or env hiccup should not cost the launch its AI. A second failure
// lands in the crash log (the dialog points there) and resolves null, the
// explicit no-runtime state runtime:info hands the renderer.
async function startRuntimeWithRetry() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await startRuntimeServer({ keychain, isDev });
    } catch (err) {
      console.error("Capturia: runtime server failed to start:", err);
      if (attempt === 1) {
        logCrash({
          source: "runtime-server",
          reason: "start failed after retry",
          detail: (err && err.stack) || String(err),
        });
      }
    }
  }
  return null;
}

// Re-attempt a failed runtime start (the failure dialog's Retry, the tray's
// Restart AI engine; one attempt at a time because those two can race). On
// success the studio window reloads so the fresh page picks up the working
// URL over runtime:info; the reload reuses the same webContents, so the
// navigation lockdown from createWindow stays in force. On another failure
// the dialog returns, so the outcome is never silent.
let runtimeRestartInFlight = false;
async function restartRuntime() {
  if (runtimeRestartInFlight || runtimeServer) return;
  runtimeRestartInFlight = true;
  try {
    runtimeServer = await startRuntimeWithRetry();
  } finally {
    runtimeRestartInFlight = false;
  }
  tray?.update();
  if (runtimeServer) {
    mainWindow?.webContents.reload();
  } else {
    void offerRuntimeRestart();
  }
}

// The honest no-AI dialog: what broke, what still works, and both ways out.
// Continue without AI needs no work here because the renderer already holds
// the explicit disabled state from runtime:info. One copy at a time: a tray
// retry failing while the startup dialog waits must not stack a second one.
let runtimeDialogOpen = false;
async function offerRuntimeRestart() {
  if (runtimeDialogOpen) return;
  runtimeDialogOpen = true;
  let response;
  try {
    ({ response } = await showFailureDialog({
      type: "warning",
      buttons: ["Retry", "Continue without AI"],
      defaultId: 0,
      cancelId: 1,
      message: "The AI engine failed to start",
      detail: withLogHint(
        "Voice commands and overlays are unavailable. The webcam, cue-card " +
          "hotkeys, and virtual camera still work. Retry now, or later via " +
          "Restart AI engine in the menu bar."
      ),
    }));
  } finally {
    runtimeDialogOpen = false;
  }
  if (response === 0) await restartRuntime();
}

// Bring the Control Room forward from wherever it is: hidden to the tray,
// minimized, or already gone (recreate). Every "open the app" path funnels
// here: tray menu, dock click, second launch. Never in smoke mode, whose
// window must stay hidden so unattended runs trigger no consent dialogs.
function showControlRoom() {
  if (isSmoke) return;
  if (mainWindow) {
    // Dock first: re-activating the app before the window shows keeps macOS
    // from dropping focus on the way in. The window's own show handler also
    // calls this; the duplicate is harmless.
    app.dock?.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// Single-instance lock so launching Capturia twice focuses the existing
// window instead of opening a second one with conflicting camera access.
// Smoke mode must FAIL here, not silently quit(0): a second instance sharing
// the userData/keychain is an invalid gate environment worth surfacing.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  if (isSmoke) {
    console.error("[smoke] FAIL: another Capturia instance holds the single-instance lock");
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  app.on("second-instance", () => {
    showControlRoom();
  });

  app.whenReady().then(async () => {
    // Grant camera + mic only to the trusted studio origin, deny everything
    // else (so a navigated-to or injected page can't reach the camera).
    // Smoke mode denies media outright so an unattended run never triggers
    // the macOS camera/mic consent dialog.
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const url = webContents && typeof webContents.getURL === "function" ? webContents.getURL() : "";
        callback(!isSmoke && permission === "media" && isAllowedUrl(url, trustOpts));
      }
    );

    // Loopback CopilotKit runtime, up before the window asks for it. A start
    // failure (after the built-in retry) is survivable in dev, where the Next
    // route serves the runtime; on the static UI it means no AI at all, which
    // the dialog below surfaces once the shell is up.
    runtimeServer = await startRuntimeWithRetry();

    // Virtual camera feed: the offscreen Program Output window pumping into
    // the Capturia CMIO extension (started below, after the tray exists, so
    // its transitions land on a live menu). Same degrade-not-crash posture as
    // the tray: the require needs electron/gen.
    try {
      const { createCameraFeed } = require("./camera-feed");
      cameraFeed = createCameraFeed({
        studioUrl: STUDIO_URL,
        isAllowedNavigation: (url) => isAllowedUrl(url, trustOpts),
        // The persisted camera pick, read fresh per injection so a set that
        // just wrote settings.json threads the new value.
        getCameraDevice: () => normalizeCameraPreference(readSettings().cameraDevice),
        onStateChange: (state) => {
          tray?.update();
          // Fires on lifecycle transitions only (not per frame), so this is a
          // cheap push; the renderer's camera bridge subscribes to it.
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("camera", state);
          }
        },
      });
    } catch (err) {
      console.error(
        "Capturia: camera feed unavailable (is electron/gen built? run `npm run electron` or `node scripts/build-electron-libs.mjs`):",
        err
      );
    }

    // Camera-extension activation. Same degrade-not-crash posture; the module
    // itself decides whether this build can install (packaged + embedded
    // extension + entitlement) and reports "unsupported" otherwise.
    try {
      const { createSysext } = require("./sysext");
      sysext = createSysext({
        onStateChange: (state) => {
          tray?.update();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("sysext", state);
          }
        },
        // The install completed: the extension can enumerate now, so nudge
        // the feed to (re)connect. Not in smoke mode, whose camera lifecycle
        // must stay owned by the smoke gate. Also the activation step of the
        // funnel: one anonymous camera-installed ping, reported at most once
        // per install (telemetry dedupes, and covers the out-of-band
        // System Settings approval landing later because this callback fires
        // on the list poll's enabled flip too).
        onInstalled: () => {
          if (!isSmoke) cameraFeed?.start();
          telemetry.send("camera-installed");
        },
        // Never a dialog in smoke mode: unattended runs must stay unattended
        // (the forced sysext smoke leg can hit the needs-move preempt when
        // the packed app runs from dist-app).
        offerMove: () => {
          if (isSmoke) return;
          void offerMoveToApplications({
            parentWindow: mainWindow,
            detail:
              "macOS only installs the Capturia camera for apps in the Applications folder. After the move, click Install camera again.",
          });
        },
      });
    } catch (err) {
      console.error(
        "Capturia: extension activation unavailable (is electron/gen built? run `npm run electron` or `node scripts/build-electron-libs.mjs`):",
        err
      );
    }

    registerIpc();
    createWindow();

    // One anonymous launch ping per run (the DAU/MAU signal). Async and
    // fire-and-forget: a dead or unreachable endpoint costs one swallowed
    // fetch, never a slower start. On a FIRST run this parks behind the
    // consent gate until the renderer acks the onboarding disclosure
    // (telemetry:ack above); it is dropped silently if the user opts out
    // there, and every later run sends immediately.
    telemetry.send("launch");

    // Menu-bar tray: live status plus the same actions the window offers, so
    // the shell stays usable while hidden behind a call. Voice toggling rides
    // the existing hotkey channel; the renderer wiring is identical. Tray
    // failure (typically an unbuilt electron/gen on a bare `npx electron .`)
    // degrades to a plain windowed app instead of crashing the shell.
    try {
      tray = createTray({
        // Camera fields only when the camera module loaded; the tray model
        // omits the Camera item entirely when they are absent.
        getState: () => {
          // Extension-install status only when the sysext module loaded; the
          // tray model hides the item for undefined AND for "unsupported".
          const sysextFields = sysext ? { sysextStatus: sysext.getState().status } : {};
          // The restart item shows only while the AI engine is down with no
          // fallback route (static UI; dev serves the runtime through Next).
          const aiEngineDown = useStaticUi && !runtimeServer;
          if (!cameraFeed) return { ...rendererState, ...sysextFields, aiEngineDown };
          const camera = cameraFeed.getState();
          return {
            ...rendererState,
            cameraAvailable: camera.available,
            cameraRunning: camera.running,
            cameraConnecting: camera.connecting,
            cameraFrozen: camera.frozen,
            cameraHasError: Boolean(camera.error),
            ...sysextFields,
            aiEngineDown,
          };
        },
        toggleHotkey: HOTKEY_TOGGLE_VOICE,
        actions: {
          "toggle-listening": () =>
            mainWindow?.webContents.send("hotkey", { action: "toggle-voice" }),
          // Intent-routed inside the feed: stops while connecting OR running
          // (a pending auto-connect must be cancellable), starts otherwise.
          "toggle-camera": () => cameraFeed?.toggle(),
          // Fires the extension activation request (or the move offer when
          // the app runs from the wrong place); outcomes come back as tray
          // updates through the sysext onStateChange. A click on the retry
          // item after a FAILURE first shows the mapped OS reason (the tray
          // label alone cannot carry "blocked by MDM policy" etc.), then
          // retries on confirm.
          "install-camera": () => {
            if (!sysext) return;
            const state = sysext.getState();
            if (state.status !== "error" || !state.error) {
              sysext.install();
              return;
            }
            const options = {
              type: "warning",
              buttons: ["Try Again", "Cancel"],
              defaultId: 0,
              cancelId: 1,
              message: "Camera install failed",
              detail: state.error,
            };
            const shown =
              mainWindow && !mainWindow.isDestroyed()
                ? dialog.showMessageBox(mainWindow, options)
                : dialog.showMessageBox(options);
            void shown.then(({ response }) => {
              if (response === 0) sysext?.install();
            });
          },
          // Outcomes surface themselves: success reloads the studio window,
          // failure brings the dialog back (restartRuntime above).
          "restart-ai": () => {
            void restartRuntime();
          },
          "open-control-room": showControlRoom,
          "open-settings": () => {
            showControlRoom();
            sendRendererAction("open-settings");
          },
          quit: () => app.quit(),
        },
      });
    } catch (err) {
      console.error(
        "Capturia: tray unavailable (is electron/gen built? run `npm run electron` or `node scripts/build-electron-libs.mjs`):",
        err
      );
    }

    // Feed the Capturia camera for the app's whole lifetime. Smoke mode skips
    // it: media is denied there, unattended runs must stay deterministic on
    // machines without the extension, and app.exit() would skip the clean
    // sink disconnect anyway.
    if (!isSmoke && cameraFeed) cameraFeed.start();

    // Global push-to-talk hotkey. Works even when Capturia isn't focused,
    // so users can toggle voice mid-Zoom-call without alt-tabbing.
    const registered = globalShortcut.register(HOTKEY_TOGGLE_VOICE, () => {
      mainWindow?.webContents.send("hotkey", { action: "toggle-voice" });
    });
    if (!registered) {
      console.warn(`Failed to register hotkey ${HOTKEY_TOGGLE_VOICE} (in use?)`);
    }

    // The AI engine is down and the static UI has no fallback route
    // (/api/copilotkit does not exist on file://), so every command would die
    // silently: say so now that the shell is up behind the dialog. Dev keeps
    // the silent fallback (the Next route serves the runtime) and smoke must
    // stay unattended (its keycheck gate already fails the run).
    if (!runtimeServer && useStaticUi && !isSmoke) {
      void offerRuntimeRestart();
    }

    // Last, so the whole app (window, tray, runtime) is already up behind
    // the dialog: offer the move to /Applications on a first packaged launch
    // from the wrong place (macOS ties permission persistence to the app
    // path). Guarded internally for smoke/dev; on acceptance the app quits
    // and relaunches from the new location, taking everything above with it.
    maybeOfferMoveToApplications({ isSmoke, parentWindow: mainWindow });
  });
}

// Flag a real quit before any window sees the close event, so close-to-hide
// steps aside and the app actually exits.
app.on("before-quit", () => {
  isQuitting = true;
});

// Clean up the global shortcut, camera feed, and tray so they don't linger
// past app exit. The camera goes first (its teardown disconnects the CMIO
// sink stream, handing the extension back to its splash) and before the tray
// so its final state change updates a live menu.
app.on("will-quit", () => {
  hostedBilling?.stop();
  globalShortcut.unregisterAll();
  speechHelper.stopAllSpeechSessions();
  cameraFeed?.dispose();
  cameraFeed = null;
  sysext?.dispose();
  sysext = null;
  tray?.destroy();
  tray = null;
});

// macOS: keep the app alive when all windows close (re-open via tray/dock).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: dock click (or a Finder re-launch) brings the Control Room back,
// including from the hidden-to-tray state.
app.on("activate", () => {
  showControlRoom();
});
