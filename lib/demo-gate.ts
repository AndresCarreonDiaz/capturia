// Spend brake for a PUBLIC demo deployment (opt-in, env-gated): the
// /api/copilotkit env-key path runs the agent on the deployer's own model
// key, so an open deploy is an open proxy. When the deployer sets either
// limit below, model-running requests without BYOK headers pass through a
// per-IP per-minute cap and a global per-UTC-day budget before reaching the
// runtime. Both limits unset (the default) = gate off, so self-hosts behave
// exactly like a dev checkout.
//
// Counters are fixed-window INCR buckets keyed by minute / day. On a
// serverless deploy the store should be the same Upstash-REST Redis the vote
// rooms use (instances share nothing); the in-memory store is a best-effort
// fallback for single-process `next start`. IPs are salted-hashed before
// they become Redis keys and every bucket expires on its own, so the gate
// stores no durable per-visitor data. A store error fails OPEN: one lost
// check must not brick the demo, and the hard backstop for spend is the
// key's own provider-side quota (use a free-tier key for a public demo).

import { createHash } from "node:crypto";
import type { RedisRunner } from "./upstash";

export interface DemoGateConfig {
  // Model-running requests allowed per IP per minute. null = no per-IP cap.
  ipPerMinute: number | null;
  // Model-running requests allowed per UTC day across ALL visitors.
  // null = no daily budget.
  dailyTotal: number | null;
}

// Both vars absent (or non-positive / malformed) => null => gate disabled.
export function demoGateFromEnv(
  env: Record<string, string | undefined> = process.env
): DemoGateConfig | null {
  const parse = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const ipPerMinute = parse(env.CAPTURIA_DEMO_IP_RPM);
  const dailyTotal = parse(env.CAPTURIA_DEMO_DAILY_REQUESTS);
  if (ipPerMinute === null && dailyTotal === null) return null;
  return { ipPerMinute, dailyTotal };
}

// Increment a counter bucket and return the post-increment count. The TTL
// only bounds Redis growth: bucket keys embed their window, so an expired
// EXPIRE call can never extend a window.
export interface DemoGateStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export function redisGateStore(run: RedisRunner): DemoGateStore {
  return {
    async incr(key, ttlSeconds) {
      const count = Number(await run(["INCR", key]));
      // First writer owns the expiry; later INCRs on the same bucket skip
      // the extra round trip.
      if (count === 1) await run(["EXPIRE", key, ttlSeconds]);
      return count;
    },
  };
}

export function memoryGateStore(): DemoGateStore {
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return {
    async incr(key, ttlSeconds) {
      const now = Date.now();
      // Opportunistic prune keeps the map bounded without a timer.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (v.expiresAt <= now) buckets.delete(k);
      }
      const entry = buckets.get(key);
      if (!entry || entry.expiresAt <= now) {
        buckets.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    },
  };
}

// First hop of x-forwarded-for (what Vercel/most proxies set), else
// x-real-ip, else a shared bucket. A spoofable header is fine here: this is
// a courtesy brake for a free demo, not an auth boundary — the daily budget
// catches whatever per-IP dodging lets through.
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

// Salted hash so raw visitor IPs never become Redis keys. The salt is static
// per deploy config, which is enough: the goal is "no IP list at rest", not
// unlinkability across requests (the whole point is counting repeats).
function ipBucketId(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 16);
}

export interface DemoGateVerdict {
  allowed: boolean;
  // Set when refused: seconds until the refusing window rolls over.
  retryAfterSeconds?: number;
  reason?: "ip" | "daily";
}

export async function checkDemoGate(opts: {
  config: DemoGateConfig;
  store: DemoGateStore;
  ip: string;
  // Injected for tests; production passes Date.now().
  nowMs: number;
  // Deploy-stable hash salt. Defaults to a fixed public constant, which keeps
  // raw IPs out of the store but is brute-forceable by anyone who can read
  // it; deployers wanting real unlinkability set CAPTURIA_DEMO_SALT.
  salt?: string;
}): Promise<DemoGateVerdict> {
  const { config, store, ip, nowMs } = opts;
  const salt = opts.salt || "capturia-demo";
  try {
    if (config.ipPerMinute !== null) {
      const minute = Math.floor(nowMs / 60_000);
      const count = await store.incr(
        `demo:ip:${ipBucketId(ip, salt)}:${minute}`,
        90
      );
      if (count > config.ipPerMinute) {
        return {
          allowed: false,
          reason: "ip",
          retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * 60_000 - nowMs) / 1000)),
        };
      }
    }
    if (config.dailyTotal !== null) {
      const day = new Date(nowMs).toISOString().slice(0, 10);
      const count = await store.incr(`demo:day:${day}`, 2 * 24 * 60 * 60);
      if (count > config.dailyTotal) {
        const nextMidnightMs = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
        return {
          allowed: false,
          reason: "daily",
          retryAfterSeconds: Math.max(1, Math.ceil((nextMidnightMs - nowMs) / 1000)),
        };
      }
    }
  } catch (err) {
    // Fail open: a counter-store hiccup must not take the demo down, and the
    // provider-side quota on the key still bounds worst-case spend.
    console.warn("capturia demo gate: store error, allowing request:", err);
  }
  return { allowed: true };
}

// The 429 body the studio surfaces when the shared demo is saturated.
export function demoLimitMessage(reason: "ip" | "daily"): string {
  return reason === "ip"
    ? "The shared demo is rate-limited so it stays free for everyone. Give it a minute and try again — or run Capturia with your own free Gemini key: https://github.com/AndresCarreonDiaz/capturia"
    : "The shared demo hit its daily budget. It resets at midnight UTC — or run Capturia now with your own free Gemini key: https://github.com/AndresCarreonDiaz/capturia";
}
