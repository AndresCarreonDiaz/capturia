// Storage for the anonymous desktop beacon (lib/beacon.ts, docs/telemetry.md).
// Same backend split as the vote store: Upstash Redis when its env vars
// exist (the hosted deploy), else a single-process in-memory store (local
// dev, tests, self-host). Identical result shapes either way, pinned by
// shared tests, so the route treats them the same.
//
// Privacy posture, enforced here: NO per-user records. Unique installs land
// in HyperLogLogs (daily/monthly), which can only ever answer "how many",
// never "who"; everything else is plain counters. The rate limiter is the
// only place an IP-derived value exists, always hashed by the route and
// always under a TTL of one window.

import {
  BEACON_EVENTS,
  DAY_KEY_TTL_S,
  MAX_VERSION_FIELDS,
  MONTH_KEY_TTL_S,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  VERSIONS_TTL_S,
  beaconKeys,
  lastNDayStamps,
  utcDayStamp,
  utcMonthStamp,
  type BeaconEvent,
  type BeaconPayload,
  type BeaconSummary,
} from "./beacon";
import { createRedisPipeline, upstashFromEnv, type RedisPipeline } from "./upstash";

export interface BeaconStore {
  mode: "memory" | "redis";
  record(payload: BeaconPayload, now?: number): Promise<void>;
  summary(now?: number): Promise<BeaconSummary>;
  // Fixed-window per-bucket rate limit; true = this request may proceed.
  // `max` defaults to the beacon POST budget; the public summary GET passes
  // its own tighter cap (SUMMARY_RATE_LIMIT_MAX) under a namespaced bucket.
  allow(bucket: string, now?: number, max?: number): Promise<boolean>;
}

function zeroCounts(): Record<BeaconEvent, number> {
  return { launch: 0, "camera-installed": 0, "update-check": 0 };
}

// ---------------------------------------------------------------- memory --

