import { describe, expect, it } from "vitest";
import {
  checkDemoGate,
  clientIpFrom,
  demoGateFromEnv,
  demoLimitMessage,
  memoryGateStore,
  redisGateStore,
  type DemoGateStore,
} from "./demo-gate";

const NOW = Date.parse("2026-08-18T12:00:30.000Z");

describe("demoGateFromEnv", () => {
  it("is disabled when neither limit is set", () => {
    expect(demoGateFromEnv({})).toBeNull();
  });

  it("reads both limits", () => {
    expect(
      demoGateFromEnv({ CAPTURIA_DEMO_IP_RPM: "6", CAPTURIA_DEMO_DAILY_REQUESTS: "300" })
    ).toEqual({ ipPerMinute: 6, dailyTotal: 300 });
  });

  it("accepts one limit without the other", () => {
    expect(demoGateFromEnv({ CAPTURIA_DEMO_IP_RPM: "6" })).toEqual({
      ipPerMinute: 6,
      dailyTotal: null,
    });
  });

  it("treats malformed and non-positive values as unset", () => {
    expect(demoGateFromEnv({ CAPTURIA_DEMO_IP_RPM: "0" })).toBeNull();
    expect(demoGateFromEnv({ CAPTURIA_DEMO_IP_RPM: "-3" })).toBeNull();
    expect(demoGateFromEnv({ CAPTURIA_DEMO_IP_RPM: "lots" })).toBeNull();
    expect(demoGateFromEnv({ CAPTURIA_DEMO_IP_RPM: "2.5" })).toBeNull();
  });
});

describe("clientIpFrom", () => {
  it("takes the first hop of x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(clientIpFrom(h)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip then to a shared bucket", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });
});

describe("checkDemoGate per-IP window", () => {
  it("allows up to the limit and refuses the request after it", async () => {
    const store = memoryGateStore();
    const config = { ipPerMinute: 2, dailyTotal: null };
    const run = () => checkDemoGate({ config, store, ip: "203.0.113.9", nowMs: NOW });
    expect((await run()).allowed).toBe(true);
    expect((await run()).allowed).toBe(true);
    const third = await run();
    expect(third).toMatchObject({ allowed: false, reason: "ip" });
    // 30s into the minute => the window rolls over in 30s.
    expect(third.retryAfterSeconds).toBe(30);
  });

  it("counts IPs independently", async () => {
    const store = memoryGateStore();
    const config = { ipPerMinute: 1, dailyTotal: null };
    await checkDemoGate({ config, store, ip: "203.0.113.9", nowMs: NOW });
    const other = await checkDemoGate({ config, store, ip: "203.0.113.10", nowMs: NOW });
    expect(other.allowed).toBe(true);
  });

  it("resets in the next minute bucket", async () => {
    const store = memoryGateStore();
    const config = { ipPerMinute: 1, dailyTotal: null };
    await checkDemoGate({ config, store, ip: "203.0.113.9", nowMs: NOW });
    const nextMinute = await checkDemoGate({
      config,
      store,
      ip: "203.0.113.9",
      nowMs: NOW + 60_000,
    });
    expect(nextMinute.allowed).toBe(true);
  });
});

describe("checkDemoGate daily budget", () => {
  it("refuses once the shared daily budget is spent, with a reset-at-midnight retry", async () => {
    const store = memoryGateStore();
    const config = { ipPerMinute: null, dailyTotal: 2 };
    await checkDemoGate({ config, store, ip: "a", nowMs: NOW });
    await checkDemoGate({ config, store, ip: "b", nowMs: NOW });
    const third = await checkDemoGate({ config, store, ip: "c", nowMs: NOW });
    expect(third).toMatchObject({ allowed: false, reason: "daily" });
    // 12:00:30Z => midnight UTC is 11h 59m 30s away.
    expect(third.retryAfterSeconds).toBe(11 * 3600 + 59 * 60 + 30);
  });

  it("a refused per-IP request does not spend the daily budget", async () => {
    const calls: string[] = [];
    const store: DemoGateStore = {
      async incr(key) {
        calls.push(key);
        return 99;
      },
    };
    const config = { ipPerMinute: 1, dailyTotal: 100 };
    const verdict = await checkDemoGate({ config, store, ip: "a", nowMs: NOW });
    expect(verdict.allowed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^demo:ip:/);
  });

  it("hashes the IP out of the store key", async () => {
    const calls: string[] = [];
    const store: DemoGateStore = {
      async incr(key) {
        calls.push(key);
        return 1;
      },
    };
    await checkDemoGate({
      config: { ipPerMinute: 5, dailyTotal: null },
      store,
      ip: "203.0.113.9",
      nowMs: NOW,
    });
    expect(calls[0]).not.toContain("203.0.113.9");
  });

  it("fails open when the store errors", async () => {
    const store: DemoGateStore = {
      async incr() {
        throw new Error("redis down");
      },
    };
    const verdict = await checkDemoGate({
      config: { ipPerMinute: 1, dailyTotal: 1 },
      store,
      ip: "a",
      nowMs: NOW,
    });
    expect(verdict.allowed).toBe(true);
  });
});

describe("redisGateStore", () => {
  it("INCRs, sets the TTL exactly once, and returns the count", async () => {
    const commands: (string | number)[][] = [];
    let count = 0;
    const store = redisGateStore(async (command) => {
      commands.push(command);
      if (command[0] === "INCR") return ++count;
      return "OK";
    });
    expect(await store.incr("demo:day:2026-08-18", 90)).toBe(1);
    expect(await store.incr("demo:day:2026-08-18", 90)).toBe(2);
    expect(commands).toEqual([
      ["INCR", "demo:day:2026-08-18"],
      ["EXPIRE", "demo:day:2026-08-18", 90],
      ["INCR", "demo:day:2026-08-18"],
    ]);
  });
});

describe("demoLimitMessage", () => {
  it("points refused visitors at running their own key", () => {
    expect(demoLimitMessage("ip")).toContain("free Gemini key");
    expect(demoLimitMessage("daily")).toContain("midnight UTC");
  });
});
