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
// owned by CopilotKit instead of an undeclared transitive import here). The
// spec table + env-key mirror live in lib/server-keys.ts so the fail-fast
// guard below and the agents factory can never drift apart.
import {
  providerModelSpec,
  effectiveModelSpec,
  missingModelKeyError,
  canonicalProvider,
  isNoThinkingModel,
} from "@/lib/server-keys";

function buildAgent(model: string, apiKey: string | undefined) {
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
    // Gemini 2.5 Flash with default thinking returns EMPTY responses against
    // Capturia's system prompt (see isNoThinkingModel in lib/server-keys.ts
    // for the full story and why it is an allowlist).
    ...(isNoThinkingModel(model)
      ? { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } }
      : {}),
  });
}

// Model routing, per request:
//   1. BYOK (desktop): the renderer attaches x-capturia-provider + x-capturia-key
//      (the CopilotKit `headers` prop in app/studio/page.tsx). Every call uses the
//      caller's own key; nothing is shared across requests. CAPTURIA_MODEL is
//      honored only when it stays on the provider the user chose, so their key
//      is never sent to a different provider.
//   2. Server / dev fallback (no headers): CAPTURIA_MODEL pins an exact spec,
//      otherwise CAPTURIA_PROVIDER picks the default (gemini, so the public web
//      demo stays free + fast). The env key is chosen by the MODEL's provider
//      prefix, not the provider name, so a pinned cross-provider model never
//      receives the gemini project key. To run dev/self-host on a better model,
//      set CAPTURIA_PROVIDER=claude (with ANTHROPIC_API_KEY already in your env).
const runtime = new CopilotRuntime({
  agents: ({ request }) => {
    const byokProvider = request.headers.get("x-capturia-provider");
    const byokKey = request.headers.get("x-capturia-key") || undefined;
    if (byokProvider && byokKey) {
      // Safe lookup: byokProvider is a client header, so a plain bracket index
      // could resolve a prototype key ("constructor") to a Function.
      const fallback = providerModelSpec(byokProvider);
      const override = process.env.CAPTURIA_MODEL;
      // canonicalProvider, not the raw prefix: "gemini/..." and "google/..."
      // are the same provider to resolveModel, so a same-provider override
      // spelled with an alias must still be honored.
      const model =
        override && canonicalProvider(override) === canonicalProvider(fallback)
          ? override
          : fallback;
      return { default: buildAgent(model, byokKey) };
    }
    const model = effectiveModelSpec(process.env);
    const envKey =
      canonicalProvider(model) === "google"
        ? process.env.GOOGLE_GENERATIVE_AI_API_KEY
        : undefined;
    return { default: buildAgent(model, envKey) };
  },
  runner: new InMemoryAgentRunner(),
});

// single-route: all requests go to POST /api/copilotkit with { method, params, body }.
// Omitting GET so the frontend's auto-detect falls back to single-route mode.
const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
  mode: "single-route",
});

export async function POST(request: Request): Promise<Response> {
  // Fail fast with a readable message when the server has no usable model key,
  // instead of constructing a doomed agent (resolveModel would otherwise throw
  // a cryptic auth error deep in the stream). Two constraints shape this:
  //   - The client opens every session with a {method:"info"} handshake and
  //     treats ANY non-OK info response as "runtime unreachable" (it throws
  //     before reading the body), so the guard must let info through and gate
  //     only the model-running methods.
  //   - BYOK requests (desktop) carry their own key, so only the env-fallback
  //     web/dev path needs guarding; missingModelKeyError mirrors the agents
  //     factory above exactly (see lib/server-keys.ts).
  let method: unknown;
  try {
    method = ((await request.clone().json()) as { method?: unknown })?.method;
  } catch {
    method = undefined; // non-JSON body: let the runtime answer it
  }
  if (method !== "info") {
    const error = missingModelKeyError({
      byokProvider: request.headers.get("x-capturia-provider"),
      byokKey: request.headers.get("x-capturia-key"),
      env: process.env,
    });
    // Studio probe: reports key health without running the agent, so the
    // operator UI can show the message (CopilotKit logs run errors only to
    // the console). Never forwarded to the runtime handler.
    if (method === "capturia-keycheck") {
      return Response.json({ ok: !error, error: error ?? null });
    }
    // 503, not 400: a missing server key is a server misconfiguration, not a
    // malformed request. The body names the exact env var to set.
    if (error) return Response.json({ error }, { status: 503 });
  }
  return handler(request);
}
