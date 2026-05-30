import {
  CopilotRuntime,
  createCopilotRuntimeHandler,
  InMemoryAgentRunner,
  BuiltInAgent,
} from "@copilotkit/runtime/v2";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

// Provider → model specifier. CopilotKit's resolveModel() builds the right
// @ai-sdk provider from the "provider/model" string plus the per-request
// apiKey, so we don't import @ai-sdk/* directly (which also keeps the dep
// owned by CopilotKit instead of an undeclared transitive import here).
// provider key -> ai-sdk model spec ("provider/model"). resolveModel() splits on
// the first "/" and builds the right @ai-sdk provider. Chosen for tool-calling +
// structured-JSON quality, which matters most for render_surface (small models
// fumble authoring a whole A2UI tree). Claude / GPT are NOT affected by the
// Gemini-3.x thought_signature gap, so they are safe to use today with maxSteps:1.
const PROVIDER_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.5-flash-lite", // fast, cheap; the free web-demo default
  claude: "anthropic/claude-sonnet-4-6", // strong tree authoring (Haiku 4.5 / Opus 4.8 via CAPTURIA_MODEL)
  openai: "openai/gpt-4o",
};

function buildAgent(provider: string, apiKey: string | undefined) {
  // CAPTURIA_MODEL lets a self-hoster pin an exact model spec (e.g.
  // "anthropic/claude-haiku-4-5-20251001") regardless of the provider default.
  const model = process.env.CAPTURIA_MODEL || PROVIDER_MODELS[provider] || PROVIDER_MODELS.gemini;
  return new BuiltInAgent({
    model,
    // Per-request user key (BYOK). undefined => resolveModel falls back to the
    // provider's own env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY).
    apiKey,
    prompt: SYSTEM_PROMPT,
    // Voice => one response that emits all tool calls at once. No internal
    // roundtrip. Keeps each utterance to a single model call.
    maxSteps: 1,
    // Lower temp = faster decoding + more deterministic tool selection.
    temperature: 0,
  });
}

// Model routing, per request:
//   1. BYOK (desktop): the renderer attaches x-capturia-provider + x-capturia-key
//      (the CopilotKit `headers` prop in app/studio/page.tsx). Every call uses the
//      caller's own key; nothing is shared across requests.
//   2. Server / dev fallback (no headers): CAPTURIA_PROVIDER picks the provider
//      (default "gemini" so the public web demo stays free + fast). For gemini we
//      pass the project key; for claude/openai we pass nothing and let resolveModel
//      read that provider's own env var. So to run dev/self-host on a better model,
//      set CAPTURIA_PROVIDER=claude (with ANTHROPIC_API_KEY already in your env).
const runtime = new CopilotRuntime({
  agents: ({ request }) => {
    const byokProvider = request.headers.get("x-capturia-provider");
    const byokKey = request.headers.get("x-capturia-key") || undefined;
    if (byokProvider && byokKey) {
      return { default: buildAgent(byokProvider, byokKey) };
    }
    const provider = process.env.CAPTURIA_PROVIDER || "gemini";
    const envKey =
      provider === "gemini" ? process.env.GOOGLE_GENERATIVE_AI_API_KEY : undefined;
    return { default: buildAgent(provider, envKey) };
  },
  runner: new InMemoryAgentRunner(),
});

// single-route: all requests go to POST /api/copilotkit with { method, params, body }.
// Omitting GET so the frontend's auto-detect falls back to single-route mode.
export const POST = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});
