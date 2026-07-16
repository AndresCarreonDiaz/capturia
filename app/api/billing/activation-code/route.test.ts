// Route-level contract for the activation-code pickup endpoint
// (app/api/billing/activation-code/route.ts): every HTTP status the checkout
// success page keys its polling on, driven through the real entitlement
// helpers against the in-memory runner. The one hard security property here
// is the purchase-oracle guard: any state that admits a code ever existed
// (410) must require the session+nonce PAIR, so a caller holding only the
// session id (visible in a forwarded checkout URL) always reads a flat 404.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRedis } from "@/lib/hosted/memory-redis";
import { storeActivationBySession } from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";
import { GET } from "./route";

// The route resolves its store through this single factory; mocking it is
// the only seam needed to point the whole handler at the fake-clock store.
vi.mock("@/lib/hosted/backend", () => ({
  getHostedBackend: vi.fn(),
}));

const T0 = Date.UTC(2026, 6, 9, 12, 0, 0);
const SESSION = "cs_test_123";
const NONCE = "pickupnonce0123456789";
const WRONG_NONCE = "wrongnonce0123456789";
const CODE = "CAPTURIA-AAAA-BBBB-CCCC-DDDD";

// Same harness as lib/hosted/entitlements.test.ts: an injected clock drives
// the memory store's TTLs, so the grace window and the 30-day record expiry
// run against the exact production logic. The route's rate limiter reads
// Date.now() separately (real time), which stays consistent because the TTL
// tests only tick the injected clock and the rate-limit test issues its
// burst well inside one real minute.
function world() {
  let now = T0;
  const clock = { now: () => now, tick: (ms: number) => (now += ms) };
  const redis = createMemoryRedis(clock.now);
  vi.mocked(getHostedBackend).mockResolvedValue({ mode: "memory", run: redis.run });
  return { run: redis.run, clock };
}

function pickupRequest(query: Record<string, string>, ip?: string): Request {
  const qs = new URLSearchParams(query).toString();
  return new Request(`http://localhost/api/billing/activation-code${qs ? `?${qs}` : ""}`, {
    headers: ip ? { "x-forwarded-for": ip } : undefined,
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

beforeEach(() => {
  vi.mocked(getHostedBackend).mockReset();
});

describe("GET /api/billing/activation-code", () => {
  it("503s when the hosted backend is unconfigured", async () => {
    // getHostedBackend throws in production without Redis env (backend.ts
    // refuses the in-memory fallback there); the route must degrade to a
    // retryable 503, not a crash.
    vi.mocked(getHostedBackend).mockRejectedValue(new Error("refusing in-memory state"));
    const res = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }));
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toContain("not configured");
  });

  it("404s while the webhook has not filed anything for the pair yet", async () => {
    world();
    // Checkout redirected the buyer before Stripe delivered the webhook: the
    // success page must keep polling, so the answer is 404, not 410.
    const res = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toContain("yet");
  });

  it("200s with the code on first pickup for the correct session+nonce pair", async () => {
    const { run } = world();
    await storeActivationBySession(run, SESSION, NONCE, CODE);
    const res = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: CODE });
  });

  it("re-serves the same code within the grace window after a lost response", async () => {
    const { run, clock } = world();
    await storeActivationBySession(run, SESSION, NONCE, CODE);
    expect((await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }))).status).toBe(200);
    // The buyer's tab dropped the first response; a minute later the SAME
    // pair asks again and must get the SAME code instead of a dead 410.
    clock.tick(60 * 1000);
    const retry = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ code: CODE });
  });

  it("410s as already collected once the grace window lapses", async () => {
    const { run, clock } = world();
    await storeActivationBySession(run, SESSION, NONCE, CODE);
    expect((await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }))).status).toBe(200);
    clock.tick(6 * 60 * 1000); // past the 5-minute grace re-file
    // Polling is pointless now, and the page needs to say so: 410, not 404.
    const res = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }));
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toContain("already collected");
  });

  it("reads a flat 404 without the exact nonce, in every pickup state", async () => {
    const { run, clock } = world();
    await storeActivationBySession(run, SESSION, NONCE, CODE);
    // Every way to ask about this session WITHOUT holding the real nonce. A
    // 410 for any of these would confirm a purchase to a session-id holder.
    const probes: Record<string, string>[] = [
      { session_id: SESSION }, // no pickup param at all
      { session_id: SESSION, pickup: "short" }, // malformed: under 16 chars
      { session_id: SESSION, pickup: "bad!chars0123456789" }, // malformed: bad char
      { session_id: SESSION, pickup: WRONG_NONCE }, // well-formed, wrong nonce
    ];
    const expectFlat404 = async (state: string) => {
      for (const query of probes) {
        const res = await GET(pickupRequest(query));
        expect(res.status, `${state}: ${JSON.stringify(query)}`).toBe(404);
      }
    };
    // Before collection: 404, and the probes must not burn the record (a
    // wrong nonce is a plain key miss, never a destructive GETDEL).
    await expectFlat404("before collection");
    expect((await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }))).status).toBe(200);
    // After collection, inside the grace window: still 404, never 410.
    await expectFlat404("collected, in grace");
    clock.tick(6 * 60 * 1000);
    // Grace lapsed: the correct pair now reads 410, everyone else still 404.
    await expectFlat404("collected, grace lapsed");
    clock.tick(31 * 24 * 60 * 60 * 1000);
    // Even after the record itself expired, the markers stay pair-keyed.
    await expectFlat404("record expired");
  });

  it("410s as expired when the 30-day record TTL passes uncollected", async () => {
    const { run, clock } = world();
    await storeActivationBySession(run, SESSION, NONCE, CODE);
    // Never collected. The filed marker outlives the record precisely so the
    // endpoint can answer "expired, stop polling" instead of an eternal 404.
    clock.tick(31 * 24 * 60 * 60 * 1000);
    const res = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }));
    expect(res.status).toBe(410);
    expect(await errorOf(res)).toContain("expired");
  });

  it("429s the 31st request per IP inside a minute, before the pickup is attempted", async () => {
    const { run } = world();
    await storeActivationBySession(run, SESSION, NONCE, CODE);
    const IP = "203.0.113.9";
    // 30 nonce-less polls (a stuck success page's worst realistic burst) all
    // clear the limiter and read the flat 404.
    for (let i = 0; i < 30; i++) {
      const res = await GET(pickupRequest({ session_id: SESSION }, IP));
      expect(res.status, `poll ${i + 1} of 30`).toBe(404);
    }
    // The 31st is refused BEFORE the pickup runs, even with the correct
    // pair, and the retry-after hint says when a retry will actually work.
    const limited = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }, IP));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // The limit is keyed per IP and fired before the GETDEL, so the payer's
    // code survived the burst: a fresh IP with the right pair collects it.
    const fresh = await GET(pickupRequest({ session_id: SESSION, pickup: NONCE }, "198.51.100.7"));
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ code: CODE });
  });
});
