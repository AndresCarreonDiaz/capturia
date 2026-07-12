// Hosted-tier state backend, following lib/vote-backend.ts: Upstash Redis
// when its env vars exist (the production shape decided on issue #10), else
// a single-process in-memory runner so local dev and tests run with zero
// paid services. Same RedisRunner contract either way, so every gate and
// entitlement helper is identical in both modes.

import { createRedisRunner, upstashFromEnv, type RedisRunner } from "../upstash";
import { createMemoryRedis } from "./memory-redis";
import { storeActivation, writeEntitlement } from "./entitlements";

export interface HostedBackend {
  mode: "memory" | "redis";
  run: RedisRunner;
}

let cached: Promise<HostedBackend> | null = null;

type Env = Record<string, string | undefined>;

// Local verification hook (documented in docs/hosted-tier.md): when
// CAPTURIA_HOSTED_DEV_ENTITLEMENT holds a customer id, the backend seeds an
// active entitlement and a fixed activation code for it, so the whole flow
// (activate -> token -> generate) is drivable without Stripe. Seeded ONLY
// into the in-memory backend: a dev process holding real Upstash credentials
// must never plant a publicly known activation code in shared Redis, and a
// production build (which refuses memory mode below) can never seed at all.
export const DEV_ACTIVATION_CODE = "CAPTURIA-DEV0-DEV0-DEV0-DEV0";

async function seedDevEntitlement(backend: HostedBackend, env: Env): Promise<void> {
  const customer = env.CAPTURIA_HOSTED_DEV_ENTITLEMENT;
  if (!customer || backend.mode !== "memory" || env.NODE_ENV === "production") return;
  await writeEntitlement(backend.run, customer, "active", "sub_dev", Date.now());
  await storeActivation(backend.run, DEV_ACTIVATION_CODE, { customer, subscription: "sub_dev" });
}

// In production the in-memory fallback is not a degraded mode, it is data
// loss: each serverless invocation would get a blank store, so a paid
// checkout's activation code would be 200-acked into the void. Refusing
// loudly makes Stripe retry (webhook) and the app surface a 503 until real
// Redis env exists.
function requireRedisInProduction(env: Env): void {
  if (env.NODE_ENV === "production" || env.VERCEL_ENV === "production") {
    throw new Error(
      "capturia hosted: refusing in-memory state in production; configure Upstash Redis env."
    );
  }
}

export function getHostedBackend(env: Env = process.env): Promise<HostedBackend> {
  if (cached) return cached;
  const attempt = (async () => {
    const upstash = upstashFromEnv(env);
    if (!upstash) requireRedisInProduction(env);
    const backend: HostedBackend = upstash
      ? { mode: "redis", run: createRedisRunner(upstash) }
      : { mode: "memory", run: createMemoryRedis().run };
    await seedDevEntitlement(backend, env);
    return backend;
  })();
  cached = attempt;
  // A rejected init must not brick every later request: clear the cache so
  // the next call retries (e.g. after the missing env is deployed).
  attempt.catch(() => {
    if (cached === attempt) cached = null;
  });
  return attempt;
}

// Test hook, mirroring _resetVoteBackend.
export function _resetHostedBackend() {
  cached = null;
}
