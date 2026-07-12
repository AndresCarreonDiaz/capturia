import { describe, expect, it } from "vitest";
import type { BeaconEvent, BeaconPayload } from "./beacon";
import { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./beacon";
import {
  _resetBeaconStore,
  createMemoryBeaconStore,
  createRedisBeaconStore,
  getBeaconStore,
} from "./beacon-store";

const DAY_MS = 24 * 3600 * 1000;
// 2026-07-10T12:00:00Z, mid-month so week math stays inside one month.
const NOW = Date.UTC(2026, 6, 10, 12);

function payload(installId: string, event: BeaconEvent = "launch", appVersion = "0.1.0"): BeaconPayload {
  return { installId, event, appVersion, macosVersion: "26.0" };
}

describe("memory beacon store aggregation", () => {
  it("counts unique installs per day, trailing week, and month", async () => {
    const store = createMemoryBeaconStore();
    // Two installs today, one of them twice (uniqueness must hold).
    await store.record(payload("id-a"), NOW);
    await store.record(payload("id-a"), NOW);
    await store.record(payload("id-b"), NOW);
    // A third install 3 days ago: in the week and month, not in today.
    await store.record(payload("id-c"), NOW - 3 * DAY_MS);
    // A fourth 20 days ago: in the month only.
    await store.record(payload("id-d"), NOW - 20 * DAY_MS);

    const s = await store.summary(NOW);
    expect(s.backend).toBe("memory");
    expect(s.dau).toBe(2);
    expect(s.wau).toBe(3);
    expect(s.mau).toBe(3); // id-d landed in June, not July
    expect(s.events.launch).toBe(5);
  });

  it("counts activations as unique installs, not events", async () => {
    const store = createMemoryBeaconStore();
    await store.record(payload("id-a", "camera-installed"), NOW);
    await store.record(payload("id-a", "camera-installed"), NOW);
    await store.record(payload("id-b", "camera-installed"), NOW);
    const s = await store.summary(NOW);
    expect(s.activations).toBe(2);
    expect(s.events["camera-installed"]).toBe(3);
  });

  it("tallies launches per app version and caps distinct versions", async () => {
    const store = createMemoryBeaconStore();
    await store.record(payload("id-a", "launch", "0.1.0"), NOW);
    await store.record(payload("id-b", "launch", "0.1.0"), NOW);
    await store.record(payload("id-c", "launch", "0.2.0"), NOW);
    // Version minting: distinct fields stop growing at the cap...
    for (let i = 0; i < 300; i++) {
      await store.record(payload("id-x", "launch", `9.9.${i}`), NOW);
    }
    const s = await store.summary(NOW);
    expect(s.versions["0.1.0"]).toBe(2);
    expect(s.versions["0.2.0"]).toBe(1);
    expect(Object.keys(s.versions).length).toBeLessThanOrEqual(200);
    // ...and the refusals are visible, not silent: 300 attempts against a
    // hash that already held 2 fields leaves 102 past the cap.
    expect(s.versionsOverflow).toBe(102);
    // ...but known versions keep counting past it.
    await store.record(payload("id-y", "launch", "0.1.0"), NOW);
    expect((await store.summary(NOW)).versions["0.1.0"]).toBe(3);
  });

  it("expires stale daily buckets like the Redis TTL would", async () => {
    const store = createMemoryBeaconStore();
    await store.record(payload("id-old"), NOW - 45 * DAY_MS);
    await store.record(payload("id-new"), NOW);
    const s = await store.summary(NOW);
    expect(s.dau).toBe(1);
    expect(s.wau).toBe(1);
  });

  it("rate-limits a bucket per fixed window and recovers after it", async () => {
    const store = createMemoryBeaconStore();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(await store.allow("bucket-1", NOW)).toBe(true);
    }
    expect(await store.allow("bucket-1", NOW)).toBe(false);
    // Another bucket is unaffected.
    expect(await store.allow("bucket-2", NOW)).toBe(true);
    // The window rolling over resets the count.
    expect(await store.allow("bucket-1", NOW + RATE_LIMIT_WINDOW_MS)).toBe(true);
  });
});

