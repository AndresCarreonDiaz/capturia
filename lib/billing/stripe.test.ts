// Pins the minimal Stripe client (lib/billing/stripe.ts): bracket-notation
// form encoding, webhook signature verification against a self-computed
// HMAC (the same scheme stripe-mock and real Stripe use), and the meter
// event payload shape. Network calls run against an injected fetch fake;
// the live sk_test pass is in docs/hosted-tier.md's verification runbook.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  formEncode,
  METER_EVENT_NAME,
  recordMeterEvent,
  stripeFromEnv,
  stripeRequest,
  verifyStripeSignature,
} from "./stripe";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

describe("stripeFromEnv", () => {
  it("is null without a secret key (billing endpoints 503)", () => {
    expect(stripeFromEnv({})).toBeNull();
  });

  it("defaults to api.stripe.com and honors STRIPE_API_BASE for stripe-mock", () => {
    expect(stripeFromEnv({ STRIPE_SECRET_KEY: "sk_test_x" })).toEqual({
      secretKey: "sk_test_x",
      baseUrl: "https://api.stripe.com",
    });
    expect(
      stripeFromEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_API_BASE: "http://localhost:12111/" })
        ?.baseUrl
    ).toBe("http://localhost:12111");
  });
});

describe("formEncode", () => {
  it("encodes nested objects and arrays in bracket notation", () => {
    expect(
      formEncode({
        mode: "subscription",
        line_items: [{ price: "price_1", quantity: 1 }],
        payload: { stripe_customer_id: "cus_1", value: "42" },
      })
    ).toBe(
      "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1" +
        "&payload%5Bstripe_customer_id%5D=cus_1&payload%5Bvalue%5D=42"
    );
  });

  it("skips null/undefined and escapes reserved characters", () => {
    expect(formEncode({ a: undefined, b: null, c: "x&y=z" })).toBe("c=x%26y%3Dz");
  });
});

describe("stripeRequest", () => {
  const cfg = { secretKey: "sk_test_secret", baseUrl: "https://stripe.example" };

  it("POSTs form-encoded with the bearer key and parses the JSON reply", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: "cs_1" }), { status: 200 });
    }) as typeof fetch;
    const body = await stripeRequest(cfg, "POST", "/v1/checkout/sessions", { mode: "subscription" }, fetchFake);
    expect(body.id).toBe("cs_1");
    expect(seen!.url).toBe("https://stripe.example/v1/checkout/sessions");
    expect(seen!.init.body).toBe("mode=subscription");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_secret");
    expect((seen!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );
  });

  it("GET sends params as the query string", async () => {
    let seenUrl = "";
    const fetchFake = (async (url: RequestInfo | URL) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    await stripeRequest(cfg, "GET", "/v1/prices", { lookup_keys: ["k1"], limit: 1 }, fetchFake);
    expect(seenUrl).toBe("https://stripe.example/v1/prices?lookup_keys%5B0%5D=k1&limit=1");
  });

  it("throws with Stripe's message and status on error replies", async () => {
    const fetchFake = (async () =>
      new Response(JSON.stringify({ error: { message: "No such price" } }), {
        status: 404,
      })) as typeof fetch;
    await expect(stripeRequest(cfg, "POST", "/v1/checkout/sessions", {}, fetchFake)).rejects.toThrow(
      /HTTP 404.*No such price/
    );
  });
});

describe("verifyStripeSignature", () => {
  const SECRET = "whsec_test_secret";
  const PAYLOAD = JSON.stringify({ type: "checkout.session.completed" });

  function signedHeader(atMs: number, payload = PAYLOAD, secret = SECRET) {
    const t = Math.floor(atMs / 1000);
    const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }

  it("accepts a valid signature inside the tolerance window", () => {
    expect(verifyStripeSignature(PAYLOAD, signedHeader(NOW), SECRET, NOW)).toBe(true);
    expect(verifyStripeSignature(PAYLOAD, signedHeader(NOW - 200_000), SECRET, NOW)).toBe(true);
  });

  it("rejects a stale timestamp (replay brake)", () => {
    expect(verifyStripeSignature(PAYLOAD, signedHeader(NOW - 400_000), SECRET, NOW)).toBe(false);
  });

  it("rejects a tampered payload and a wrong secret", () => {
    expect(verifyStripeSignature(PAYLOAD + "x", signedHeader(NOW), SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(PAYLOAD, signedHeader(NOW, PAYLOAD, "whsec_other"), SECRET, NOW)).toBe(false);
  });

  it("rejects missing/malformed headers", () => {
    expect(verifyStripeSignature(PAYLOAD, null, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(PAYLOAD, "", SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(PAYLOAD, "t=abc,v1=zzz", SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(PAYLOAD, `t=${Math.floor(NOW / 1000)}`, SECRET, NOW)).toBe(false);
  });

  it("accepts when any v1 entry matches (secret rotation sends several)", () => {
    const t = Math.floor(NOW / 1000);
    const good = createHmac("sha256", SECRET).update(`${t}.${PAYLOAD}`).digest("hex");
    const header = `t=${t},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifyStripeSignature(PAYLOAD, header, SECRET, NOW)).toBe(true);
  });
});

describe("recordMeterEvent", () => {
  it("emits one identifier-deduplicated meter event with integer value", async () => {
    let seenBody = "";
    const fetchFake = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return new Response(JSON.stringify({ identifier: "req-1" }), { status: 200 });
    }) as typeof fetch;
    await recordMeterEvent(
      { secretKey: "sk_test", baseUrl: "https://stripe.example" },
      { customer: "cus_1", value: 1234.9, identifier: "req-1" },
      fetchFake
    );
    const params = new URLSearchParams(seenBody);
    expect(params.get("event_name")).toBe(METER_EVENT_NAME);
    expect(params.get("identifier")).toBe("req-1");
    expect(params.get("payload[stripe_customer_id]")).toBe("cus_1");
    expect(params.get("payload[value]")).toBe("1234");
  });
});
