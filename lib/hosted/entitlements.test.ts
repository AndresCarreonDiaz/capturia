// Pins the hosted entitlement lifecycle (lib/hosted/entitlements.ts) against
// the in-memory runner: activation code mint/one-time-use/expiry, the
// 3-device cap, refresh-token storage-as-hash, and the Stripe webhook ->
// entitlement cache transitions.

import { describe, expect, it } from "vitest";
import { createMemoryRedis } from "./memory-redis";
import { isEntitled, readEntitlement } from "./gate";
import {
  ACTIVATION_CODE_RE,
  applyStripeEvent,
  consumeActivationCode,
  isDeviceRegistered,
  isValidDeviceId,
  lookupRefreshToken,
  MAX_DEVICES,
  mintActivationCode,
  mintRefreshToken,
  registerDevice,
  storeActivation,
  storeActivationBySession,
  takeActivationCodeForSession,
  writeEntitlement,
} from "./entitlements";

const T0 = Date.UTC(2026, 6, 9, 12, 0, 0);
const CUSTOMER = "cus_ent_test";

function world() {
  let now = T0;
  const clock = { now: () => now, tick: (ms: number) => (now += ms) };
  const redis = createMemoryRedis(clock.now);
  return { run: redis.run, clock };
}

describe("activation codes", () => {
  it("mints codes in the CAPTURIA-XXXX-XXXX-XXXX-XXXX shape", () => {
    for (let i = 0; i < 20; i++) {
      expect(mintActivationCode()).toMatch(ACTIVATION_CODE_RE);
    }
  });

  it("stores, consumes once, and refuses replays", async () => {
    const { run } = world();
    const code = mintActivationCode();
    await storeActivation(run, code, { customer: CUSTOMER, subscription: "sub_1" });
    const first = await consumeActivationCode(run, code);
    expect(first).toEqual({ customer: CUSTOMER, subscription: "sub_1" });
    expect(await consumeActivationCode(run, code)).toBeNull();
  });

  it("refuses malformed and unknown codes without touching the store shape", async () => {
    const { run } = world();
    expect(await consumeActivationCode(run, "not-a-code")).toBeNull();
    expect(await consumeActivationCode(run, 42)).toBeNull();
    expect(await consumeActivationCode(run, mintActivationCode())).toBeNull(); // valid shape, never stored
  });

  it("expires unredeemed codes after the TTL", async () => {
    const { run, clock } = world();
    const code = mintActivationCode();
    await storeActivation(run, code, { customer: CUSTOMER, subscription: null });
    clock.tick(31 * 24 * 60 * 60 * 1000);
    expect(await consumeActivationCode(run, code)).toBeNull();
  });

  it("hands the session-filed code over exactly once", async () => {
    const { run } = world();
    await storeActivationBySession(run, "cs_test_123", "CAPTURIA-AAAA-BBBB-CCCC-DDDD");
    expect(await takeActivationCodeForSession(run, "cs_test_123")).toBe(
      "CAPTURIA-AAAA-BBBB-CCCC-DDDD"
    );
    expect(await takeActivationCodeForSession(run, "cs_test_123")).toBeNull();
    expect(await takeActivationCodeForSession(run, "cs_/../weird")).toBeNull();
  });
});

describe("device registration", () => {
  it("accepts sane device ids and rejects junk", () => {
    expect(isValidDeviceId("mac-a1b2c3d4")).toBe(true);
    expect(isValidDeviceId("short")).toBe(false);
    expect(isValidDeviceId("has spaces here")).toBe(false);
    expect(isValidDeviceId(123)).toBe(false);
  });

  it("caps at 3 devices and is idempotent per device", async () => {
    const { run } = world();
    for (let i = 1; i <= MAX_DEVICES; i++) {
      const res = await registerDevice(run, CUSTOMER, `device-${i}`);
      expect(res).toEqual({ ok: true, devices: i });
    }
    expect(await registerDevice(run, CUSTOMER, "device-4")).toEqual({
      ok: false,
      error: "device_limit",
    });
    // Re-registering an existing device is not a new seat.
    expect(await registerDevice(run, CUSTOMER, "device-2")).toEqual({ ok: true, devices: 3 });
    expect(await isDeviceRegistered(run, CUSTOMER, "device-2")).toBe(true);
    expect(await isDeviceRegistered(run, CUSTOMER, "device-4")).toBe(false);
  });
});

