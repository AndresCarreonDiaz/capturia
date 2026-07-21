// Route-level contract for the checkout endpoint
// (app/api/billing/checkout/route.ts): the guard order the desktop Settings
// row and the landing depend on (503 without Stripe env, 503 without a state
// backend, per-IP rate brake BEFORE the outbound Stripe write, 502 on a
// Stripe failure), and the exact session shape. allow_promotion_codes must
// stay true: founder/friend coupons are minted in the Stripe dashboard, and
// Checkout's promo-code box is the only place they can be entered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRedis } from "@/lib/hosted/memory-redis";
import { getHostedBackend } from "@/lib/hosted/backend";
import { stripeRequest } from "@/lib/billing/stripe";
import { PICKUP_NONCE_RE } from "@/lib/hosted/entitlements";
import { POST } from "./route";

// Same seam as the activation-code route test: the route resolves its store
// through this single factory.
vi.mock("@/lib/hosted/backend", () => ({
  getHostedBackend: vi.fn(),
}));

// Keep stripeFromEnv (pure env parsing) real and stub only the outbound
// call, so the assertions see the exact params the route would send Stripe.
vi.mock("@/lib/billing/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe")>()),
  stripeRequest: vi.fn(),
}));

const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_route";

function world() {
  const redis = createMemoryRedis();
  vi.mocked(getHostedBackend).mockResolvedValue({ mode: "memory", run: redis.run });
  return { run: redis.run };
}

function checkoutRequest(ip?: string): Request {
  return new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: ip ? { "x-forwarded-for": ip } : undefined,
  });
}

function sessionParams(): Record<string, unknown> {
  return vi.mocked(stripeRequest).mock.calls[0][3] as Record<string, unknown>;
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

beforeEach(() => {
  vi.mocked(getHostedBackend).mockReset();
  vi.mocked(stripeRequest).mockReset();
  vi.mocked(stripeRequest).mockResolvedValue({ url: CHECKOUT_URL });
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route");
  vi.stubEnv("STRIPE_PRICE_ID", "price_route");
  // The deployed-origin override must not leak in from the ambient env.
  vi.stubEnv("CAPTURIA_CHECKOUT_ORIGIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/billing/checkout", () => {
  it("503s without Stripe env and never touches Stripe (free-tier discipline)", async () => {
    world();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const res = await POST(checkoutRequest());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toContain("not configured");
    // A secret key with no pinned price is equally unconfigured.
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route");
    vi.stubEnv("STRIPE_PRICE_ID", "");
    expect((await POST(checkoutRequest())).status).toBe(503);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("503s when the hosted backend is unconfigured", async () => {
    // getHostedBackend throws in production without Redis env; the route
    // must degrade to a retryable 503, not a crash.
    vi.mocked(getHostedBackend).mockRejectedValue(new Error("refusing in-memory state"));
    const res = await POST(checkoutRequest());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toContain("not configured");
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("creates the session with the promo-code box on and answers only the URL", async () => {
    world();
    const res = await POST(checkoutRequest());
    expect(res.status).toBe(200);
    // ONLY the URL: session internals (metadata nonce included) stay server-side.
    expect(await res.json()).toEqual({ url: CHECKOUT_URL });
    expect(stripeRequest).toHaveBeenCalledTimes(1);
    const [cfg, method, path] = vi.mocked(stripeRequest).mock.calls[0];
    expect(cfg).toMatchObject({ secretKey: "sk_test_route" });
    expect(method).toBe("POST");
    expect(path).toBe("/v1/checkout/sessions");
    expect(sessionParams()).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_route", quantity: 1 }],
      allow_promotion_codes: true,
    });
  });

  it("binds the pickup nonce into both the metadata and the success URL", async () => {
    world();
    await POST(checkoutRequest());
    const params = sessionParams();
    const pickup = (params.metadata as { pickup: string }).pickup;
    // The nonce the webhook files the code under must be the one the success
    // page will present, and must satisfy the pickup validator, or the payer
    // polls a code that can never be released.
    expect(pickup).toMatch(PICKUP_NONCE_RE);
    expect(params.success_url).toBe(
      `http://localhost/?checkout=success&session_id={CHECKOUT_SESSION_ID}&pickup=${pickup}`
    );
    expect(params.cancel_url).toBe("http://localhost/?checkout=cancelled");
  });

  it("prefers CAPTURIA_CHECKOUT_ORIGIN over the request origin for redirects", async () => {
    // Desktop checkouts POST to a loopback URL; without the override Stripe
    // would bounce the buyer back to localhost instead of the landing.
    world();
    vi.stubEnv("CAPTURIA_CHECKOUT_ORIGIN", "https://www.capturia.dev");
    await POST(checkoutRequest());
    const params = sessionParams();
    expect(String(params.success_url)).toContain("https://www.capturia.dev/?checkout=success");
    expect(params.cancel_url).toBe("https://www.capturia.dev/?checkout=cancelled");
  });

  it("429s the 6th checkout per IP inside a minute, before Stripe is touched", async () => {
    world();
    const IP = "203.0.113.7";
    for (let i = 0; i < 5; i++) {
      const res = await POST(checkoutRequest(IP));
      expect(res.status, `checkout ${i + 1} of 5`).toBe(200);
    }
    const limited = await POST(checkoutRequest(IP));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Refused BEFORE the outbound write: Stripe saw exactly the 5 allowed,
    // so the endpoint cannot be used to hammer Stripe on our key.
    expect(stripeRequest).toHaveBeenCalledTimes(5);
    // Keyed per IP: another buyer is unaffected.
    expect((await POST(checkoutRequest("198.51.100.3"))).status).toBe(200);
  });

  it("502s when Stripe refuses, without echoing the Stripe error", async () => {
    world();
    vi.mocked(stripeRequest).mockRejectedValue(new Error("stripe: HTTP 400 (No such price)"));
    const res = await POST(checkoutRequest());
    expect(res.status).toBe(502);
    // Stripe details stay server-side; the caller only needs "retry".
    expect(await errorOf(res)).toBe("Could not start checkout.");
  });
});
