// Hosted LLM proxy (M11 slice 1, issue #10): the paid-tier alternative to
// BYOK. Runs as a plain Vercel function in this app per the owner decision
// (lift-and-shift to a Worker stays possible: same gateway, same Redis).
//
// Request path per call:
//   1. Verify the Capturia-signed Ed25519 JWT statelessly (lib/hosted/jwt.ts).
//   2. Redis brakes (lib/hosted/gate.ts): kill switch, entitlement cache,
//      ~10/min sliding-window rate limit, monthly token budget, and a
//      one-concurrent-stream lease.
//   3. Forward the Gemini-wire request to Cloudflare AI Gateway
//      (CAPTURIA_AI_GATEWAY_URL) or, in dev, straight to Gemini with the
//      server-side Google key, and stream the response back.
//   4. On stream end: release the lease, record one usage event to Redis and
//      (when a Stripe key exists) to Stripe Billing Meters.
//
// FREE-TIER DISCIPLINE: nothing in the free web demo or the BYOK desktop
// path calls this route or needs its env; without a valid Capturia JWT it
// answers 401/503 and spends nothing. See docs/hosted-tier.md.

import { randomUUID } from "node:crypto";
import { jwtPublicKeyFromEnv, verifyHostedJwt } from "@/lib/hosted/jwt";
import { getHostedBackend } from "@/lib/hosted/backend";
import { gateConfigFromEnv, gateHostedCall, recordUsage, type Lease } from "@/lib/hosted/gate";
import {
  createSseUsageObserver,
  planHostedCall,
  upstreamFor,
  usageFromJsonBody,
  type UsageTotals,
} from "@/lib/hosted/proxy";
import { recordMeterEvent, stripeFromEnv } from "@/lib/billing/stripe";
import type { RedisRunner } from "@/lib/upstash";

// Streams are per-request model output; nothing here is cacheable.
export const dynamic = "force-dynamic";
// One generation batch is seconds (maxSteps:1 overlays); 60s is generous
// headroom without letting a wedged upstream hold a function open forever.
export const maxDuration = 60;

function jsonError(status: number, error: string, retryAfterSec?: number): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(retryAfterSec ? { "retry-after": String(retryAfterSec) } : {}),
      },
    }
  );
}

// @ai-sdk/google sends the key slot as x-goog-api-key; curl and future
// clients may prefer a standard bearer. Either carries the Capturia JWT.
function tokenFromRequest(request: Request): string | null {
  const googHeader = request.headers.get("x-goog-api-key");
  if (googHeader) return googHeader;
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

// One settle path for lease release + usage accounting, idempotent because
// both the clean end and a client cancel can race to it. Stripe metering is
// awaited but failure-tolerant: billing lag must never break a response the
// user already saw. requestId doubles as the meter-event identifier, so a
// double settle could not double-bill even if it happened.
function makeSettler(run: RedisRunner, customer: string, lease: Lease, requestId: string) {
  let settled = false;
  return async (usage: UsageTotals | null) => {
    if (settled) return;
    settled = true;
    try {
      await lease.release();
      const tokens = usage?.totalTokens ?? 0;
      await recordUsage(run, customer, tokens, Date.now());
      const stripe = stripeFromEnv(process.env);
      if (stripe) {
        await recordMeterEvent(stripe, { customer, value: tokens, identifier: requestId }).catch(
          () => {
            // Redis kept the count; Stripe meters are reconciled, not load-bearing.
          }
        );
      }
    } catch {
      // The lease TTL is the backstop; never surface accounting errors.
    }
  };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ slug?: string[] }> }
): Promise<Response> {
  const { slug = [] } = await ctx.params;

  const publicKey = jwtPublicKeyFromEnv(process.env);
  if (!publicKey) {
    return jsonError(503, "Hosted tier is not configured on this deployment.");
  }
  const verdict = verifyHostedJwt(tokenFromRequest(request), publicKey);
  if (!verdict.ok) return jsonError(401, verdict.error);
  const customer = verdict.claims.sub;

  const body: unknown = await request.json().catch(() => null);
  const planned = planHostedCall(slug, body, process.env);
  if (!planned.ok) return jsonError(planned.status, planned.error);

  const upstream = upstreamFor(planned.plan, process.env);
  if (!upstream.ok) return jsonError(upstream.status, upstream.error);

  const backend = await getHostedBackend(process.env);
  const requestId = randomUUID();
  const gate = await gateHostedCall(
    backend.run,
    customer,
    gateConfigFromEnv(process.env),
    requestId
  );
  if (!gate.ok) return jsonError(gate.status, gate.error, gate.retryAfterSec);

  const settle = makeSettler(backend.run, customer, gate.lease, requestId);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream.upstream.url, {
      method: "POST",
      headers: upstream.upstream.headers,
      body: JSON.stringify(planned.plan.request),
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    await settle(null);
    return jsonError(502, "Upstream model call failed.");
  }

  if (!upstreamRes.ok) {
    // Pass the upstream status and JSON body through (Gemini errors explain
    // malformed requests), but never its headers, and don't meter failures.
    const errorBody = await upstreamRes.text().catch(() => "");
    await settle(null);
    return new Response(errorBody || JSON.stringify({ error: "Upstream model error." }), {
      status: upstreamRes.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  if (!planned.plan.stream) {
    const json: unknown = await upstreamRes.json().catch(() => null);
    await settle(usageFromJsonBody(json));
    return Response.json(json ?? {}, { headers: { "cache-control": "no-store" } });
  }

  const upstreamBody = upstreamRes.body;
  if (!upstreamBody) {
    await settle(null);
    return jsonError(502, "Upstream returned no stream.");
  }

  // Relay the SSE bytes untouched while the observer watches for the final
  // usageMetadata frame. Settling happens exactly once, on clean end, error,
  // or client cancel; the lease TTL covers a function killed mid-flight.
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const observer = createSseUsageObserver();
  const relay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await settle(observer.usage());
          return;
        }
        observer.write(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (err) {
        await settle(observer.usage());
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

  return new Response(relay, {
    status: 200,
    headers: {
      "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
