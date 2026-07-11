// Pins backend selection (lib/hosted/backend.ts): memory mode without
// Upstash env, redis mode with it, and the dev entitlement seed used by the
// local verification runbook, including its production guard.

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

  it("seeds the dev entitlement and activation code when opted in", async () => {
    const backend = await getHostedBackend({ CAPTURIA_HOSTED_DEV_ENTITLEMENT: "cus_dev" });
    expect(isEntitled(await readEntitlement(backend.run, "cus_dev"))).toBe(true);
    expect(await consumeActivationCode(backend.run, DEV_ACTIVATION_CODE)).toMatchObject({
      customer: "cus_dev",
    });
  });

  it("never seeds in production even when the var leaks in", async () => {
    const backend = await getHostedBackend({
      CAPTURIA_HOSTED_DEV_ENTITLEMENT: "cus_dev",
      NODE_ENV: "production",
    });
    expect(await readEntitlement(backend.run, "cus_dev")).toBeNull();
  });
});
