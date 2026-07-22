// Route-level contract for the customer portal endpoint
// (app/api/billing/portal/route.ts): device-JWT auth with the proxy's own
// 401/503 shapes, the per-customer rate brake BEFORE the outbound Stripe
// write, the portal session is created for exactly the JWT's customer
// (never a caller-supplied id), the response carries only the URL, and
// Stripe failures degrade to a detail-free 502.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRedis } from "@/lib/hosted/memory-redis";
import { getHostedBackend } from "@/lib/hosted/backend";
import { stripeRequest } from "@/lib/billing/stripe";
import { generateJwtKeyPair, jwtPrivateKeyFromEnv, signHostedJwt } from "@/lib/hosted/jwt";
import { POST } from "./route";

// Same seam as the checkout route test: the route resolves its store through
// this single factory.
vi.mock("@/lib/hosted/backend", () => ({
  getHostedBackend: vi.fn(),
}));

// Keep stripeFromEnv (pure env parsing) real and stub only the outbound
// call, so the assertions see the exact params the route would send Stripe.
vi.mock("@/lib/billing/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/stripe")>()),
  stripeRequest: vi.fn(),
}));

const CUSTOMER = "cus_portal_test";
const KEYS = generateJwtKeyPair();
const PORTAL_URL = "https://billing.stripe.com/p/session/test_route";

function mintToken(customer = CUSTOMER, nowMs = Date.now()): string {
  const privateKey = jwtPrivateKeyFromEnv({ CAPTURIA_JWT_PRIVATE_KEY: KEYS.privateKey })!;
  return signHostedJwt({ customer, device: "mac-test", plan: "pro", privateKey, nowMs }).token;
}

function world() {
  const redis = createMemoryRedis();
  vi.mocked(getHostedBackend).mockResolvedValue({ mode: "memory", run: redis.run });
  return { run: redis.run };
}

function portalRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/billing/portal", { method: "POST", headers });
}

function sessionParams(): Record<string, unknown> {
  return vi.mocked(stripeRequest).mock.calls[0][3] as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(getHostedBackend).mockReset();
  vi.mocked(stripeRequest).mockReset();
  vi.mocked(stripeRequest).mockResolvedValue({ url: PORTAL_URL });
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route");
  vi.stubEnv("CAPTURIA_JWT_PUBLIC_KEY", KEYS.publicKey);
  // The deployed-origin override must not leak in from the ambient env.
  vi.stubEnv("CAPTURIA_CHECKOUT_ORIGIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/billing/portal", () => {
  it("503s without Stripe env and never touches Stripe (free-tier discipline)", async () => {
    world();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const res = await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(503);
    // No JWT verify key is equally unconfigured: without it nobody can be
    // authenticated, so nothing may reach Stripe either.
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route");
    vi.stubEnv("CAPTURIA_JWT_PUBLIC_KEY", "");
    expect((await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }))).status).toBe(503);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("401s without a token, with a garbage token, and with an expired token", async () => {
    world();
    expect((await POST(portalRequest())).status).toBe(401);
    expect((await POST(portalRequest({ authorization: "Bearer not.a.jwt" }))).status).toBe(401);
    const stale = mintToken(CUSTOMER, Date.now() - 2 * 60 * 60 * 1000); // past the 1h TTL
    expect((await POST(portalRequest({ authorization: `Bearer ${stale}` }))).status).toBe(401);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("503s when the state backend is unconfigured, before Stripe is touched", async () => {
    // getHostedBackend throws in production without Redis env; the route
    // must degrade to a retryable 503, not a crash.
    vi.mocked(getHostedBackend).mockRejectedValue(new Error("refusing in-memory state"));
    const res = await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(503);
    expect(stripeRequest).not.toHaveBeenCalled();
  });

  it("creates the session for exactly the JWT's customer and answers only the URL", async () => {
    world();
    const res = await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: PORTAL_URL });
    expect(stripeRequest).toHaveBeenCalledTimes(1);
    const [cfg, method, path] = vi.mocked(stripeRequest).mock.calls[0];
    expect(cfg).toMatchObject({ secretKey: "sk_test_route" });
    expect(method).toBe("POST");
    expect(path).toBe("/v1/billing_portal/sessions");
    // The customer comes from verified claims, never from the request body.
    expect(sessionParams()).toEqual({
      customer: CUSTOMER,
      return_url: "http://localhost/",
    });
  });

  it("prefers CAPTURIA_CHECKOUT_ORIGIN over the request origin for the return URL", async () => {
    // Desktop calls POST a loopback URL; without the override Stripe would
    // bounce the customer back to localhost instead of the landing.
    world();
    vi.stubEnv("CAPTURIA_CHECKOUT_ORIGIN", "https://www.capturia.dev");
    await POST(portalRequest({ "x-goog-api-key": mintToken() }));
    expect(sessionParams().return_url).toBe("https://www.capturia.dev/");
  });

  it("429s the 6th portal session per customer inside a minute, before Stripe is touched", async () => {
    world();
    for (let i = 0; i < 5; i++) {
      const res = await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }));
      expect(res.status, `portal session ${i + 1} of 5`).toBe(200);
    }
    const limited = await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Refused BEFORE the outbound write: Stripe saw exactly the 5 allowed,
    // so a looping JWT holder cannot hammer Stripe on our key.
    expect(stripeRequest).toHaveBeenCalledTimes(5);
    // Keyed per customer: another subscriber is unaffected.
    const other = await POST(portalRequest({ authorization: `Bearer ${mintToken("cus_other")}` }));
    expect(other.status).toBe(200);
  });

  it("502s when Stripe refuses, without echoing the Stripe error", async () => {
    world();
    vi.mocked(stripeRequest).mockRejectedValue(new Error("stripe: HTTP 400 (No such customer)"));
    const res = await POST(portalRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Could not open the subscription portal." });
  });
});
