// Exercises the hosted-tier spend brakes (lib/hosted/gate.ts) against the
// in-memory runner with a controlled clock: rate-limit window math, budget
// accounting, lease exclusivity, kill switch, and the full gate ordering.

import { describe, expect, it } from "vitest";
import { createMemoryRedis } from "./memory-redis";
import { writeEntitlement } from "./entitlements";
import {
  acquireLease,
  checkRateLimit,
  countsAgainstFlashBudget,
  gateConfigFromEnv,
  gateFlashBudget,
  gateHostedCall,
  isEntitled,
  isKillSwitchOn,
  monthEndMs,
  monthKey,
  readEntitlement,
  readFlashMonthlyUsage,
  readMonthlyUsage,
  recordUsage,
} from "./gate";

const CUSTOMER = "cus_test";
// Mid-minute start so window weighting math is non-trivial from tick one.
const T0 = Date.UTC(2026, 6, 9, 10, 0, 30);

function world() {
  let now = T0;
  const clock = { now: () => now, tick: (ms: number) => (now += ms) };
  const redis = createMemoryRedis(clock.now);
  return { run: redis.run, clock };
}

async function entitle(run: ReturnType<typeof world>["run"], status = "active" as const) {
  await writeEntitlement(run, CUSTOMER, status, "sub_1", T0);
}

describe("gateConfigFromEnv", () => {
  it("uses the issue #49 defaults and accepts overrides", () => {
    // 5.5M/month = 20 presentation hours at 275k tokens/hour, with the 500k
    // flash sub-budget carved out for deck codegen.
    expect(gateConfigFromEnv({})).toEqual({
      ratePerMinute: 10,
      monthlyTokenBudget: 5_500_000,
      flashMonthlyTokenBudget: 500_000,
      leaseTtlMs: 120_000,
    });
    expect(
      gateConfigFromEnv({
        CAPTURIA_HOSTED_RATE_LIMIT: "3",
        CAPTURIA_HOSTED_MONTHLY_TOKENS: "1000",
        CAPTURIA_HOSTED_FLASH_MONTHLY_TOKENS: "200",
        CAPTURIA_HOSTED_LEASE_TTL_MS: "5000",
      })
    ).toEqual({
      ratePerMinute: 3,
      monthlyTokenBudget: 1000,
      flashMonthlyTokenBudget: 200,
      leaseTtlMs: 5000,
    });
  });

  it("ignores garbage overrides", () => {
    expect(gateConfigFromEnv({ CAPTURIA_HOSTED_RATE_LIMIT: "-2" }).ratePerMinute).toBe(10);
    expect(gateConfigFromEnv({ CAPTURIA_HOSTED_RATE_LIMIT: "lots" }).ratePerMinute).toBe(10);
    // Fractions below 1 must fall back, not floor to a zero limit.
    expect(gateConfigFromEnv({ CAPTURIA_HOSTED_RATE_LIMIT: "0.5" }).ratePerMinute).toBe(10);
    expect(gateConfigFromEnv({ CAPTURIA_HOSTED_LEASE_TTL_MS: "0.9" }).leaseTtlMs).toBe(120_000);
  });
});

describe("entitlement cache", () => {
  it("reads back what the webhook writes and maps status to entitled", async () => {
    const { run } = world();
    expect(await readEntitlement(run, CUSTOMER)).toBeNull();
    await entitle(run);
    const ent = await readEntitlement(run, CUSTOMER);
    expect(ent?.status).toBe("active");
    expect(isEntitled(ent)).toBe(true);
  });

  it("keeps past_due entitled but not canceled", async () => {
    const { run } = world();
    await writeEntitlement(run, CUSTOMER, "past_due", "sub_1", T0);
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(true);
    await writeEntitlement(run, CUSTOMER, "canceled", "sub_1", T0);
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
  });
});

