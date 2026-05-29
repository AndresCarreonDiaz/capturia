// Encrypted key vault backed by Electron safeStorage. On macOS this uses
// the OS Keychain; on Windows it uses DPAPI. The plaintext key never leaves
// the main process - listKeys returns only presence + a masked display.
// Routing of agent calls through stored keys happens in the main process
// too (next BYOK session), so getKey is module-internal.

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const PROVIDERS = ["gemini", "claude", "openai"];

function vaultPath() {
  return path.join(app.getPath("userData"), "keys.json");
}

function readVault() {
  try {
    return JSON.parse(fs.readFileSync(vaultPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeVault(vault) {
  const dir = path.dirname(vaultPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(vaultPath(), JSON.stringify(vault), { mode: 0o600 });
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
}

function saveKey(provider, key) {
  assertProvider(provider);
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Key must be a non-empty string.");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "OS-level encryption is not available on this platform. Refusing to store plaintext keys."
    );
  }
  // On Linux without a real secret store, safeStorage silently falls back to
  // "basic_text" (a hardcoded password). That is not real encryption, so refuse
  // rather than give a false sense of safety.
  if (
    typeof safeStorage.getSelectedStorageBackend === "function" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  ) {
    throw new Error(
      "No OS secret store is available (basic_text backend). Refusing to store keys insecurely. Install gnome-keyring / kwallet, or use the GOOGLE_GENERATIVE_AI_API_KEY env var instead."
    );
  }
  const vault = readVault();
  vault[provider] = safeStorage.encryptString(key.trim()).toString("base64");
  writeVault(vault);
}

function clearKey(provider) {
  assertProvider(provider);
  const vault = readVault();
  if (!(provider in vault)) return;
  delete vault[provider];
  writeVault(vault);
}

// Module-internal. Will be used by the agent-routing layer (next session).
function getKey(provider) {
  assertProvider(provider);
  const vault = readVault();
  const encoded = vault[provider];
  if (!encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

// Public summary for the renderer: presence + a 4-char tail for visual
// confirmation. Never returns the actual key bytes.
function listKeys() {
  return PROVIDERS.map((provider) => {
    const key = getKey(provider);
    if (!key) {
      return { provider, has: false, mask: null };
    }
    const tail = key.length >= 4 ? key.slice(-4) : key;
    return { provider, has: true, mask: `••••${tail}` };
  });
}

module.exports = { saveKey, clearKey, listKeys, getKey, PROVIDERS };