describe("refresh tokens", () => {
  it("round-trips mint -> lookup and stores only a hash", async () => {
    const { run } = world();
    const token = await mintRefreshToken(run, CUSTOMER, "device-1x", T0);
    expect(token.startsWith("crt_")).toBe(true);
    const record = await lookupRefreshToken(run, token);
    expect(record).toMatchObject({ customer: CUSTOMER, deviceId: "device-1x" });
    // Nothing under a key derived from the plaintext: the store holds hashes.
    expect(await run(["GET", `hosted:refresh:${token}`])).toBeNull();
  });

  it("rejects unknown, malformed, and oversized tokens", async () => {
    const { run } = world();
    await mintRefreshToken(run, CUSTOMER, "device-1x", T0);
    expect(await lookupRefreshToken(run, "crt_never-minted")).toBeNull();
    expect(await lookupRefreshToken(run, "prefixless")).toBeNull();
    expect(await lookupRefreshToken(run, `crt_${"x".repeat(300)}`)).toBeNull();
    expect(await lookupRefreshToken(run, null)).toBeNull();
  });
});

describe("applyStripeEvent (webhook -> cache transitions)", () => {
  const checkoutEvent = (over: Record<string, unknown> = {}) => ({
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abc",
        customer: CUSTOMER,
        subscription: "sub_9",
        mode: "subscription",
        payment_status: "paid",
        ...over,
      },
    },
  });

  it("completed checkout activates the customer and mints a redeemable code", async () => {
    const { run } = world();
    const codes: string[] = [];
    const outcome = await applyStripeEvent(run, checkoutEvent(), T0, () => {
      const code = mintActivationCode();
      codes.push(code);
      return code;
    });
    expect(outcome).toEqual({ handled: true, action: "activation_minted", customer: CUSTOMER });
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(true);
    expect(codes).toHaveLength(1);
    expect(await consumeActivationCode(run, codes[0])).toMatchObject({ customer: CUSTOMER });
    expect(await takeActivationCodeForSession(run, "cs_test_abc")).toBe(codes[0]);
  });

  it("ignores unpaid or non-subscription checkouts", async () => {
    const { run } = world();
    expect((await applyStripeEvent(run, checkoutEvent({ payment_status: "unpaid" }), T0)).handled).toBe(false);
    expect((await applyStripeEvent(run, checkoutEvent({ mode: "payment" }), T0)).handled).toBe(false);
    expect(await readEntitlement(run, CUSTOMER)).toBeNull();
  });

  it("subscription.updated follows Stripe's status, unknown statuses fail closed", async () => {
    const { run } = world();
    const sub = (status: string) => ({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_9", customer: CUSTOMER, status } },
    });
    await applyStripeEvent(run, sub("active"), T0);
    expect((await readEntitlement(run, CUSTOMER))?.status).toBe("active");
    await applyStripeEvent(run, sub("past_due"), T0);
    expect((await readEntitlement(run, CUSTOMER))?.status).toBe("past_due");
    await applyStripeEvent(run, sub("unpaid"), T0);
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
  });

  it("subscription.deleted revokes the entitlement", async () => {
    const { run } = world();
    await writeEntitlement(run, CUSTOMER, "active", "sub_9", T0);
    const outcome = await applyStripeEvent(
      run,
      { type: "customer.subscription.deleted", data: { object: { id: "sub_9", customer: CUSTOMER } } },
      T0
    );
    expect(outcome).toEqual({ handled: true, action: "entitlement_revoked", customer: CUSTOMER });
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
  });

  it("acks unknown event types untouched", async () => {
    const { run } = world();
    const outcome = await applyStripeEvent(run, { type: "invoice.paid", data: { object: {} } }, T0);
    expect(outcome).toEqual({ handled: false });
  });
});
