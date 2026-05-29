// Preload runs in the renderer with both Node and DOM access. We expose a
// minimal, typed-ish surface to window.capturia via contextBridge so the
// renderer never touches Node APIs directly (keeps contextIsolation safe).
//
// Surface:
//   window.capturia.isDesktop  - boolean flag the renderer can check
//   window.capturia.onHotkey(handler) - subscribe to "toggle-voice" hotkey
//     events. Returns an unsubscribe function.
//   window.capturia.transcribe(wavBytes) - local whisper transcription
//   window.capturia.keys.{save,clear,list,get} - BYOK vault

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
  // get returns the plaintext key for the active provider so the renderer can
  // attach it to the CopilotKit request header (BYOK, see app/studio). This is
  // the user's OWN key on their OWN machine; the main process only returns it
  // to a trusted (localhost / file://) sender, and it is sent only to the local
  // runtime. The fully isolated form (runtime in main) is the M2 hardening.
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
    get(provider) {
      return ipcRenderer.invoke("keys:get", provider);
    },
  },
  // Deck codegen: run a prompt on the user's stored key in main, return raw
  // model text. Used by the deck dropzone to design overlays from a PDF.
  generateCues(prompt, provider) {
    return ipcRenderer.invoke("deck:generate", { prompt, provider });
  },
});
