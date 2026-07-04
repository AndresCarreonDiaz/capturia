// Pure server-side model/key resolution shared by the copilotkit route and its
// fail-fast guard. Framework-free so it is unit-testable; the route handler
// owns all request/Response plumbing.
//
// The env fallbacks here MIRROR CopilotKit's resolveModel() (verified against
// @copilotkit/runtime/dist/agent: "openai" -> OPENAI_API_KEY, "anthropic" ->
// ANTHROPIC_API_KEY, "google"/"gemini"/"google-gemini" -> GOOGLE_API_KEY,
// "vertex" -> application default credentials, no key). If a CopilotKit
// upgrade changes that mapping, update this file alongside it.

// Capturia provider key -> ai-sdk model spec ("provider/model"). resolveModel()
// splits on the first "/" and builds the right @ai-sdk provider. Chosen for
// tool-calling + structured-JSON quality, which matters most for render_surface
// (small models fumble authoring a whole A2UI tree). Claude / GPT are NOT
// affected by the Gemini-3.x thought_signature gap, so they are safe to use
// today with maxSteps:1.
export const PROVIDER_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.5-flash-lite", // fast, cheap; the free web-demo default
  claude: "anthropic/claude-sonnet-4-6", // strong tree authoring (Haiku 4.5 / Opus 4.8 via CAPTURIA_MODEL)
  openai: "openai/gpt-4o",
};

// Provider name -> spec, safe for CLIENT-supplied values. A bracket lookup on
// a plain object also matches prototype keys ("constructor", "toString"), which
// return a Function instead of falling through to the gemini default and then
// blow up in modelSpecProvider. Own-property check + default closes that.
export function providerModelSpec(provider: string | null | undefined): string {
  return provider && Object.hasOwn(PROVIDER_MODELS, provider)
    ? PROVIDER_MODELS[provider]
    : PROVIDER_MODELS.gemini;
}

// The ai-sdk provider prefix of a model spec like "google/gemini-2.5-flash"
// or "anthropic:claude-sonnet-4-6" (resolveModel accepts both separators).
export function modelSpecProvider(spec: string): string {
  return spec.replace("/", ":").trim().split(":")[0].toLowerCase();
}

// resolveModel treats "google", "gemini", and "google-gemini" as the same
// provider, so every comparison against a spec's provider must too. This is
// THE normalization point; comparing raw modelSpecProvider() output against a
// literal breaks for the alias spellings resolveModel itself accepts.
const GOOGLE_ALIASES = new Set(["google", "gemini", "google-gemini"]);
export function canonicalProvider(spec: string): string {
  const prefix = modelSpecProvider(spec);
  return GOOGLE_ALIASES.has(prefix) ? "google" : prefix;
}

// The model id part of a spec ("google/gemini-2.5-flash" -> "gemini-2.5-flash").
function specModelId(spec: string): string {
  return spec.replace("/", ":").trim().split(":").slice(1).join(":").toLowerCase();
}

// Gemini 2.5 Flash "thinks" by default and, with Capturia's full system
// prompt, reliably returns an EMPTY response (finishReason STOP, zero parts)
// instead of tool calls, killing the whole loop. thinkingBudget: 0 disables
// thinking, which the one-shot maxSteps:1 design wants anyway (faster first
// token, cheaper). Allowlist, not blanket: 2.5-pro rejects budget 0 (min 128)
// and Gemini 3.x requires thinking. Matching is alias- and separator-
// normalized so "gemini/gemini-2.5-flash" or "google:GEMINI-2.5-FLASH" (all
// valid per resolveModel) don't silently reintroduce the empty-response bug.
const NO_THINKING_MODEL_IDS = new Set(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
export function isNoThinkingModel(spec: string): boolean {
  return canonicalProvider(spec) === "google" && NO_THINKING_MODEL_IDS.has(specModelId(spec));
}

// Env vars that satisfy each CANONICAL provider, in resolveModel's own order
// of preference. Note GOOGLE_GENERATIVE_AI_API_KEY: resolveModel itself only
// reads GOOGLE_API_KEY, but the route passes GOOGLE_GENERATIVE_AI_API_KEY
// explicitly as the per-request key, so either works for google specs.
// Keyed by canonicalProvider() output, so the google aliases live in ONE
// place (canonicalProvider), not here.
const ENV_KEYS_BY_PROVIDER: Record<string, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
};

// Env keys that could satisfy a spec, or undefined for prefixes we don't map
// (vertex, unknown: resolveModel handles those itself). Own-property guarded:
// a spec like "constructor/x" must fall through, not resolve a prototype
// member to a Function.
export function envKeysForSpec(spec: string): readonly string[] | undefined {
  const provider = canonicalProvider(spec);
  return Object.hasOwn(ENV_KEYS_BY_PROVIDER, provider)
    ? ENV_KEYS_BY_PROVIDER[provider]
    : undefined;
}

type Env = Record<string, string | undefined>;

// The model spec a non-BYOK request will actually run: CAPTURIA_MODEL pins an
// exact spec, otherwise the CAPTURIA_PROVIDER default applies.
export function effectiveModelSpec(env: Env): string {
  return env.CAPTURIA_MODEL || providerModelSpec(env.CAPTURIA_PROVIDER);
}

export interface KeyCheckInput {
  byokProvider: string | null;
  byokKey: string | null;
  env: Env;
}

/**
 * Returns a human-readable error when a model-running request is GUARANTEED to
 * fail for lack of an API key, or null when it should proceed. Mirrors the
 * route's agents factory exactly: BYOK applies only when BOTH headers are
 * present; otherwise the effective env model spec decides which env keys count.
 * Unknown/vertex prefixes return null (resolveModel handles those itself).
 */
export function missingModelKeyError({ byokProvider, byokKey, env }: KeyCheckInput): string | null {
  if (byokProvider && byokKey) return null;
  const model = effectiveModelSpec(env);
  const envKeys = envKeysForSpec(model);
  if (!envKeys) return null;
  if (envKeys.some((k) => env[k])) return null;
  const hint = envKeys.includes("GOOGLE_API_KEY")
    ? " (free key at https://aistudio.google.com)"
    : "";
  return (
    `Capturia has no API key for the model "${model}". ` +
    `Set ${envKeys.join(" or ")} in .env.local${hint}, ` +
    `or run the desktop app with your own key (BYOK).`
  );
}