describe("sliding-window rate limit", () => {
  it("allows the configured burst and refuses the next request", async () => {
    const { run, clock } = world();
    for (let i = 0; i < 10; i++) {
      const res = await checkRateLimit(run, CUSTOMER, 10, clock.now());
      expect(res.allowed).toBe(true);
      clock.tick(100);
    }
    const eleventh = await checkRateLimit(run, CUSTOMER, 10, clock.now());
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.retryAfterSec).toBeGreaterThan(0);
  });

  it("weights the previous window instead of resetting at the boundary", async () => {
    const { run, clock } = world();
    for (let i = 0; i < 10; i++) await checkRateLimit(run, CUSTOMER, 10, clock.now());
    // Step just past the minute boundary: ~all of the previous window still
    // overlaps the trailing 60s, so the very next request must be refused.
    clock.tick(60_000 - (clock.now() % 60_000) + 1_000);
    const res = await checkRateLimit(run, CUSTOMER, 10, clock.now());
    expect(res.allowed).toBe(false);
  });

  it("recovers once the previous window has aged out", async () => {
    const { run, clock } = world();
    for (let i = 0; i < 10; i++) await checkRateLimit(run, CUSTOMER, 10, clock.now());
    clock.tick(2 * 60_000 + 1_000);
    const res = await checkRateLimit(run, CUSTOMER, 10, clock.now());
    expect(res.allowed).toBe(true);
  });

  it("isolates users from each other", async () => {
    const { run, clock } = world();
    for (let i = 0; i < 10; i++) await checkRateLimit(run, CUSTOMER, 10, clock.now());
    expect((await checkRateLimit(run, "cus_other", 10, clock.now())).allowed).toBe(true);
  });

  it("gives a retry-after that actually clears after an over-limit burst", async () => {
    const { run, clock } = world();
    // 11 attempts back to back: the 11th is refused with current=11 > limit,
    // so no instant inside this window can admit a request and the hint must
    // reach into the next window plus the decay time of today's bucket.
    let refused = { allowed: true, retryAfterSec: 0 };
    for (let i = 0; i < 11; i++) refused = await checkRateLimit(run, CUSTOMER, 10, clock.now());
    expect(refused.allowed).toBe(false);
    // The naive to-window-boundary hint (30s from the mid-minute T0) is a
    // guaranteed second refusal; the honest hint is longer.
    expect(refused.retryAfterSec).toBeGreaterThan(30);
    clock.tick(refused.retryAfterSec * 1000);
    expect((await checkRateLimit(run, CUSTOMER, 10, clock.now())).allowed).toBe(true);
  });

  it("gives an in-window retry-after when the previous bucket drives the refusal", async () => {
    const { run, clock } = world();
    for (let i = 0; i < 11; i++) await checkRateLimit(run, CUSTOMER, 10, clock.now());
    // Early in the next window the previous bucket still weighs ~11.
    clock.tick(60_000 - (clock.now() % 60_000) + 5_000);
    const refused = await checkRateLimit(run, CUSTOMER, 10, clock.now());
    expect(refused.allowed).toBe(false);
    clock.tick(refused.retryAfterSec * 1000);
    expect((await checkRateLimit(run, CUSTOMER, 10, clock.now())).allowed).toBe(true);
  });
});

describe("monthly budget", () => {
  it("accumulates recorded usage under a month key", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 1200, clock.now());
    await recordUsage(run, CUSTOMER, 800, clock.now());
    expect(await readMonthlyUsage(run, CUSTOMER, clock.now())).toBe(2000);
    expect(monthKey(clock.now())).toBe("2026-07");
  });

  it("floors token counts at 1 so missing usage metadata still costs", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 0, clock.now());
    expect(await readMonthlyUsage(run, CUSTOMER, clock.now())).toBe(1);
  });

  it("rolls over to a fresh counter next month", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 999, clock.now());
    clock.tick(31 * 24 * 60 * 60 * 1000);
    expect(await readMonthlyUsage(run, CUSTOMER, clock.now())).toBe(0);
  });

  it("reports the period end as the first instant of next month (UTC)", () => {
    expect(monthEndMs(T0)).toBe(Date.UTC(2026, 7, 1));
  });
});

