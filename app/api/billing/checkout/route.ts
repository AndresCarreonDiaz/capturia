// Creates a Stripe Checkout session for Capturia Pro (M11 slice 1). Stripe
// test mode until the operator's live key exists; the product/price come
// from scripts/hosted-setup-stripe.mjs (idempotent) and are pinned by
// STRIPE_PRICE_ID. No user accounts: the buyer's identity lives in Stripe,
// and the webhook turns a completed checkout into an activation code.
//
// FREE-TIER DISCIPLINE: the free demo and BYOK flows never call this; when
// Stripe env is absent it answers 503 and nothing else in the app cares.

import { stripeFromEnv, stripeRequest } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const stripe = stripeFromEnv(process.env);
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!stripe || !priceId) {
    return Response.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 }
    );
  }

  const origin = process.env.CAPTURIA_CHECKOUT_ORIGIN || new URL(request.url).origin;
  try {
    const session = await stripeRequest(stripe, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      // The success page (slice 2 UX) picks the activation code up once via
      // /api/billing/activation-code?session_id=...
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancelled`,
    });
    return Response.json({ url: session.url, id: session.id });
  } catch {
    // Stripe error details stay server-side; the caller only needs "retry".
    return Response.json({ error: "Could not start checkout." }, { status: 502 });
  }
}
