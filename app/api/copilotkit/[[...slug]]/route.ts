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
const PROVIDER_MODELS: Record<string, string> = {
  // gemini-2.5-flash-lite: fast TTFT, no Gemini-3.x thought_signature gap.
  gemini: "google/gemini-2.5-flash-lite",
  claude: "anthropic/claude-3.5-haiku",
  openai: "openai/gpt-4o-mini",
};

function buildAgent(provider: string, apiKey: string | undefined) {
  const model = PROVIDER_MODELS[provider] ?? PROVIDER_MODELS.gemini;
  return new BuiltInAgent({
    model,
    // Per-request user key (BYOK). undefined → BuiltInAgent falls back to the
    // provider env var, which is the free web-demo path (Gemini via env).
    apiKey,
    prompt: SYSTEM_PROMPT,
    // Voice → one response that emits all tool calls at once. No internal
    // roundtrip. Keeps each utterance to a single model call.
    maxSteps: 1,
    // Lower temp = faster decoding + more deterministic tool selection.
    temperature: 0,
  });
}

// BYOK routing: the desktop renderer attaches the user's own provider + key as
// request headers (see the CopilotKit `headers` prop in app/studio/page.tsx).
// The agents factory runs per-request, so every call uses the caller's key and
// nothing is shared across requests. On web there are no headers, so we fall
// back to the server env key for the free Gemini demo.
const runtime = new CopilotRuntime({
  agents: ({ request }) => {
    const provider = request.headers.get("x-capturia-provider") || "gemini";
    const userKey = request.headers.get("x-capturia-key") || undefined;
    const apiKey = userKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    return { default: buildAgent(provider, apiKey) };
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
