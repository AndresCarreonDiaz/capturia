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
  session,
  globalShortcut,
  ipcMain,
  shell,
} = require("electron");
const path = require("path");
const { transcribeWav } = require("./whisper");
const keychain = require("./keychain");
const deckGen = require("./deck-generate");
const { startRuntimeServer } = require("./runtime-server");
const {
  isTrustedSender,
  isAllowedUrl,
  assertProvider,
  assertNonEmptyString,
  assertBytes,
} = require("./ipc-schemas");

// Push-to-talk hotkey. Cmd+Alt+Space on Mac, Ctrl+Alt+Space elsewhere.
// Chosen to avoid Spotlight (Cmd+Space) and the macOS character viewer.
const HOTKEY_TOGGLE_VOICE = "CmdOrCtrl+Alt+Space";

const isDev = !app.isPackaged;
const isSmoke = process.env.CAPTURIA_SMOKE === "1";
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
// Set once the loopback CopilotKit runtime is up; null means it failed and
// the renderer falls back to /api/copilotkit (works in dev via Next).
let runtimeServer = null;

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
      keychain.clearKey(assertProvider(provider));
      return keychain.listKeys();
    })
  );
  ipcMain.handle("keys:list", guarded(() => keychain.listKeys()));

  // Renderer -> main: where the loopback CopilotKit runtime listens this
  // launch (URL + per-launch bearer token). null when the server failed to
  // start, in which case the renderer stays on the /api/copilotkit route.
  ipcMain.handle(
    "runtime:info",
    guarded(() =>
      runtimeServer ? { url: runtimeServer.url, token: runtimeServer.token } : null
    )
  );

  // Deck codegen on the user's key, in main. Returns raw model text (JSON the
  // renderer validates). The prompt is built in the renderer (lib/deck/prompt).
  ipcMain.handle(
    "deck:generate",
    guarded((_event, payload) => {
      const provider = assertProvider(payload && payload.provider);
      const prompt = assertNonEmptyString(payload && payload.prompt, "Prompt");
      return deckGen.generateCues(prompt, provider);
    })
  );
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Smoke mode: prove the static export + bridge + loopback runtime work end
  // to end, then exit. Checks, from inside the page: the preload bridge is up,
  // the page's own JS bundle executed (window.capturiaCatalog is set at studio
  // module load, so broken file:// asset paths fail here), and a real fetch to
  // the runtime with the bridge-provided URL + token answers the keycheck
  // (which also exercises CORS from the file:// origin).
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
        const info = window.capturia && window.capturia.runtimeInfo
          ? await window.capturia.runtimeInfo()
          : null;
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
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(smokeJs);
        const pass =
          result.bundleRan && result.hasBridge && result.info && result.keycheck?.status === 200;
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
    // failure is survivable in dev (the Next route serves the runtime), so it
    // logs instead of crashing the shell.
    try {
      runtimeServer = await startRuntimeServer({ keychain, isDev });
    } catch (err) {
      console.error("Capturia: runtime server failed to start:", err);
    }

    registerIpc();
    createWindow();

    // Global push-to-talk hotkey. Works even when Capturia isn't focused,
    // so users can toggle voice mid-Zoom-call without alt-tabbing.
    const registered = globalShortcut.register(HOTKEY_TOGGLE_VOICE, () => {
      mainWindow?.webContents.send("hotkey", { action: "toggle-voice" });
    });
    if (!registered) {
      console.warn(`Failed to register hotkey ${HOTKEY_TOGGLE_VOICE} (in use?)`);
    }
  });
}

// Clean up the global shortcut so it doesn't linger past app exit.
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// macOS: keep the app alive when all windows close (re-open via dock).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// macOS: re-create the window when the user clicks the dock icon and there
// are no open windows.
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
