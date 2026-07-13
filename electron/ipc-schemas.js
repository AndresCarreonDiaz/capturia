// Centralized IPC hardening. Every privileged ipcMain handler runs its caller
// through isTrustedSender (origin allowlist) and its payload through these
// assertions before touching anything. Plain JS, no zod, to keep the main
// process dependency-light and free of ESM/CJS friction.

const { URL } = require("url");

// Keep in sync with electron/keychain.js: "capturia-hosted" is the Pro
// access-token slot, not an API-key vendor.
const PROVIDERS = ["gemini", "claude", "openai", "capturia-hosted"];

// Is this navigation/sender URL one we trust? Dev: the local Next server on
// any localhost port. Prod: the bundled file:// app. Everything else (a page
// the renderer navigated to, an injected iframe) is untrusted.
function isAllowedUrl(targetUrl, { isDev }) {
  try {
    const u = new URL(targetUrl);
    if (isDev) return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "file:";
  } catch {
    return false;
  }
}

// Guard for ipcMain handlers: reject calls whose sender frame is not a trusted
// origin, so a navigated-away or injected renderer cannot reach the vault,
// whisper, etc.
function isTrustedSender(event, opts) {
  const url =
    (event && event.senderFrame && event.senderFrame.url) ||
    (event && event.sender && typeof event.sender.getURL === "function" && event.sender.getURL()) ||
    "";
  return isAllowedUrl(url, opts);
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider: ${String(provider)}`);
  }
  return provider;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

// Accept the byte shapes the renderer can send for a WAV (ArrayBuffer, any
// TypedArray view, or a Buffer); reject anything else so Buffer.from can't be
// fed a string/object and produce confusing downstream errors.
function assertBytes(value, label) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Buffer.isBuffer(value)) {
    return value;
  }
  throw new Error(`${label} must be ArrayBuffer/TypedArray bytes.`);
}

// The renderer's state report that drives the tray menu and the cue-hotkey
// registration. Rebuilt as a fresh object so extra properties on the payload
// never reach main state.
function assertStateReport(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.listening !== "boolean" ||
    typeof value.voiceSupported !== "boolean"
  ) {
    throw new Error("State report needs boolean listening and voiceSupported.");
  }
  // Loaded deck size, driving the silent cue hotkeys. Optional so a stale
  // packaged UI that predates it keeps reporting; anything that is not a
  // sane count reads as "no deck" (shortcuts stay unregistered).
  const cueCount =
    typeof value.cueCount === "number" && Number.isInteger(value.cueCount) && value.cueCount > 0
      ? value.cueCount
      : 0;
  return { listening: value.listening, voiceSupported: value.voiceSupported, cueCount };
}

module.exports = {
  PROVIDERS,
  isAllowedUrl,
  isTrustedSender,
  assertProvider,
  assertNonEmptyString,
  assertBytes,
  assertStateReport,
};
