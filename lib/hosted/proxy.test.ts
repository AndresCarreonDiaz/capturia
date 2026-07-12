// Pins the proxy planning surface (lib/hosted/proxy.ts): both accepted path
// shapes (the /v1/generate alias and the raw @ai-sdk/google wire), the
// server-side model allowlist, gateway-vs-direct upstream construction, SSE
// usage extraction, and the settle/relay machinery the route builds its
// streaming response from (lease release + usage accounting on every exit
// path, including client aborts).

import { describe, expect, it } from "vitest";
import {
  allowedHostedModels,
  createRelayStream,
  createSettler,
  createSseUsageObserver,
  DEFAULT_HOSTED_MODEL_ID,
  estimateTokensForRequest,
  planHostedCall,
  upstreamFor,
  usageFromJsonBody,
  type UsageTotals,
} from "./proxy";

const GEMINI_BODY = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };

describe("allowedHostedModels", () => {
  it("defaults to the two hosted Gemini tiers", () => {
    expect(allowedHostedModels({})).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
  });

  it("honors the CAPTURIA_HOSTED_MODELS csv override and survives junk", () => {
    expect(allowedHostedModels({ CAPTURIA_HOSTED_MODELS: "gemini-2.5-pro, gemini-2.5-flash" })).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
    expect(allowedHostedModels({ CAPTURIA_HOSTED_MODELS: " ,, " })).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
    ]);
  });
});