describe("flash sub-budget accounting", () => {
  it("meters exactly the flash model id", () => {
    expect(countsAgainstFlashBudget("gemini-2.5-flash")).toBe(true);
    expect(countsAgainstFlashBudget("gemini-2.5-flash-lite")).toBe(false);
  });

  it("charges a flash call to BOTH counters (the sub-budget is a carve-out)", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 300, clock.now(), "gemini-2.5-flash");
    expect(await readMonthlyUsage(run, CUSTOMER, clock.now())).toBe(300);
    expect(await readFlashMonthlyUsage(run, CUSTOMER, clock.now())).toBe(300);
  });

  it("charges a lite call to the monthly counter only", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 300, clock.now(), "gemini-2.5-flash-lite");
    expect(await readMonthlyUsage(run, CUSTOMER, clock.now())).toBe(300);
    expect(await readFlashMonthlyUsage(run, CUSTOMER, clock.now())).toBe(0);
  });

  it("rolls the flash counter over with the month", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 999, clock.now(), "gemini-2.5-flash");
    clock.tick(31 * 24 * 60 * 60 * 1000);
    expect(await readFlashMonthlyUsage(run, CUSTOMER, clock.now())).toBe(0);
  });
});

describe("concurrent-stream lease", () => {
  it("grants one lease at a time and releases cleanly", async () => {
    const { run, clock } = world();
    const first = await acquireLease(run, CUSTOMER, 120_000, "req-1");
    expect(first).not.toBeNull();
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-2")).toBeNull();
    await first!.release();
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-3")).not.toBeNull();
    void clock;
  });

  it("keeps the stream and batch lanes independent (live overlay + deck codegen)", async () => {
    const { run } = world();
    const stream = await acquireLease(run, CUSTOMER, 120_000, "req-live", "stream");
    expect(stream).not.toBeNull();
    // Deck codegen's non-streaming call must not 409 against the live stream.
    const batch = await acquireLease(run, CUSTOMER, 120_000, "req-deck", "batch");
    expect(batch).not.toBeNull();
    // But a second call in the SAME lane still conflicts.
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-live-2", "stream")).toBeNull();
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-deck-2", "batch")).toBeNull();
    // Releasing one lane never frees the other.
    await batch!.release();
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-live-3", "stream")).toBeNull();
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-deck-3", "batch")).not.toBeNull();
  });

  it("expires by TTL if never released (crashed function backstop)", async () => {
    const { run, clock } = world();
    await acquireLease(run, CUSTOMER, 120_000, "req-1");
    clock.tick(121_000);
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-2")).not.toBeNull();
  });

  it("release is ownership-checked: a stale holder cannot free a newer lease", async () => {
    const { run, clock } = world();
    const stale = await acquireLease(run, CUSTOMER, 1_000, "req-old");
    clock.tick(2_000); // stale lease expired
    const fresh = await acquireLease(run, CUSTOMER, 120_000, "req-new");
    expect(fresh).not.toBeNull();
    await stale!.release(); // must NOT delete req-new's lease
    expect(await acquireLease(run, CUSTOMER, 120_000, "req-third")).toBeNull();
  });
});

