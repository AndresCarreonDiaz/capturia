// Exercises the hosted-tier spend brakes (lib/hosted/gate.ts) against the
// in-memory runner with a controlled clock: rate-limit window math, budget
// accounting, lease exclusivity, kill switch, and the full gate ordering.

import { describe, expect, it } from "vitest";
import { createMemoryRedis } from "./memory-redis";
import { writeEntitlement } from "./entitlements";
import {
  acquireLease,
  checkRateLimit,
  gateConfigFromEnv,
  gateHostedCall,
  isEntitled,
  isKillSwitchOn,
  monthKey,
  readEntitlement,
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
  it("uses the issue #10 defaults and accepts overrides", () => {
    expect(gateConfigFromEnv({})).toEqual({
      ratePerMinute: 10,
      monthlyTokenBudget: 5_000_000,
      leaseTtlMs: 120_000,
    });
    expect(
      gateConfigFromEnv({
        CAPTURIA_HOSTED_RATE_LIMIT: "3",
        CAPTURIA_HOSTED_MONTHLY_TOKENS: "1000",
        CAPTURIA_HOSTED_LEASE_TTL_MS: "5000",
      })
    ).toEqual({ ratePerMinute: 3, monthlyTokenBudget: 1000, leaseTtlMs: 5000 });
  });

  it("ignores garbage overrides", () => {
    expect(gateConfigFromEnv({ CAPTURIA_HOSTED_RATE_LIMIT: "-2" }).ratePerMinute).toBe(10);
    expect(gateConfigFromEnv({ CAPTURIA_HOSTED_RATE_LIMIT: "lots" }).ratePerMinute).toBe(10);
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

describe("gateHostedCall (the full stack, in order)", () => {
  const cfg = { ratePerMinute: 2, monthlyTokenBudget: 100, leaseTtlMs: 120_000 };

  it("passes an entitled, unthrottled call and hands back a working lease", async () => {
    const { run, clock } = world();
    await entitle(run);
    const decision = await gateHostedCall(run, CUSTOMER, cfg, "req-1", clock.now());
    expect(decision.ok).toBe(true);
    if (decision.ok) await decision.lease.release();
  });

  it("503s everything when the kill switch is set", async () => {
    const { run, clock } = world();
    await entitle(run);
    await run(["SET", "hosted:kill", "1"]);
    expect(await isKillSwitchOn(run)).toBe(true);
    const decision = await gateHostedCall(run, CUSTOMER, cfg, "req-1", clock.now());
    expect(decision).toMatchObject({ ok: false, status: 503 });
  });

  it("402s a customer without an entitlement record", async () => {
    const { run, clock } = world();
    const decision = await gateHostedCall(run, CUSTOMER, cfg, "req-1", clock.now());
    expect(decision).toMatchObject({ ok: false, status: 402 });
  });

  it("402s a canceled subscription (webhook revocation reaches the proxy)", async () => {
    const { run, clock } = world();
    await writeEntitlement(run, CUSTOMER, "canceled", "sub_1", T0);
    const decision = await gateHostedCall(run, CUSTOMER, cfg, "req-1", clock.now());
    expect(decision).toMatchObject({ ok: false, status: 402 });
  });

  it("429s past the rate limit with a retry-after hint", async () => {
    const { run, clock } = world();
    await entitle(run);
    for (let i = 0; i < 2; i++) {
      const d = await gateHostedCall(run, CUSTOMER, cfg, `req-${i}`, clock.now());
      expect(d.ok).toBe(true);
      if (d.ok) await d.lease.release();
    }
    const throttled = await gateHostedCall(run, CUSTOMER, cfg, "req-3", clock.now());
    expect(throttled).toMatchObject({ ok: false, status: 429 });
    if (!throttled.ok) expect(throttled.retryAfterSec).toBeGreaterThan(0);
  });

  it("429s once the monthly budget is exhausted", async () => {
    const { run, clock } = world();
    await entitle(run);
    await recordUsage(run, CUSTOMER, 100, clock.now());
    const decision = await gateHostedCall(run, CUSTOMER, cfg, "req-1", clock.now());
    expect(decision).toMatchObject({ ok: false, status: 429 });
    if (!decision.ok) expect(decision.error).toMatch(/usage exhausted/i);
  });

  it("409s a second concurrent stream and never leaks a lease on refusal", async () => {
    const { run, clock } = world();
    await entitle(run);
    const first = await gateHostedCall(run, CUSTOMER, cfg, "req-1", clock.now());
    expect(first.ok).toBe(true);
    const second = await gateHostedCall(run, CUSTOMER, cfg, "req-2", clock.now());
    expect(second).toMatchObject({ ok: false, status: 409 });
    if (first.ok) await first.lease.release();
    // The refused request must not have consumed or corrupted the lease.
    const third = await gateHostedCall(run, "cus_other", cfg, "req-3", clock.now());
    expect(third).toMatchObject({ ok: false, status: 402 }); // other user, no ent
    // Two full windows later the trailing-60s weight of the earlier burst is
    // gone (61s would still carry most of it; see the weighting test above).
    const again = await gateHostedCall(run, CUSTOMER, cfg, "req-4", clock.now() + 121_000);
    expect(again.ok).toBe(true);
  });
});