describe("planHostedCall", () => {
  it("plans the /v1/generate alias with defaults", () => {
    const res = planHostedCall(["v1", "generate"], { request: GEMINI_BODY }, {});
    expect(res).toEqual({
      ok: true,
      plan: { modelId: DEFAULT_HOSTED_MODEL_ID, stream: true, request: GEMINI_BODY },
    });
  });

  it("plans the raw @ai-sdk/google wire shape (the desktop drop-in)", () => {
    const res = planHostedCall(
      ["v1beta", "models", "gemini-2.5-flash-lite:streamGenerateContent"],
      GEMINI_BODY,
      {}
    );
    expect(res).toEqual({
      ok: true,
      plan: { modelId: "gemini-2.5-flash-lite", stream: true, request: GEMINI_BODY },
    });
  });

  it("plans non-streaming :generateContent", () => {
    const res = planHostedCall(["v1beta", "models", "gemini-2.5-flash:generateContent"], GEMINI_BODY, {});
    expect(res).toMatchObject({ ok: true, plan: { stream: false } });
  });

  it("respects stream:false on the alias", () => {
    const res = planHostedCall(["v1", "generate"], { request: GEMINI_BODY, stream: false }, {});
    expect(res).toMatchObject({ ok: true, plan: { stream: false } });
  });

  it("403s a model outside the allowlist on BOTH shapes", () => {
    expect(planHostedCall(["v1", "generate"], { request: GEMINI_BODY, model: "gemini-2.5-pro" }, {})).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      planHostedCall(["v1beta", "models", "gemini-2.5-pro:streamGenerateContent"], GEMINI_BODY, {})
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("400s missing or non-object request bodies", () => {
    expect(planHostedCall(["v1", "generate"], null, {})).toMatchObject({ ok: false, status: 400 });
    expect(planHostedCall(["v1", "generate"], { request: "hi" }, {})).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      planHostedCall(["v1beta", "models", "gemini-2.5-flash:generateContent"], null, {})
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("404s unknown paths and methods", () => {
    expect(planHostedCall([], GEMINI_BODY, {})).toMatchObject({ ok: false, status: 404 });
    expect(planHostedCall(["v1", "chat"], GEMINI_BODY, {})).toMatchObject({ ok: false, status: 404 });
    expect(
      planHostedCall(["v1beta", "models", "gemini-2.5-flash:countTokens"], GEMINI_BODY, {})
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      planHostedCall(["v1beta", "models", "a:b:streamGenerateContent"], GEMINI_BODY, {})
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("upstreamFor", () => {
  const plan = { modelId: "gemini-2.5-flash-lite", stream: true, request: GEMINI_BODY };

  it("routes through the Cloudflare AI Gateway when configured", () => {
    const res = upstreamFor(plan, {
      CAPTURIA_AI_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/",
      CAPTURIA_AI_GATEWAY_TOKEN: "gw-token",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.via).toBe("gateway");
      expect(res.upstream.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse"
      );
      expect(res.upstream.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
      // Gateway-side BYOK: no Google key here means none is sent.
      expect(res.upstream.headers["x-goog-api-key"]).toBeUndefined();
    }
  });

  it("falls back to direct Gemini with the server-side key in dev", () => {
    const res = upstreamFor(plan, { GOOGLE_API_KEY: "server-key" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.via).toBe("direct");
      expect(res.upstream.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse"
      );
      expect(res.upstream.headers["x-goog-api-key"]).toBe("server-key");
    }
  });

  it("prefers GOOGLE_GENERATIVE_AI_API_KEY, matching lib/server-keys.ts", () => {
    const res = upstreamFor(plan, {
      GOOGLE_GENERATIVE_AI_API_KEY: "genai-key",
      GOOGLE_API_KEY: "aistudio-key",
    });
    expect(res.ok && res.upstream.headers["x-goog-api-key"]).toBe("genai-key");
  });

  it("omits ?alt=sse for non-streaming calls", () => {
    const res = upstreamFor({ ...plan, stream: false }, { GOOGLE_API_KEY: "k" });
    expect(res.ok && res.upstream.url.endsWith(":generateContent")).toBe(true);
  });

  it("503s when neither gateway nor key is configured", () => {
    expect(upstreamFor(plan, {})).toMatchObject({ ok: false, status: 503 });
  });
});

describe("usage observation", () => {
  it("extracts the last usageMetadata from an SSE stream, across chunk splits", () => {
    const obs = createSseUsageObserver();
    const frame1 = `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } })}\r\n\r\n`;
    const frame2 = `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 25, totalTokenCount: 35 } })}\n\n`;
    // Feed in awkward slices to prove partial-line buffering works.
    const text = frame1 + frame2;
    for (let i = 0; i < text.length; i += 7) obs.write(text.slice(i, i + 7));
    expect(obs.usage()).toEqual({ totalTokens: 35, promptTokens: 10, outputTokens: 25 });
  });

  it("handles a final frame without a trailing newline", () => {
    const obs = createSseUsageObserver();
    obs.write(`data: ${JSON.stringify({ usageMetadata: { totalTokenCount: 7 } })}`);
    expect(obs.usage()).toEqual({ totalTokens: 7, promptTokens: 0, outputTokens: 0 });
  });

  it("returns null when no usage ever arrives and ignores junk frames", () => {
    const obs = createSseUsageObserver();
    obs.write("data: {broken json\n\n: keepalive\n\ndata: [DONE]\n\n");
    expect(obs.usage()).toBeNull();
  });

  it("reads usage out of a non-streaming JSON body", () => {
    expect(
      usageFromJsonBody({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } })
    ).toEqual({ totalTokens: 7, promptTokens: 3, outputTokens: 4 });
    expect(usageFromJsonBody({})).toBeNull();
    expect(usageFromJsonBody(null)).toBeNull();
  });
});

describe("estimateTokensForRequest", () => {
  it("scales with the serialized request size and never returns 0", () => {
    expect(estimateTokensForRequest({})).toBeGreaterThanOrEqual(1);
    const big = { contents: [{ parts: [{ text: "x".repeat(40_000) }] }] };
    expect(estimateTokensForRequest(big)).toBeGreaterThan(9_000);
    // Unserializable input degrades to the 1-token floor, never a throw.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateTokensForRequest(cyclic)).toBe(1);
  });
});

// A settler harness with observable side effects and no Redis or Stripe.
function settlerWorld(over: { estimatedTokens?: number; failMeter?: boolean; failUsage?: boolean } = {}) {
  const calls = { released: 0, recorded: [] as number[], metered: [] as number[] };
  const settler = createSettler({
    lease: {
      async release() {
        calls.released++;
      },
    },
    recordUsage: async (tokens) => {
      if (over.failUsage) throw new Error("redis down");
      calls.recorded.push(tokens);
    },
    recordMeter: async (tokens) => {
      if (over.failMeter) throw new Error("stripe down");
      calls.metered.push(tokens);
    },
    estimatedTokens: over.estimatedTokens ?? 500,
  });
  return { settler, calls };
}

const USAGE: UsageTotals = { totalTokens: 42, promptTokens: 30, outputTokens: 12 };

describe("createSettler", () => {
  it("settles exactly once: later calls are no-ops", async () => {
    const { settler, calls } = settlerWorld();
    await settler.settle(USAGE);
    await settler.settle(null);
    await settler.settle(USAGE);
    expect(calls.released).toBe(1);
    expect(calls.recorded).toEqual([42]);
    expect(calls.metered).toEqual([42]);
    await settler.done; // resolved, not hanging
  });

  it("charges the request-size estimate when the client bailed before usage arrived", async () => {
    const { settler, calls } = settlerWorld({ estimatedTokens: 777 });
    await settler.settle(null);
    expect(calls.released).toBe(1);
    expect(calls.recorded).toEqual([777]);
    expect(calls.metered).toEqual([777]);
  });

  it("releases the lease but records and meters NOTHING on failure settles", async () => {
    const { settler, calls } = settlerWorld();
    await settler.settle(null, { metered: false });
    expect(calls.released).toBe(1);
    expect(calls.recorded).toEqual([]);
    expect(calls.metered).toEqual([]);
    await settler.done;
  });

  it("swallows meter failures (Redis kept the count) and never rejects", async () => {
    const { settler, calls } = settlerWorld({ failMeter: true });
    await expect(settler.settle(USAGE)).resolves.toBeUndefined();
    expect(calls.recorded).toEqual([42]);
    await settler.done;
  });

  it("resolves the done barrier even when accounting itself throws", async () => {
    const { settler, calls } = settlerWorld({ failUsage: true });
    await expect(settler.settle(USAGE)).resolves.toBeUndefined();
    expect(calls.released).toBe(1);
    await settler.done;
    void calls;
  });
});

function sseBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function upstreamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("createRelayStream", () => {
  const USAGE_FRAME = `data: ${JSON.stringify({
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 },
  })}\n\n`;

  it("relays bytes untouched and settles once with the observed usage BEFORE closing", async () => {
    const { settler, calls } = settlerWorld();
    const events: string[] = [];
    const originalSettle = settler.settle;
    const relay = createRelayStream(
      upstreamOf(sseBytes("data: {}\n\n"), sseBytes(USAGE_FRAME)),
      createSseUsageObserver(),
      async (usage, opts) => {
        events.push("settle");
        await originalSettle(usage, opts);
      }
    );
    const reader = relay.getReader();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        events.push("closed");
        break;
      }
      out += new TextDecoder().decode(value);
    }
    expect(out).toBe("data: {}\n\n" + USAGE_FRAME);
    // The accounting landed before the stream reported done to the consumer.
    expect(events).toEqual(["settle", "closed"]);
    expect(calls.released).toBe(1);
    expect(calls.recorded).toEqual([11]);
  });

  it("cancel mid-stream releases the lease and records exactly once (abort brake)", async () => {
    const { settler, calls } = settlerWorld({ estimatedTokens: 321 });
    // An endless upstream that never sends usageMetadata.
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(sseBytes("data: {\"candidates\":[]}\n\n"));
      },
    });
    const relay = createRelayStream(upstream, createSseUsageObserver(), settler.settle);
    const reader = relay.getReader();
    await reader.read();
    await reader.cancel("client went away");
    await settler.done;
    expect(calls.released).toBe(1);
    // No usage frame ever arrived: the estimate is charged, not ~0.
    expect(calls.recorded).toEqual([321]);
  });

  it("an upstream read error settles once and surfaces the error", async () => {
    const { settler, calls } = settlerWorld();
    const upstream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("upstream reset");
      },
    });
    const relay = createRelayStream(upstream, createSseUsageObserver(), settler.settle);
    const reader = relay.getReader();
    await expect(reader.read()).rejects.toThrow("upstream reset");
    await settler.done;
    expect(calls.released).toBe(1);
    expect(calls.recorded).toHaveLength(1);
  });
});
