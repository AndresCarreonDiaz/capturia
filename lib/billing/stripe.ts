// Minimal fetch-based Stripe client, in the spirit of lib/upstash.ts: the
// hosted tier needs four calls (checkout session, webhook verify, meter
// events, and the setup script's product/price/meter bootstrap), not an SDK.
// Zero dependencies means it runs identically in route handlers, scripts,
// and against stripe-mock (point STRIPE_API_BASE at it). Test mode only
// until the operator's live key exists; nothing here logs keys or payloads.

import { createHmac, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export interface StripeConfig {
  secretKey: string;
  baseUrl: string;
}

export function stripeFromEnv(env: Env = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return {
    secretKey,
    // STRIPE_API_BASE exists for stripe-mock (http://localhost:12111) and
    // never needs setting in real deployments.
    baseUrl: (env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, ""),
  };
}

// Stripe's request bodies are application/x-www-form-urlencoded with bracket
// notation for nesting: { line_items: [{ price: "p" }] } becomes
// "line_items[0][price]=p". Arrays index numerically, objects by key.
export function formEncode(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    } else if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}[${key}]` : key, nested);
      }
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };
  walk("", params);
  return pairs.join("&");
}

export interface StripeError extends Error {
  status: number;
}

// One REST call. GET sends params as query string, everything else as a form
// body. Throws with the Stripe error message (their bodies are safe to
// surface server-side; they never echo the secret key).
export async function stripeRequest(
  cfg: StripeConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const encoded = formEncode(params);
  const url = `${cfg.baseUrl}${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      ...(method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method !== "GET" ? { body: encoded } : {}),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    const detail =
      body && typeof body.error === "object" && body.error
        ? String((body.error as { message?: unknown }).message ?? "")
        : "";
    const err = new Error(`stripe: HTTP ${res.status}${detail ? ` (${detail})` : ""}`) as StripeError;
    err.status = res.status;
    throw err;
  }
  return body;
}

export const DEFAULT_SIGNATURE_TOLERANCE_S = 300;

// Stripe-Signature verification per the published scheme: header carries
// "t=<unix>,v1=<hmac>,..."; the signed payload is "<t>.<rawBody>" HMAC'd
// with the endpoint secret. Comparison is timing-safe and the timestamp must
// be inside the tolerance window (replay brake). Multiple v1 entries are
// checked because Stripe sends several during secret rotation.
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  webhookSecret: string,
  nowMs = Date.now(),
  toleranceSec = DEFAULT_SIGNATURE_TOLERANCE_S
): boolean {
  if (!signatureHeader) return false;
  let timestamp = "";
  const candidates: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim() ?? "");
    if (key === "t") timestamp = value;
    if (key === "v1" && value) candidates.push(value);
  }
  if (!/^\d+$/.test(timestamp) || candidates.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSec) return false;

  const expected = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected);
  return candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate);
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });
}

// The Billing Meter event name the setup script provisions; the meter
// aggregates value (tokens) per stripe_customer_id.
export const METER_EVENT_NAME = "capturia_hosted_tokens";

// One usage event per generation batch, identifier-deduplicated so a retried
// settle can never double-bill. Failures are the caller's to swallow: usage
// accounting must never break a stream that already reached the user.
export async function recordMeterEvent(
  cfg: StripeConfig,
  input: { customer: string; value: number; identifier: string },
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  await stripeRequest(
    cfg,
    "POST",
    "/v1/billing/meter_events",
    {
      event_name: METER_EVENT_NAME,
      identifier: input.identifier,
      payload: {
        stripe_customer_id: input.customer,
        value: String(Math.max(1, Math.floor(input.value) || 0)),
      },
    },
    fetchImpl
  );
}