describe("gateHostedCall (the brake stack, in order)", () => {
  const cfg = {
    ratePerMinute: 2,
    monthlyTokenBudget: 100,
    flashMonthlyTokenBudget: 40,
    leaseTtlMs: 120_000,
  };

  it("passes an entitled, unthrottled call without touching any lease", async () => {
    const { run, clock } = world();
    await entitle(run);
    const decision = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(decision).toEqual({ ok: true });
    // The gate never acquires leases (the route does, per lane, after
    // planning), so both lanes remain free.
    expect(await acquireLease(run, CUSTOMER, 120_000, "r1", "stream")).not.toBeNull();
    expect(await acquireLease(run, CUSTOMER, 120_000, "r2", "batch")).not.toBeNull();
  });

  it("503s everything when the kill switch is set", async () => {
    const { run, clock } = world();
    await entitle(run);
    await run(["SET", "hosted:kill", "1"]);
    expect(await isKillSwitchOn(run)).toBe(true);
    const decision = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(decision).toMatchObject({ ok: false, status: 503 });
  });

  it("402s a customer without an entitlement record", async () => {
    const { run, clock } = world();
    const decision = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(decision).toMatchObject({ ok: false, status: 402 });
  });

  it("402s a canceled subscription (webhook revocation reaches the proxy)", async () => {
    const { run, clock } = world();
    await writeEntitlement(run, CUSTOMER, "canceled", "sub_1", T0);
    const decision = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(decision).toMatchObject({ ok: false, status: 402 });
  });

  it("429s past the rate limit with a retry-after hint", async () => {
    const { run, clock } = world();
    await entitle(run);
    for (let i = 0; i < 2; i++) {
      expect((await gateHostedCall(run, CUSTOMER, cfg, clock.now())).ok).toBe(true);
    }
    const throttled = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(throttled).toMatchObject({ ok: false, status: 429 });
    if (!throttled.ok) expect(throttled.retryAfterSec).toBeGreaterThan(0);
  });

  it("429s once the monthly budget is exhausted, with the distinct code + marker", async () => {
    const { run, clock } = world();
    await entitle(run);
    await recordUsage(run, CUSTOMER, 100, clock.now());
    const decision = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(decision).toMatchObject({ ok: false, status: 429, code: "budget_exhausted" });
    if (!decision.ok) expect(decision.error).toContain("capturia:hosted-budget-exhausted");
  });
});

describe("gateFlashBudget (the model-scoped sub-budget)", () => {
  const cfg = {
    ratePerMinute: 10,
    monthlyTokenBudget: 100,
    flashMonthlyTokenBudget: 40,
    leaseTtlMs: 120_000,
  };

  it("passes flash calls while the sub-budget has headroom", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 39, clock.now(), "gemini-2.5-flash");
    const decision = await gateFlashBudget(run, CUSTOMER, "gemini-2.5-flash", cfg, clock.now());
    expect(decision).toEqual({ ok: true });
  });

  it("429s flash once the sub-budget is exhausted, with the distinct code + marker", async () => {
    const { run, clock } = world();
    await recordUsage(run, CUSTOMER, 40, clock.now(), "gemini-2.5-flash");
    const decision = await gateFlashBudget(run, CUSTOMER, "gemini-2.5-flash", cfg, clock.now());
    expect(decision).toMatchObject({ ok: false, status: 429, code: "flash_budget_exhausted" });
    if (!decision.ok) {
      expect(decision.error).toContain("capturia:hosted-flash-budget-exhausted");
    }
  });

  it("keeps lite-tier traffic flowing after the flash sub-budget is spent", async () => {
    const { run, clock } = world();
    await entitle(run);
    await recordUsage(run, CUSTOMER, 40, clock.now(), "gemini-2.5-flash");
    // The launch shape from issue #49: deck codegen (flash) stops, the live
    // overlay stream (lite) keeps running on the remaining monthly budget.
    expect(await gateFlashBudget(run, CUSTOMER, "gemini-2.5-flash-lite", cfg, clock.now())).toEqual(
      { ok: true }
    );
    expect(await gateHostedCall(run, CUSTOMER, cfg, clock.now())).toEqual({ ok: true });
  });

  it("still stops flash through the OVERALL budget even with sub-budget headroom", async () => {
    const { run, clock } = world();
    await entitle(run);
    // Lite traffic alone can exhaust the month; flash has spent nothing, but
    // the monthly gate (which runs first in the route) refuses everything.
    await recordUsage(run, CUSTOMER, 100, clock.now(), "gemini-2.5-flash-lite");
    expect(await gateFlashBudget(run, CUSTOMER, "gemini-2.5-flash", cfg, clock.now())).toEqual({
      ok: true,
    });
    const monthly = await gateHostedCall(run, CUSTOMER, cfg, clock.now());
    expect(monthly).toMatchObject({ ok: false, status: 429, code: "budget_exhausted" });
  });
});
