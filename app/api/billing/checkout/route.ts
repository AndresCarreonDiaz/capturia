// Creates a Stripe Checkout session for Capturia Pro (M11 slice 1). Stripe
// test mode until the operator's live key exists; the product/price come
// from scripts/hosted-setup-stripe.mjs (idempotent) and are pinned by
// STRIPE_PRICE_ID. No user accounts: the buyer's identity lives in Stripe,
// and the webhook turns a completed checkout into an activation code.
//
// The response carries ONLY the checkout URL. The activation-code pickup is
// bound to a per-session nonce that travels in the success URL (and to the
// webhook via session metadata), so knowing a session id alone, including
// the one embedded in a forwarded checkout link, retrieves nothing.
//
// FREE-TIER DISCIPLINE: the free demo and BYOK flows never call this; when
// Stripe env is absent it answers 503 and nothing else in the app cares.

import { randomBytes } from "node:crypto";
import { stripeFromEnv, stripeRequest } from "@/lib/billing/stripe";
import { getHostedBackend } from "@/lib/hosted/backend";
import { checkRateLimit, clientIpFrom } from "@/lib/hosted/gate";

export const dynamic = "force-dynamic";

// Anonymous endpoint that triggers an outbound Stripe write: keep the per-IP
// cadence human-scale so it cannot be used to hammer Stripe on our key.
const CHECKOUTS_PER_MINUTE = 5;

export async function POST(request: Request): Promise<Response> {
  const stripe = stripeFromEnv(process.env);
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!stripe || !priceId) {
    return Response.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 }
    );
  }

  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return Response.json({ error: "Billing state backend is not configured." }, { status: 503 });
  }
  const rate = await checkRateLimit(
    backend.run,
    `checkout-ip:${clientIpFrom(request)}`,
    CHECKOUTS_PER_MINUTE,
    Date.now()
  );
  if (!rate.allowed) {
    return Response.json(
      { error: "Too many checkout attempts, slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    );
  }

  const origin = process.env.CAPTURIA_CHECKOUT_ORIGIN || new URL(request.url).origin;
  const pickup = randomBytes(18).toString("base64url");
  try {
    const session = await stripeRequest(stripe, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // Shows Checkout's promo-code box: founder/friend coupons are minted in
      // the Stripe dashboard, never in code.
      allow_promotion_codes: true,
      // The success page (slice 2 UX) picks the activation code up once via
      // /api/billing/activation-code?session_id=...&pickup=...; the webhook
      // learns the nonce through the session metadata.
      metadata: { pickup },
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}&pickup=${pickup}`,
      cancel_url: `${origin}/?checkout=cancelled`,
    });
    return Response.json({ url: session.url });
  } catch {
    // Stripe error details stay server-side; the caller only needs "retry".
    return Response.json({ error: "Could not start checkout." }, { status: 502 });
  }
}