export function createMemoryBeaconStore(): BeaconStore {
  const days = new Map<string, Set<string>>();
  const months = new Map<string, Set<string>>();
  const activated = new Set<string>();
  const counts = zeroCounts();
  const versions = new Map<string, number>();
  let versionsOverflow = 0;
  const limiter = new Map<string, { count: number; resetAt: number }>();

  // Mirror of the Redis TTLs so a long-lived dev server does not grow
  // unboundedly. Stamps are fixed-width numerics, so string compare orders
  // them chronologically.
  function prune(now: number) {
    const oldestDay = utcDayStamp(now - DAY_KEY_TTL_S * 1000);
    for (const stamp of days.keys()) if (stamp < oldestDay) days.delete(stamp);
    const oldestMonth = utcMonthStamp(now - MONTH_KEY_TTL_S * 1000);
    for (const stamp of months.keys()) if (stamp < oldestMonth) months.delete(stamp);
  }

  return {
    mode: "memory",
    async record(payload, now = Date.now()) {
      prune(now);
      const day = utcDayStamp(now);
      const month = utcMonthStamp(now);
      if (!days.has(day)) days.set(day, new Set());
      days.get(day)!.add(payload.installId);
      if (!months.has(month)) months.set(month, new Set());
      months.get(month)!.add(payload.installId);
      counts[payload.event] += 1;
      if (payload.event === "launch") {
        if (versions.has(payload.appVersion) || versions.size < MAX_VERSION_FIELDS) {
          versions.set(payload.appVersion, (versions.get(payload.appVersion) ?? 0) + 1);
        } else {
          // A NEW version past the cap: count the refusal so poisoning is
          // visible in the summary instead of silently freezing the metric.
          versionsOverflow += 1;
        }
      } else if (payload.event === "camera-installed") {
        activated.add(payload.installId);
      }
    },

    async summary(now = Date.now()) {
      prune(now);
      const week = new Set<string>();
      for (const stamp of lastNDayStamps(now, 7)) {
        for (const id of days.get(stamp) ?? []) week.add(id);
      }
      return {
        backend: "memory",
        day: utcDayStamp(now),
        month: utcMonthStamp(now),
        dau: days.get(utcDayStamp(now))?.size ?? 0,
        wau: week.size,
        mau: months.get(utcMonthStamp(now))?.size ?? 0,
        activations: activated.size,
        events: { ...counts },
        versions: Object.fromEntries(versions),
        versionsOverflow,
      };
    },

    async allow(bucket, now = Date.now(), max = RATE_LIMIT_MAX) {
      // Opportunistic sweep so abandoned buckets do not accumulate.
      if (limiter.size > 1000) {
        for (const [key, entry] of limiter) if (now >= entry.resetAt) limiter.delete(key);
      }
      const entry = limiter.get(bucket);
      if (!entry || now >= entry.resetAt) {
        limiter.set(bucket, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}

// ----------------------------------------------------------------- redis --

// Atomic INCR-with-window: the PEXPIRE rides in the same script so a crash
// between the two can never mint an immortal counter key (which would
// rate-limit one IP hash forever).
const RATE_LIMIT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return n
`;

// Versions hash with a field cap: known versions always count, new fields
// only while the hash is under the cap, so forged-but-valid payloads cannot
// mint unbounded fields on the metered backend. A refused NEW version is
// not a silent drop: it lands on the overflow counter (KEYS[2]) the summary
// surfaces, and both keys ride a long TTL so a poisoned hash ages out
// instead of freezing the metric forever (manual recovery: HDEL the junk
// fields; docs/telemetry.md).
const VERSION_LUA = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 or redis.call('HLEN', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
  redis.call('EXPIRE', KEYS[1], ARGV[3])
else
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 1
`;

// Redis HGETALL over REST arrives as a flat [field, value, ...] array.
function versionsFromFlat(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    out[String(raw[i])] = Number(raw[i + 1]) || 0;
  }
  return out;
}

// The pipeline runner is injected for testability; real deployments build
// one from env via lib/upstash.ts. Every method is a single round trip.
export function createRedisBeaconStore(pipeline: RedisPipeline): BeaconStore {
  return {
    mode: "redis",
    async record(payload, now = Date.now()) {
      const day = beaconKeys.day(now);
      const month = beaconKeys.month(now);
      const commands: (string | number)[][] = [
        ["PFADD", day, payload.installId],
        ["EXPIRE", day, DAY_KEY_TTL_S],
        ["PFADD", month, payload.installId],
        ["EXPIRE", month, MONTH_KEY_TTL_S],
        ["INCR", beaconKeys.count(payload.event)],
      ];
      if (payload.event === "launch") {
        commands.push([
          "EVAL",
          VERSION_LUA,
          2,
          beaconKeys.versions,
          beaconKeys.versionsOverflow,
          payload.appVersion,
          MAX_VERSION_FIELDS,
          VERSIONS_TTL_S,
        ]);
      } else if (payload.event === "camera-installed") {
        commands.push(["PFADD", beaconKeys.activated, payload.installId]);
      }
      await pipeline(commands);
    },

    async summary(now = Date.now()) {
      const res = await pipeline([
        ["PFCOUNT", beaconKeys.day(now)],
        // One multi-key PFCOUNT is the union of the trailing 7 dailies.
        ["PFCOUNT", ...beaconKeys.week(now)],
        ["PFCOUNT", beaconKeys.month(now)],
        ["PFCOUNT", beaconKeys.activated],
        ...BEACON_EVENTS.map((event) => ["GET", beaconKeys.count(event)]),
        ["HGETALL", beaconKeys.versions],
        ["GET", beaconKeys.versionsOverflow],
      ]);
      const events = zeroCounts();
      BEACON_EVENTS.forEach((event, i) => {
        events[event] = Number(res[4 + i]) || 0;
      });
      return {
        backend: "redis",
        day: utcDayStamp(now),
        month: utcMonthStamp(now),
        dau: Number(res[0]) || 0,
        wau: Number(res[1]) || 0,
        mau: Number(res[2]) || 0,
        activations: Number(res[3]) || 0,
        events,
        versions: versionsFromFlat(res[4 + BEACON_EVENTS.length]),
        versionsOverflow: Number(res[5 + BEACON_EVENTS.length]) || 0,
      };
    },

    async allow(bucket, _now, max = RATE_LIMIT_MAX) {
      const res = await pipeline([
        ["EVAL", RATE_LIMIT_LUA, 1, beaconKeys.rateLimit(bucket), RATE_LIMIT_WINDOW_MS],
      ]);
      return (Number(res[0]) || 0) <= max;
    },
  };
}

// ---------------------------------------------------------------- picker --

let cached: BeaconStore | null = null;

// Same selection rule as lib/vote-backend.ts, cached once per process. env
// is a plain string map so tests can pass literal subsets.
export function getBeaconStore(env: Record<string, string | undefined> = process.env): BeaconStore {
  if (cached) return cached;
  const upstash = upstashFromEnv(env);
  cached = upstash
    ? createRedisBeaconStore(createRedisPipeline(upstash))
    : createMemoryBeaconStore();
  return cached;
}

// Test hook: force re-selection (e.g. after mutating env in a test).
export function _resetBeaconStore() {
  cached = null;
}
