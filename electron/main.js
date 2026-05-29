// Capturia desktop wrapper. Loads the Next.js studio in a BrowserWindow.
// In dev: points at http://localhost:3000/studio (Next.js dev server).
// In prod (later): will load a bundled build. Until then, packaged builds are
// not supported by this file.

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
const STUDIO_URL = isDev
  ? "http://localhost:3000/studio"
  : `file://${path.join(__dirname, "../out/studio.html")}`;

let mainWindow = null;

// Wrap every privileged IPC handler so it first rejects calls from an
// untrusted sender (a navigated-away or injected renderer), then runs the
// handler. Errors propagate back to the renderer's invoke() as a rejection.
function guarded(handler) {
  return async (event, ...args) => {
    if (!isTrustedSender(event, { isDev })) {
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

  // Encrypted BYOK key vault. The plaintext key only leaves main via keys:get,
  // and only to a trusted sender (the BYOK header path).
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
  ipcMain.handle(
    "keys:get",
    guarded((_event, provider) => keychain.getKey(assertProvider(provider)))
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
    if (!isAllowedUrl(url, { isDev })) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(STUDIO_URL);
}

// Single-instance lock so launching Capturia twice focuses the existing
// window instead of opening a second one with conflicting camera access.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Grant camera + mic only to the trusted studio origin, deny everything
    // else (so a navigated-to or injected page can't reach the camera).
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const url = webContents && typeof webContents.getURL === "function" ? webContents.getURL() : "";
        callback(permission === "media" && isAllowedUrl(url, { isDev }));
      }
    );

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
