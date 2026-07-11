// Request planning for the hosted LLM proxy (M11, issue #10). Framework-free
// on purpose: the route handler owns Request/Response plumbing, this module
// owns every decision, so vitest covers the whole surface.
//
// Wire shape: the desktop loopback runtime's LLM calls ARE the Gemini
// generateContent wire format. CopilotKit's resolveModel builds an
// @ai-sdk/google provider which POSTs
//   {baseURL}/models/{model}:streamGenerateContent?alt=sse
// with the key in x-goog-api-key (verified against @ai-sdk/google 3.x in
// node_modules). The proxy therefore speaks exactly that shape under
// /api/hosted/v1beta/..., which makes "hosted mode" on desktop a two-line
// swap: baseURL points here, the api key slot carries the Capturia JWT
// (lib/desktop-runtime.ts). POST /api/hosted/v1/generate is a stable alias
// of the same call for curl, scripts, and future non-ai-sdk clients.

type Env = Record<string, string | undefined>;

// Models the hosted tier will pay for, enforced server-side so a valid JWT
// cannot pick an expensive model on Capturia's key. Flash-Lite is the studio
// default (lib/server-keys.ts); Flash is the deck-codegen tier.
export const DEFAULT_HOSTED_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"] as const;
export const DEFAULT_HOSTED_MODEL_ID = DEFAULT_HOSTED_MODELS[0];

export function allowedHostedModels(env: Env = process.env): string[] {
  const raw = env.CAPTURIA_HOSTED_MODELS;
  if (!raw) return [...DEFAULT_HOSTED_MODELS];
  const models = raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return models.length > 0 ? models : [...DEFAULT_HOSTED_MODELS];
}

export interface HostedPlan {
  modelId: string;
  stream: boolean;
  /** Gemini GenerateContentRequest, forwarded verbatim. */
  request: Record<string, unknown>;
}

export type PlanResult =
  | { ok: true; plan: HostedPlan }
  | { ok: false; status: number; error: string };

function bad(status: number, error: string): PlanResult {
  return { ok: false, status, error };
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/i;

// slug comes from the [[...slug]] catch-all. Accepted shapes:
//   ["v1", "generate"]                      body { model?, stream?, request }
//   ["v1beta", "models", "<id>:<method>"]   body = the Gemini request itself
export function planHostedCall(slug: readonly string[], body: unknown, env: Env = process.env): PlanResult {
  const allowed = allowedHostedModels(env);

  if (slug.length === 2 && slug[0] === "v1" && slug[1] === "generate") {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad(400, "Expected a JSON body with a request field.");
    }
    const { model, stream, request } = body as {
      model?: unknown;
      stream?: unknown;
      request?: unknown;
    };
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return bad(400, "Expected request to be a Gemini generateContent payload.");
    }
    const modelId = model === undefined ? DEFAULT_HOSTED_MODEL_ID : String(model);
    if (!MODEL_ID_RE.test(modelId)) return bad(400, "Invalid model id.");
    if (!allowed.includes(modelId)) return bad(403, "Model not available on the hosted tier.");
    return {
      ok: true,
      plan: { modelId, stream: stream !== false, request: request as Record<string, unknown> },
    };
  }

  if (slug.length === 3 && slug[0] === "v1beta" && slug[1] === "models") {
    const [modelId, method, ...extra] = slug[2].split(":");
    if (extra.length > 0 || !MODEL_ID_RE.test(modelId)) return bad(404, "Unknown endpoint.");
    if (method !== "streamGenerateContent" && method !== "generateContent") {
      return bad(404, "Unknown endpoint.");
    }
    if (!allowed.includes(modelId)) return bad(403, "Model not available on the hosted tier.");
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return bad(400, "Expected a Gemini generateContent JSON body.");
    }
    return {
      ok: true,
      plan: {
        modelId,
        stream: method === "streamGenerateContent",
        request: body as Record<string, unknown>,
      },
    };
  }

  return bad(404, "Unknown endpoint.");
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

export type UpstreamResult =
  | { ok: true; upstream: UpstreamRequest; via: "gateway" | "direct" }
  | { ok: false; status: 503; error: string };

