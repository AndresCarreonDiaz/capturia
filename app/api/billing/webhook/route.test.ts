// Route-level contract for the Stripe webhook receiver
// (app/api/billing/webhook/route.ts): signature verification over the exact
// raw bytes, the non-2xx answers that make Stripe RETRY (a paid checkout
// must never be acked into a store that forgot it), and one genuine
// checkout.session.completed delivery driven through the real entitlement
// helpers: entitlement active plus the activation code filed under the
// session+nonce pickup pair.

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRedis } from "@/lib/hosted/memory-redis";
import { getHostedBackend } from "@/lib/hosted/backend";
import {
  ACTIVATION_CODE_RE,
  takeActivationCodeForSession,
  wasActivationFiled,
} from "@/lib/hosted/entitlements";
import { isEntitled, readEntitlement } from "@/lib/hosted/gate";
import { POST } from "./route";

// The route resolves its store through this single factory; mocking it is
// the only seam needed to point the whole handler at the in-memory store.
vi.mock("@/lib/hosted/backend", () => ({
  getHostedBackend: vi.fn(),
}));

const SECRET = "whsec_route_test";
const CUSTOMER = "cus_route_1";
const SESSION = "cs_test_route_1";
const NONCE = "pickupnonce0123456789";

function world() {
  const redis = createMemoryRedis();
  vi.mocked(getHostedBackend).mockResolvedValue({ mode: "memory", run: redis.run });
  return { run: redis.run };
}

// A real Stripe-Signature header over the exact body bytes, per the scheme
// verifyStripeSignature checks: "t=<unix>,v1=<hmac of '<t>.<body>'>".
function sign(body: string, secret = SECRET, atMs = Date.now()): string {
  const t = Math.floor(atMs / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

function webhookRequest(body: string, signature?: string): Request {
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    body,
    headers: signature ? { "stripe-signature": signature } : undefined,
  });
}

function stripeEvent(
  id: string,
  type: string,
  object: Record<string, unknown>,
  createdS = Math.floor(Date.now() / 1000)
): string {
  return JSON.stringify({ id, type, created: createdS, data: { object } });
}

// Built once per test (never inline in both the body and the sign call): the
// created stamp reads the clock, so two builds straddling a second boundary
// would sign a different body than the one delivered.
const checkoutCompleted = () =>
  stripeEvent("evt_route_1", "checkout.session.completed", {
    id: SESSION,
    customer: CUSTOMER,
    subscription: "sub_route_1",
    mode: "subscription",
    payment_status: "paid",
    metadata: { pickup: NONCE },
  });

beforeEach(() => {
  vi.mocked(getHostedBackend).mockReset();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/billing/webhook", () => {
  it("503s without the webhook secret configured", async () => {
    world();
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const body = checkoutCompleted();
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(503);
  });

  it("400s every bad signature and writes nothing to the store", async () => {
    const { run } = world();
    const body = checkoutCompleted();
    const probes: Array<[string, Request]> = [
      ["no header", webhookRequest(body)],
      ["wrong secret", webhookRequest(body, sign(body, "whsec_other"))],
      ["tampered body", webhookRequest(body.replace(CUSTOMER, "cus_evil"), sign(body))],
      // Past the 300s replay tolerance even with a correct HMAC.
      ["stale timestamp", webhookRequest(body, sign(body, SECRET, Date.now() - 10 * 60 * 1000))],
    ];
    for (const [state, req] of probes) {
      const res = await POST(req);
      expect(res.status, state).toBe(400);
    }
    expect(await readEntitlement(run, CUSTOMER)).toBeNull();
    expect(await wasActivationFiled(run, SESSION, NONCE)).toBe(false);
  });

  it("400s a correctly signed non-JSON payload", async () => {
    world();
    const body = "not json";
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(400);
  });

  it("503s (so Stripe retries) when the hosted backend is unconfigured", async () => {
    // 200-acking into a missing store would lose a PAID checkout; the non-2xx
    // makes Stripe redeliver until real Redis env exists.
    vi.mocked(getHostedBackend).mockRejectedValue(new Error("refusing in-memory state"));
    const body = checkoutCompleted();
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(503);
  });

  it("500s (so Stripe retries) on a store fault mid-apply", async () => {
    vi.mocked(getHostedBackend).mockResolvedValue({
      mode: "memory",
      run: () => Promise.reject(new Error("redis down")),
    });
    const body = checkoutCompleted();
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(500);
  });

  it("mints the entitlement and files the pickup code on a paid checkout", async () => {
    const { run } = world();
    const body = checkoutCompleted();
    const res = await POST(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    // The Redis cache the token endpoint and proxy consult is now on.
    const ent = await readEntitlement(run, CUSTOMER);
    expect(ent).toMatchObject({ status: "active", plan: "pro", subscription: "sub_route_1" });
    expect(isEntitled(ent)).toBe(true);
    // And the success page's session+nonce pair can collect a real code.
    expect(await wasActivationFiled(run, SESSION, NONCE)).toBe(true);
    const code = await takeActivationCodeForSession(run, SESSION, NONCE);
    expect(code).toMatch(ACTIVATION_CODE_RE);
  });

  it("revokes the entitlement on a later subscription.deleted", async () => {
    const { run } = world();
    const createdS = Math.floor(Date.now() / 1000);
    const body = checkoutCompleted();
    await POST(webhookRequest(body, sign(body)));
    const deleted = stripeEvent(
      "evt_route_2",
      "customer.subscription.deleted",
      { id: "sub_route_1", customer: CUSTOMER },
      createdS + 60
    );
    const res = await POST(webhookRequest(deleted, sign(deleted)));
    expect(res.status).toBe(200);
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
  });
});
