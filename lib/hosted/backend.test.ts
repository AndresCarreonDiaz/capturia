// Pins backend selection (lib/hosted/backend.ts): memory mode without
// Upstash env, redis mode with it, the production refusal of in-memory
// state, and the dev entitlement seed used by the local verification
// runbook, including its memory-mode-only guard.

import { afterEach, describe, expect, it } from "vitest";
import { _resetHostedBackend, DEV_ACTIVATION_CODE, getHostedBackend } from "./backend";
import { isEntitled, readEntitlement } from "./gate";
import { consumeActivationCode } from "./entitlements";

afterEach(() => _resetHostedBackend());

describe("getHostedBackend", () => {
  it("uses memory mode without Upstash env and caches the choice", async () => {
    const backend = await getHostedBackend({});
    expect(backend.mode).toBe("memory");
    expect(await getHostedBackend({ UPSTASH_REDIS_REST_URL: "ignored-after-cache" })).toBe(backend);
  });

  it("selects redis mode when the Upstash env exists (either spelling)", async () => {
    const backend = await getHostedBackend({
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "tok",
    });
    expect(backend.mode).toBe("redis");
  });

  it("refuses in-memory state in production instead of losing paid activations", async () => {
    await expect(getHostedBackend({ NODE_ENV: "production" })).rejects.toThrow(/redis/i);
    await expect(getHostedBackend({ VERCEL_ENV: "production" })).rejects.toThrow(/redis/i);
  });

  it("does not cache a rejected init: the next call retries fresh", async () => {
    await expect(getHostedBackend({ NODE_ENV: "production" })).rejects.toThrow();
    // Same process, env fixed (e.g. redeploy with Upstash vars): must work
    // without _resetHostedBackend.
    const backend = await getHostedBackend({
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(backend.mode).toBe("redis");
  });

  it("seeds the dev entitlement and activation code when opted in", async () => {
    const backend = await getHostedBackend({ CAPTURIA_HOSTED_DEV_ENTITLEMENT: "cus_dev" });
    expect(isEntitled(await readEntitlement(backend.run, "cus_dev"))).toBe(true);
    expect(await consumeActivationCode(backend.run, DEV_ACTIVATION_CODE)).toMatchObject({
      customer: "cus_dev",
    });
  });

  it("never seeds into real Redis, even for a dev process holding Upstash creds", async () => {
    // mode "redis" + dev var: the seed must be skipped BEFORE any network
    // call happens (this test would hang or throw if one were attempted).
    const backend = await getHostedBackend({
      CAPTURIA_HOSTED_DEV_ENTITLEMENT: "cus_dev",
      UPSTASH_REDIS_REST_URL: "https://example.invalid",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(backend.mode).toBe("redis");
  });
});