const DIRECT_GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Where the call actually goes. Decided on issue #10: Cloudflare AI Gateway
// in front of Gemini (CAPTURIA_AI_GATEWAY_URL, e.g.
// https://gateway.ai.cloudflare.com/v1/<account>/<gw>/google-ai-studio),
// with the Gemini key ideally living only in the gateway's secret store.
// Until that account exists, the dev fallback goes straight to Gemini with
// the server-side Google key. Headers are built fresh: the caller's JWT and
// any other client header must never travel upstream.
export function upstreamFor(plan: HostedPlan, env: Env = process.env): UpstreamResult {
  const gatewayBase = env.CAPTURIA_AI_GATEWAY_URL?.replace(/\/+$/, "");
  // Same key precedence as lib/server-keys.ts ENV_KEYS_BY_PROVIDER.
  const googleKey = env.GOOGLE_GENERATIVE_AI_API_KEY || env.GOOGLE_API_KEY;
  const method = plan.stream ? "streamGenerateContent" : "generateContent";
  const query = plan.stream ? "?alt=sse" : "";
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (gatewayBase) {
    if (env.CAPTURIA_AI_GATEWAY_TOKEN) {
      headers["cf-aig-authorization"] = `Bearer ${env.CAPTURIA_AI_GATEWAY_TOKEN}`;
    }
    // With gateway-side BYOK the Gemini key stays in Cloudflare; sending it
    // from here is the transitional mode until that secret store is set up.
    if (googleKey) headers["x-goog-api-key"] = googleKey;
    return {
      ok: true,
      via: "gateway",
      upstream: {
        url: `${gatewayBase}/v1beta/models/${plan.modelId}:${method}${query}`,
        headers,
      },
    };
  }

  if (!googleKey) {
    return {
      ok: false,
      status: 503,
      error:
        "Hosted generation is not configured: set CAPTURIA_AI_GATEWAY_URL or a server-side GOOGLE_API_KEY.",
    };
  }
  headers["x-goog-api-key"] = googleKey;
  return {
    ok: true,
    via: "direct",
    upstream: {
      url: `${DIRECT_GEMINI_BASE}/models/${plan.modelId}:${method}${query}`,
      headers,
    },
  };
}

export interface UsageTotals {
  totalTokens: number;
  promptTokens: number;
  outputTokens: number;
}

export interface UsageObserver {
  /** Feed decoded response text as it streams through. */
  write(chunk: string): void;
  /** Best-effort totals observed so far, or null when none arrived. */
  usage(): UsageTotals | null;
}

function usageFrom(parsed: unknown): UsageTotals | null {
  const meta = (parsed as { usageMetadata?: Record<string, unknown> })?.usageMetadata;
  if (!meta || typeof meta !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    totalTokens: num(meta.totalTokenCount),
    promptTokens: num(meta.promptTokenCount),
    outputTokens: num(meta.candidatesTokenCount),
  };
}

// Watches the Gemini SSE stream for usageMetadata (the final data frame
// carries the totals) without disturbing the bytes in flight. Partial lines
// are buffered across chunks; anything unparseable is ignored, because usage
// observation must never be able to break the stream itself.
export function createSseUsageObserver(): UsageObserver {
  let buffer = "";
  let latest: UsageTotals | null = null;
  const consume = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const seen = usageFrom(JSON.parse(payload));
      if (seen) latest = seen;
    } catch {
      // partial or non-JSON frame: not ours to judge
    }
  };
  return {
    write(chunk) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consume(buffer.slice(0, newline).replace(/\r$/, ""));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      // Cap the tail so a pathological no-newline stream cannot grow memory.
      if (buffer.length > 65536) buffer = buffer.slice(-32768);
    },
    usage() {
      if (buffer) {
        consume(buffer.replace(/\r$/, ""));
        buffer = "";
      }
      return latest;
    },
  };
}

// Non-streaming :generateContent responses carry usage in the body JSON.
export function usageFromJsonBody(body: unknown): UsageTotals | null {
  return usageFrom(body);
}
