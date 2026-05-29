// Deck codegen, run in the Electron MAIN process on the user's stored key.
// The renderer builds the prompt (lib/deck/prompt.ts) and sends it here; we run
// it through the AI SDK with the decrypted key and return the raw model text.
// The key never leaves the main process. Throws if no key is stored, so the
// renderer falls back to the deterministic cue builder.

const keychain = require("./keychain");

// Codegen favors a slightly stronger model than the live hot path, since it
// runs once at drop-time and quality matters more than latency here.
const MODELS = {
  gemini: "gemini-2.5-flash",
  claude: "claude-3-5-haiku-latest",
  openai: "gpt-4o-mini",
};

async function buildModel(provider, key) {
  if (provider === "claude") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: key })(MODELS.claude);
  }
  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI({ apiKey: key })(MODELS.openai);
  }
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  return createGoogleGenerativeAI({ apiKey: key })(MODELS.gemini);
}

async function generateCues(prompt, provider) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Empty codegen prompt.");
  }
  const key = keychain.getKey(provider);
  if (!key) {
    throw new Error(`No ${provider} key stored; cannot run deck codegen.`);
  }
  const { generateText } = await import("ai");
  const model = await buildModel(provider, key);
  const { text } = await generateText({
    model,
    prompt,
    temperature: 0,
    maxOutputTokens: 4096,
  });
  return text;
}

module.exports = { generateCues };
