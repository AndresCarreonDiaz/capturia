// Stripe Billing Portal session (issues #10/#48): where a Pro customer
// updates their card, downloads invoices, or cancels; Stripe hosts all of
// it, so no account UI exists here. Authenticated exactly like the proxy
// (device JWT): the JWT's sub IS the Stripe customer id (the webhook keys
// every entitlement by it and activation carries it through), so there is
// no lookup table to fall out of sync. The response carries ONLY the portal
// URL, which the desktop opens externally under the same https-only rule
// as checkout.
//
// FREE-TIER DISCIPLINE: BYOK and the free demo never call this; without
// Stripe env or the JWT keys it answers 503 and nothing else cares.

import { stripeFromEnv, stripeRequest } from "@/lib/billing/stripe";
import { jwtPublicKeyFromEnv, verifyHostedJwt } from "@/lib/hosted/jwt";
import { hostedTokenFromRequest } from "@/lib/hosted/proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const stripe = stripeFromEnv(process.env);
  const publicKey = jwtPublicKeyFromEnv(process.env);
  if (!stripe || !publicKey) {
    return Response.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 }
    );
  }
  const verdict = verifyHostedJwt(hostedTokenFromRequest(request), publicKey);
  if (!verdict.ok) {
    return Response.json({ error: verdict.error }, { status: 401 });
  }

  // Same origin rule as checkout: desktop calls arrive at a loopback URL in
  // dev, so the deployed-origin override wins when present.
  const origin = process.env.CAPTURIA_CHECKOUT_ORIGIN || new URL(request.url).origin;
  try {
    const session = await stripeRequest(stripe, "POST", "/v1/billing_portal/sessions", {
      customer: verdict.claims.sub,
      return_url: `${origin}/`,
    });
    return Response.json({ url: session.url });
  } catch {
    // Stripe error details stay server-side; the caller only needs "retry".
    return Response.json({ error: "Could not open the subscription portal." }, { status: 502 });
  }
}
