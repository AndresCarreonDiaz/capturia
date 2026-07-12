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
  /**
   * Gemini GenerateContentRequest, forwarded with two hosted-tier
   * adjustments: media parts are refused and maxOutputTokens is clamped
   * (see sanitizeHostedRequest).
   */
  request: Record<string, unknown>;
}

export type PlanResult =
  | { ok: true; plan: HostedPlan }
  | { ok: false; status: number; error: string };

function bad(status: number, error: string): PlanResult {
  return { ok: false, status, error };
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{1,80}$/i;

export const DEFAULT_HOSTED_MAX_OUTPUT_TOKENS = 8192;

// Token cost must stay coupled to request size for the budget brakes to
// mean anything. fileData (a ~100-byte YouTube URI can cost ~300 tokens per
// SECOND of video on Capturia's key) and inlineData (base64 media) decouple
// it, and nothing in the product sends media through the hosted tier, so
// both are refused server-side. Output volume is clamped per request so the
// rate limit bounds total spend, not just call count; deck codegen asks for
// 4096 and overlays far less, so the default cap is generous.
function sanitizeHostedRequest(
  request: Record<string, unknown>,
  env: Env
): { ok: true; request: Record<string, unknown> } | { ok: false; error: string } {
  const groups: unknown[] = [];
  if (Array.isArray(request.contents)) groups.push(...request.contents);
  if (request.systemInstruction) groups.push(request.systemInstruction);
  for (const content of groups) {
    const parts = (content as { parts?: unknown })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part && typeof part === "object" && ("fileData" in part || "inlineData" in part)) {
        return { ok: false, error: "Media inputs are not available on the hosted tier." };
      }
    }
  }
  const capRaw = Math.floor(Number(env.CAPTURIA_HOSTED_MAX_OUTPUT_TOKENS));
  const cap =
    Number.isFinite(capRaw) && capRaw > 0 ? capRaw : DEFAULT_HOSTED_MAX_OUTPUT_TOKENS;
  const rawConfig = request.generationConfig;
  const generationConfig =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? { ...(rawConfig as Record<string, unknown>) }
      : {};
  const requested = Number(generationConfig.maxOutputTokens);
  generationConfig.maxOutputTokens =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), cap) : cap;
  return { ok: true, request: { ...request, generationConfig } };
}

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
    const sanitized = sanitizeHostedRequest(request as Record<string, unknown>, env);
    if (!sanitized.ok) return bad(400, sanitized.error);
    return {
      ok: true,
      plan: { modelId, stream: stream !== false, request: sanitized.request },
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
    const sanitized = sanitizeHostedRequest(body as Record<string, unknown>, env);
    if (!sanitized.ok) return bad(400, sanitized.error);
    return {
      ok: true,
      plan: {
        modelId,
        stream: method === "streamGenerateContent",
        request: sanitized.request,
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

// Reads at most maxBytes from a request body, counting BYTES incrementally
// and cancelling the stream the moment the cap is crossed, so a chunked
// request with no content-length header can never buffer unbounded memory
// the way an unconditional request.text() would.
export type CappedBody = { ok: true; text: string } | { ok: false };

export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<CappedBody> {
  if (!body) return { ok: true, text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body too large").catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

// Conservative prompt-token estimate from the serialized request (the usual
// ~4 chars/token heuristic). This is the abort brake: a client that opens a
// stream with a huge prompt and bails before Gemini's final usageMetadata
// frame still gets charged roughly what the input cost, instead of the
// 1-token floor that made the monthly budget bypassable.
export function estimateTokensForRequest(request: unknown): number {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(request).length / 4));
  } catch {
    return 1;
  }
}

export interface SettleOptions {
  /**
   * false on failure paths (upstream fetch threw, non-2xx, missing body):
   * the lease is released but nothing is recorded or metered, because a call
   * that produced no model work must not cost the customer anything.
   */
  metered?: boolean;
}

export interface Settler {
  /** Idempotent: the first call wins; clean end, error, and cancel can race to it. */
  settle(usage: UsageTotals | null, options?: SettleOptions): Promise<void>;
  /**
   * Resolves once the first settle() has run to completion (never rejects).
   * The route parks this on next/server's after() so a serverless runtime
   * cannot freeze the invocation before accounting lands.
   */
  done: Promise<void>;
}

export interface SettlerInput {
  lease: { release(): Promise<void> };
  /** Records tokens to the usage counter (Redis). */
  recordUsage(tokens: number): Promise<unknown>;
  /** Records tokens to the billing meter (Stripe); null when unconfigured. */
  recordMeter: ((tokens: number) => Promise<unknown>) | null;
  /** Fallback charge when a metered settle has no observed usage. */
  estimatedTokens: number;
}

// One settle path for lease release + usage accounting. Metering is awaited
// but failure-tolerant: billing lag must never break a response the user
// already saw. When observed usage is missing on a metered settle (client
// aborted before the usageMetadata frame), the request-size estimate is
// charged instead.
export function createSettler(input: SettlerInput): Settler {
  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    done,
    async settle(usage, options = {}) {
      if (settled) return;
      settled = true;
      try {
        await input.lease.release();
        if (options.metered !== false) {
          const observed = usage?.totalTokens ?? 0;
          const tokens = observed > 0 ? observed : input.estimatedTokens;
          await input.recordUsage(tokens);
          if (input.recordMeter) {
            await input.recordMeter(tokens).catch(() => {
              // Redis kept the count; Stripe meters are reconciled, not load-bearing.
            });
          }
        }
      } catch {
        // The lease TTL is the backstop; never surface accounting errors.
      } finally {
        resolveDone();
      }
    },
  };
}

// Relays the upstream SSE bytes untouched while the observer watches for the
// final usageMetadata frame. Settling happens exactly once, on clean end,
// error, or client cancel, and the clean-end settle completes BEFORE the
// stream closes so the response cannot finish (and the serverless invocation
// suspend) with accounting still in flight.
export function createRelayStream(
  upstreamBody: ReadableStream<Uint8Array>,
  observer: UsageObserver,
  settle: Settler["settle"]
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await settle(observer.usage());
          controller.close();
          return;
        }
        observer.write(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (err) {
        // The UPSTREAM died mid-stream: charge only what Gemini actually
        // reported (usually nothing; usageMetadata is the final frame). The
        // request-size estimate is reserved for CLIENT aborts (cancel below),
        // matching the route contract that upstream failures cost nothing.
        const usage = observer.usage();
        await settle(usage, { metered: usage !== null });
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // upstream already gone
      }
      await settle(observer.usage());
    },
  });
}
