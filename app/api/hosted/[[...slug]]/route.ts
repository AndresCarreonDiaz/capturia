// Hosted LLM proxy (M11 slice 1, issue #10): the paid-tier alternative to
// BYOK. Runs as a plain Vercel function in this app per the owner decision
// (lift-and-shift to a Worker stays possible: same gateway, same Redis).
//
// Request path per call:
//   1. Verify the Capturia-signed Ed25519 JWT statelessly (lib/hosted/jwt.ts).
//   2. Redis brakes (lib/hosted/gate.ts): kill switch, entitlement cache,
//      ~10/min sliding-window rate limit, and the monthly token budget, all
//      BEFORE the body is read so an oversized or malformed payload cannot
//      spend anything. Then the size-capped body is parsed and a per-lane
//      lease (one live stream + one deck codegen batch) is acquired.
//   3. Forward the Gemini-wire request to Cloudflare AI Gateway
//      (CAPTURIA_AI_GATEWAY_URL) or, in dev, straight to Gemini with the
//      server-side Google key, and stream the response back.
//   4. On stream end: release the lease, record one usage event to Redis and
//      (when a Stripe key exists) to Stripe Billing Meters. A client abort
//      before Gemini's usageMetadata frame is charged the request-size
//      estimate; upstream failures release the lease and charge nothing.
//      Settlement is parked on after() so a serverless suspend cannot lose it.
//
// FREE-TIER DISCIPLINE: nothing in the free web demo or the BYOK desktop
// path calls this route or needs its env; without a valid Capturia JWT it
// answers 401/503 and spends nothing. See docs/hosted-tier.md.

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { jwtPublicKeyFromEnv, verifyHostedJwt } from "@/lib/hosted/jwt";
import { getHostedBackend } from "@/lib/hosted/backend";
import {
  acquireLease,
  gateConfigFromEnv,
  gateFlashBudget,
  gateHostedCall,
  recordUsage,
  type GateRefusalCode,
} from "@/lib/hosted/gate";
import {
  createRelayStream,
  createSettler,
  createSseUsageObserver,
  estimateTokensForRequest,
  planHostedCall,
  readBodyCapped,
  upstreamFor,
  usageFromJsonBody,
} from "@/lib/hosted/proxy";
import { recordMeterEvent, stripeFromEnv } from "@/lib/billing/stripe";

// Streams are per-request model output; nothing here is cacheable.
export const dynamic = "force-dynamic";
// One generation batch is seconds (maxSteps:1 overlays); 60s is generous
// headroom without letting a wedged upstream hold a function open forever.
export const maxDuration = 60;

// Gemini payloads here are prompt-sized JSON; 1 MB is far above any real
// deck or overlay request and small enough that parsing before the lease is
// harmless. Enforced against content-length up front AND byte-by-byte while
// reading (readBodyCapped), so a chunked request with no length header still
// cannot buffer more than the cap.
const MAX_BODY_BYTES = 1_000_000;

function jsonError(
  status: number,
  error: string,
  retryAfterSec?: number,
  code?: GateRefusalCode
): Response {
  // Budget refusals additionally ride the Gemini error shape: it is the one
  // error body @ai-sdk/google's failedResponseHandler parses, so the marker-
  // tagged message (not a bare statusText) becomes the APICallError the
  // desktop renderer classifies (lib/desktop-runtime.ts). The top-level
  // `capturia` field carries the same code for curl and scripts.
  const body = code
    ? { error: { code: status, message: error, status: "RESOURCE_EXHAUSTED" }, capturia: code }
    : { error };
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(retryAfterSec ? { "retry-after": String(retryAfterSec) } : {}),
    },
  });
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

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonError(413, "Request body too large.");
  }

  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return jsonError(503, "Hosted tier state backend is not configured.");
  }

  const gateConfig = gateConfigFromEnv(process.env);
  const gate = await gateHostedCall(backend.run, customer, gateConfig);
  if (!gate.ok) return jsonError(gate.status, gate.error, gate.retryAfterSec, gate.code);

  const rawBody = await readBodyCapped(request.body, MAX_BODY_BYTES).catch(() => null);
  if (!rawBody) return jsonError(400, "Could not read request body.");
  if (!rawBody.ok) return jsonError(413, "Request body too large.");
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody.text);
  } catch {
    // planHostedCall answers a precise 400 for a null body.
  }
  const planned = planHostedCall(slug, body, process.env);
  if (!planned.ok) return jsonError(planned.status, planned.error);

  // Model-scoped sub-budget, checkable only now that the model is known:
  // flash (deck codegen) can be exhausted while lite-tier traffic continues.
  const flashGate = await gateFlashBudget(backend.run, customer, planned.plan.modelId, gateConfig);
  if (!flashGate.ok) {
    return jsonError(flashGate.status, flashGate.error, flashGate.retryAfterSec, flashGate.code);
  }

  const upstream = upstreamFor(planned.plan, process.env);
  if (!upstream.ok) return jsonError(upstream.status, upstream.error);

  const requestId = randomUUID();
  const lease = await acquireLease(
    backend.run,
    customer,
    gateConfig.leaseTtlMs,
    requestId,
    planned.plan.stream ? "stream" : "batch"
  );
  if (!lease) {
    return jsonError(409, "Another generation is already streaming for this account.");
  }

  // requestId doubles as the meter-event identifier, so even a double settle
  // could not double-bill.
  const stripe = stripeFromEnv(process.env);
  const settler = createSettler({
    lease,
    estimatedTokens: estimateTokensForRequest(planned.plan.request),
    recordUsage: (tokens) =>
      recordUsage(backend.run, customer, tokens, Date.now(), planned.plan.modelId),
    recordMeter: stripe
      ? (tokens) => recordMeterEvent(stripe, { customer, value: tokens, identifier: requestId })
      : null,
  });
  const settle = settler.settle;
  // Vercel freezes the invocation once the response finishes; parking the
  // settle barrier on after() keeps it alive until lease release and usage
  // recording have actually landed, on every exit path including client
  // aborts. (See node_modules/next/dist/docs on after() + waitUntil.)
  after(() => settler.done);

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
    await settle(null, { metered: false });
    return jsonError(502, "Upstream model call failed.");
  }

  if (!upstreamRes.ok) {
    // Pass the upstream status and JSON body through (Gemini errors explain
    // malformed requests), but never its headers, and don't meter failures.
    const errorBody = await upstreamRes.text().catch(() => "");
    await settle(null, { metered: false });
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
    await settle(null, { metered: false });
    return jsonError(502, "Upstream returned no stream.");
  }

  const relay = createRelayStream(upstreamBody, createSseUsageObserver(), settle);

  return new Response(relay, {
    status: 200,
    headers: {
      "content-type": upstreamRes.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-store",
    },
  });
}