// Glue-level tests for the Redis flavor: a fake pipeline plays the Upstash
// side, so these pin command marshaling and reply parsing. The commands
// themselves (PFADD/PFCOUNT/INCR) are Redis built-ins.
function fakePipeline(result: unknown[]) {
  const calls: (string | number)[][][] = [];
  const pipeline = async (commands: (string | number)[][]) => {
    calls.push(commands);
    return result;
  };
  return { pipeline, calls };
}

describe("redis beacon store", () => {
  it("records a launch as day/month HLL adds, TTLs, a counter, and the version tally", async () => {
    const { pipeline, calls } = fakePipeline([1, 1, 1, 1, 1, 1]);
    const store = createRedisBeaconStore(pipeline);
    await store.record(payload("id-a"), NOW);
    expect(calls).toHaveLength(1);
    const [commands] = calls;
    expect(commands.map((c) => c[0])).toEqual([
      "PFADD",
      "EXPIRE",
      "PFADD",
      "EXPIRE",
      "INCR",
      "EVAL",
    ]);
    expect(commands[0][1]).toBe("beacon:ids:d:20260710");
    expect(commands[0][2]).toBe("id-a");
    expect(commands[2][1]).toBe("beacon:ids:m:202607");
    expect(commands[4][1]).toBe("beacon:count:launch");
    // The version EVAL carries the hash key, the overflow counter key, and
    // the version field.
    expect(commands[5]).toContain("beacon:versions");
    expect(commands[5]).toContain("beacon:versions-overflow");
    expect(commands[5]).toContain("0.1.0");
  });

  it("records an activation into the activated HLL instead of the version tally", async () => {
    const { pipeline, calls } = fakePipeline([1, 1, 1, 1, 1, 1]);
    const store = createRedisBeaconStore(pipeline);
    await store.record(payload("id-a", "camera-installed"), NOW);
    const [commands] = calls;
    expect(commands[5]).toEqual(["PFADD", "beacon:activated", "id-a"]);
  });

  it("parses the summary reply positionally, including the flat versions hash", async () => {
    const { pipeline, calls } = fakePipeline([
      12, // dau
      34, // wau
      56, // mau
      7, // activations
      "100", // launch count
      "8", // camera-installed count
      null, // update-check count never incremented
      ["0.1.0", "90", "0.2.0", "10"],
      "5", // versions overflow counter
    ]);
    const store = createRedisBeaconStore(pipeline);
    const s = await store.summary(NOW);
    expect(s).toEqual({
      backend: "redis",
      day: "20260710",
      month: "202607",
      dau: 12,
      wau: 34,
      mau: 56,
      activations: 7,
      events: { launch: 100, "camera-installed": 8, "update-check": 0 },
      versions: { "0.1.0": 90, "0.2.0": 10 },
      versionsOverflow: 5,
    });
    // The WAU PFCOUNT unions the 7 trailing daily keys in one command.
    const [commands] = calls;
    expect(commands[1][0]).toBe("PFCOUNT");
    expect(commands[1]).toHaveLength(8);
  });

  it("maps the limiter EVAL reply onto allow/deny", async () => {
    const under = createRedisBeaconStore(fakePipeline([RATE_LIMIT_MAX]).pipeline);
    expect(await under.allow("bucket")).toBe(true);
    const over = createRedisBeaconStore(fakePipeline([RATE_LIMIT_MAX + 1]).pipeline);
    expect(await over.allow("bucket")).toBe(false);
  });
});

describe("getBeaconStore", () => {
  it("picks memory without Upstash env and redis with it", () => {
    _resetBeaconStore();
    expect(getBeaconStore({}).mode).toBe("memory");
    _resetBeaconStore();
    expect(
      getBeaconStore({
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }).mode
    ).toBe("redis");
    _resetBeaconStore();
  });
});
