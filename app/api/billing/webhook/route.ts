// Stripe webhook receiver (M11 slice 1). Signature-verified against
// STRIPE_WEBHOOK_SECRET, then applied to the Redis entitlement cache by
// lib/hosted/entitlements.ts:
//   checkout.session.completed /
//   checkout.session.async_payment_succeeded -> entitlement + activation code
//   customer.subscription.updated            -> entitlement cache follows status
//   customer.subscription.deleted            -> entitlement revoked
// Deliveries are deduplicated on event.id and ordered by event.created in
// applyStripeEvent, because Stripe is at-least-once and unordered. Stripe
// stays the source of truth; Redis is the runtime cache the proxy and token
// endpoints consult. Unhandled event types are acked with 200 so the
// endpoint can be subscribed broadly without retry storms.

import { verifyStripeSignature } from "@/lib/billing/stripe";
import { applyStripeEvent } from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 }
    );
  }

  // Raw body BEFORE parsing: the signature covers the exact bytes.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  // A misconfigured backend (in-memory in production) must NOT 200-ack:
  // Stripe keeps retrying until real Redis env exists, so no paid checkout
  // is ever acknowledged into a store that forgets it.
  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return Response.json({ error: "Billing state backend is not configured." }, { status: 503 });
  }
  // A transient Redis fault mid-apply must answer non-2xx: the dedup marker
  // is only written after the event's effects land, so Stripe's retry of a
  // failed delivery re-processes it instead of being swallowed.
  let outcome;
  try {
    outcome = await applyStripeEvent(
      backend.run,
      event as Parameters<typeof applyStripeEvent>[1],
      Date.now()
    );
  } catch {
    return Response.json({ error: "Event processing failed; retry." }, { status: 500 });
  }
  // ids only; never codes, tokens, or full event payloads.
  if (outcome.handled) {
    console.log(`capturia billing: ${outcome.action} for ${outcome.customer ?? "unknown"}`);
  }
  return Response.json({ received: true });
}
