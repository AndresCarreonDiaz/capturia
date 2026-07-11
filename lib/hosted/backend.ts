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
// (activate -> token -> generate) is drivable without Stripe. Guarded to
// non-production builds so it can never fabricate access on a real deploy.
export const DEV_ACTIVATION_CODE = "CAPTURIA-DEV0-DEV0-DEV0-DEV0";

async function seedDevEntitlement(run: RedisRunner, env: Env): Promise<void> {
  const customer = env.CAPTURIA_HOSTED_DEV_ENTITLEMENT;
  if (!customer || env.NODE_ENV === "production") return;
  await writeEntitlement(run, customer, "active", "sub_dev", Date.now());
  await storeActivation(run, DEV_ACTIVATION_CODE, { customer, subscription: "sub_dev" });
}

export function getHostedBackend(env: Env = process.env): Promise<HostedBackend> {
  if (cached) return cached;
  cached = (async () => {
    const upstash = upstashFromEnv(env);
    const backend: HostedBackend = upstash
      ? { mode: "redis", run: createRedisRunner(upstash) }
      : { mode: "memory", run: createMemoryRedis().run };
    await seedDevEntitlement(backend.run, env);
    return backend;
  })();
  return cached;
}

// Test hook, mirroring _resetVoteBackend.
export function _resetHostedBackend() {
  cached = null;
}
