// Preload runs in the renderer with both Node and DOM access. We expose a
// minimal, typed-ish surface to window.capturia via contextBridge so the
// renderer never touches Node APIs directly (keeps contextIsolation safe).
//
// Surface:
//   window.capturia.isDesktop  - boolean flag the renderer can check
//   window.capturia.onHotkey(handler) - subscribe to "toggle-voice" hotkey
//     events. Returns an unsubscribe function.
//   window.capturia.transcribe(wavBytes) - local whisper transcription
//   window.capturia.keys.{save,clear,list} - BYOK vault (plaintext never
//     crosses this bridge; main's runtime server reads keys itself)
//   window.capturia.runtimeInfo() - loopback runtime URL + bearer token

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capturia", {
  isDesktop: true,
  onHotkey(handler) {
    const listener = (_event, payload) => {
      // Validate the payload shape before handing it to renderer code.
      if (!payload || typeof payload.action !== "string") return;
      try {
        handler(payload);
      } catch (err) {
        console.error("capturia.onHotkey handler threw:", err);
      }
    };
    ipcRenderer.on("hotkey", listener);
    return () => ipcRenderer.off("hotkey", listener);
  },
  // Renderer → main: transcribe a pre-encoded WAV (16kHz mono 16-bit PCM).
  // Returns plain transcript text. Rejects on whisper failure so the renderer
  // can surface the error.
  transcribe(wavBytes) {
    return ipcRenderer.invoke("whisper:transcribe", wavBytes);
  },
  // BYOK key vault. save/clear/list return the updated KeyEntry[] snapshot.
  // There is deliberately no `get`: the plaintext key never enters a renderer.
  // The runtime server in main reads the keychain itself; the renderer only
  // names a provider via the x-capturia-provider header (app/studio).
  keys: {
    save(provider, key) {
      return ipcRenderer.invoke("keys:save", { provider, key });
    },
    clear(provider) {
      return ipcRenderer.invoke("keys:clear", provider);
    },
    list() {
      return ipcRenderer.invoke("keys:list");
    },
  },
  // Where main's loopback CopilotKit runtime listens this launch: an absolute
  // runtimeUrl plus the per-launch bearer token that authenticates the
  // renderer to it. null when the server failed to start (the renderer then
  // stays on the /api/copilotkit route, which works in dev).
  runtimeInfo() {
    return ipcRenderer.invoke("runtime:info");
  },
  // Deck codegen: run a prompt on the user's stored key in main, return raw
  // model text. Used by the deck dropzone to design overlays from a PDF.
  generateCues(prompt, provider) {
    return ipcRenderer.invoke("deck:generate", { prompt, provider });
  },
  // Renderer -> main: voice state for the tray menu (listening on/off and
  // whether the speech engine exists). Fire-and-forget for the caller.
  reportState(state) {
    return ipcRenderer.invoke("state:report", state);
  },
  // On-device streaming speech (macOS 26+): start/stop the mic helper and
  // subscribe to its events (ready/interim/final/error/done).
  speech: {
    available() {
      return ipcRenderer.invoke("speech:available");
    },
    start(locale) {
      return ipcRenderer.invoke("speech:start", locale);
    },
    stop(id) {
      return ipcRenderer.invoke("speech:stop", id);
    },
    onEvent(handler) {
      const listener = (_event, payload) => {
        if (!payload || typeof payload.type !== "string") return;
        try {
          handler(payload);
        } catch (err) {
          console.error("capturia.speech.onEvent handler threw:", err);
        }
      };
      ipcRenderer.on("speech", listener);
      return () => ipcRenderer.off("speech", listener);
    },
  },
});
