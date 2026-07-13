// Pins the in-memory RedisRunner (lib/hosted/memory-redis.ts) to Upstash
// REST reply shapes, since every hosted gate and entitlement test builds on
// it: a fake that drifts from real Redis would make the whole suite lie.

import { describe, expect, it } from "vitest";
import { createMemoryRedis } from "./memory-redis";

const T0 = 1_000_000;

function world() {
  let now = T0;
  const redis = createMemoryRedis(() => now);
  return { run: redis.run, tick: (ms: number) => (now += ms) };
}

describe("strings and counters", () => {
  it("SET/GET/DEL round-trip with Upstash reply shapes", async () => {
    const { run } = world();
    expect(await run(["SET", "k", "v"])).toBe("OK");
    expect(await run(["GET", "k"])).toBe("v");
    expect(await run(["DEL", "k"])).toBe(1);
    expect(await run(["GET", "k"])).toBeNull();
    expect(await run(["DEL", "k"])).toBe(0);
  });

  it("SET NX only succeeds on a free key", async () => {
    const { run } = world();
    expect(await run(["SET", "k", "a", "NX", "PX", 1000])).toBe("OK");
    expect(await run(["SET", "k", "b", "NX", "PX", 1000])).toBeNull();
    expect(await run(["GET", "k"])).toBe("a");
  });

  it("PX/EX expire keys against the injected clock", async () => {
    const { run, tick } = world();
    await run(["SET", "px", "v", "PX", 500]);
    await run(["SET", "ex", "v", "EX", 2]);
    tick(600);
    expect(await run(["GET", "px"])).toBeNull();
    expect(await run(["GET", "ex"])).toBe("v");
    tick(1500);
    expect(await run(["GET", "ex"])).toBeNull();
  });

  it("INCR/INCRBY count from zero and preserve TTLs", async () => {
    const { run, tick } = world();
    expect(await run(["INCR", "n"])).toBe(1);
    expect(await run(["INCRBY", "n", 41])).toBe(42);
    expect(await run(["PEXPIRE", "n", 100])).toBe(1);
    expect(await run(["INCR", "n"])).toBe(43); // INCR must not clear the TTL
    tick(101);
    expect(await run(["GET", "n"])).toBeNull();
    expect(await run(["PEXPIRE", "gone", 100])).toBe(0);
  });

  it("GETDEL returns then removes", async () => {
    const { run } = world();
    await run(["SET", "k", "v"]);
    expect(await run(["GETDEL", "k"])).toBe("v");
    expect(await run(["GETDEL", "k"])).toBeNull();
  });
});

describe("sets", () => {
  it("SADD/SCARD/SISMEMBER/SREM/SMEMBERS behave like Redis sets", async () => {
    const { run } = world();
    expect(await run(["SADD", "s", "a", "b"])).toBe(2);
    expect(await run(["SADD", "s", "b"])).toBe(0);
    expect(await run(["SCARD", "s"])).toBe(2);
    expect(await run(["SISMEMBER", "s", "a"])).toBe(1);
    expect(await run(["SISMEMBER", "s", "z"])).toBe(0);
    expect(await run(["SMEMBERS", "s"])).toEqual(["a", "b"]);
    expect(await run(["SREM", "s", "a", "z"])).toBe(1);
    expect(await run(["SCARD", "s"])).toBe(1);
  });
});

describe("guard rails", () => {
  it("throws on commands the hosted stack does not use", async () => {
    const { run } = world();
    await expect(run(["HGETALL", "k"])).rejects.toThrow(/unsupported command/);
  });

  it("throws on type confusion instead of returning nonsense", async () => {
    const { run } = world();
    await run(["SADD", "s", "a"]);
    await expect(run(["GET", "s"])).rejects.toThrow(/wrong type/);
  });
});
