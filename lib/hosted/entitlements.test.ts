// Pins the hosted entitlement lifecycle (lib/hosted/entitlements.ts) against
// the in-memory runner: activation code mint/one-time-use/expiry/redemption,
// the 3-device cap, refresh-token storage-as-hash, and the Stripe webhook ->
// entitlement cache transitions including delivery dedup and event ordering.

import { describe, expect, it } from "vitest";
import { createMemoryRedis } from "./memory-redis";
import { isEntitled, readEntitlement } from "./gate";
import {
  ACTIVATION_CODE_RE,
  applyStripeEvent,
  consumeActivationCode,
  deactivateDevice,
  isDeviceRegistered,
  isValidDeviceId,
  lookupRefreshToken,
  MAX_DEVICES,
  mintActivationCode,
  mintRefreshToken,
  redeemActivationCode,
  registerDevice,
  storeActivation,
  storeActivationBySession,
  takeActivationCodeForSession,
  wasActivationCollected,
  wasActivationFiled,
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

  it("hands the session-filed code only to the pickup-nonce holder", async () => {
    const { run } = world();
    const NONCE = "pickupnonce0123456789";
    await storeActivationBySession(run, "cs_test_123", NONCE, "CAPTURIA-AAAA-BBBB-CCCC-DDDD");
    // A wrong or missing nonce is a plain miss AND must not destroy the
    // record: the session id alone (visible in a forwarded checkout URL) is
    // not enough to steal the payer's code.
    expect(await takeActivationCodeForSession(run, "cs_test_123", "wrongnonce0123456789")).toBeNull();
    expect(await takeActivationCodeForSession(run, "cs_test_123", undefined)).toBeNull();
    expect(await takeActivationCodeForSession(run, "cs_test_123", NONCE)).toBe(
      "CAPTURIA-AAAA-BBBB-CCCC-DDDD"
    );
    expect(await takeActivationCodeForSession(run, "cs_/../weird", NONCE)).toBeNull();
  });

  it("re-serves a collected code within the grace window, then never again", async () => {
    const { run, clock } = world();
    const NONCE = "pickupnonce0123456789";
    await storeActivationBySession(run, "cs_test_123", NONCE, "CAPTURIA-AAAA-BBBB-CCCC-DDDD");
    expect(await takeActivationCodeForSession(run, "cs_test_123", NONCE)).toBe(
      "CAPTURIA-AAAA-BBBB-CCCC-DDDD"
    );
    // A response lost in flight is recoverable: the same pair re-collects
    // for a few minutes...
    clock.tick(60 * 1000);
    expect(await takeActivationCodeForSession(run, "cs_test_123", NONCE)).toBe(
      "CAPTURIA-AAAA-BBBB-CCCC-DDDD"
    );
    // ...but the wrong nonce still gets nothing, even during grace.
    expect(await takeActivationCodeForSession(run, "cs_test_123", "wrongnonce0123456789")).toBeNull();
    // Once the grace lapses the pickup is gone for good, and the collected
    // marker says why.
    clock.tick(6 * 60 * 1000);
    expect(await takeActivationCodeForSession(run, "cs_test_123", NONCE)).toBeNull();
    expect(await wasActivationCollected(run, "cs_test_123", NONCE)).toBe(true);
  });

  it("keeps filed/collected markers nonce-bound so the session id alone reveals nothing", async () => {
    const { run, clock } = world();
    const NONCE = "pickupnonce0123456789";
    const WRONG = "wrongnonce0123456789";
    // Nothing filed yet: every probe reads false.
    expect(await wasActivationFiled(run, "cs_test_123", NONCE)).toBe(false);
    await storeActivationBySession(run, "cs_test_123", NONCE, "CAPTURIA-AAAA-BBBB-CCCC-DDDD");
    // Filed is only visible to the exact session+nonce pair.
    expect(await wasActivationFiled(run, "cs_test_123", NONCE)).toBe(true);
    expect(await wasActivationFiled(run, "cs_test_123", WRONG)).toBe(false);
    expect(await wasActivationFiled(run, "cs_test_123", undefined)).toBe(false);
    expect(await wasActivationCollected(run, "cs_test_123", NONCE)).toBe(false);
    await takeActivationCodeForSession(run, "cs_test_123", NONCE);
    expect(await wasActivationCollected(run, "cs_test_123", NONCE)).toBe(true);
    expect(await wasActivationCollected(run, "cs_test_123", WRONG)).toBe(false);
    // The markers outlive the record (they answer "expired", not "pending")
    // and then expire themselves.
    clock.tick(61 * 24 * 60 * 60 * 1000);
    expect(await wasActivationFiled(run, "cs_test_123", NONCE)).toBe(false);
    expect(await wasActivationCollected(run, "cs_test_123", NONCE)).toBe(false);
  });

  it("marks an expired-but-never-collected pickup as filed, not collected", async () => {
    const { run, clock } = world();
    const NONCE = "pickupnonce0123456789";
    await storeActivationBySession(run, "cs_test_123", NONCE, "CAPTURIA-AAAA-BBBB-CCCC-DDDD");
    clock.tick(31 * 24 * 60 * 60 * 1000); // past the 30-day record TTL
    expect(await takeActivationCodeForSession(run, "cs_test_123", NONCE)).toBeNull();
    expect(await wasActivationFiled(run, "cs_test_123", NONCE)).toBe(true);
    expect(await wasActivationCollected(run, "cs_test_123", NONCE)).toBe(false);
  });

  it("still consumes codes stored under the legacy plaintext key", async () => {
    const { run } = world();
    const code = mintActivationCode();
    // A record written by a deploy that predates hashed activation keys.
    await run(["SET", `hosted:act:${code}`, JSON.stringify({ customer: CUSTOMER, subscription: null })]);
    expect(await consumeActivationCode(run, code)).toMatchObject({ customer: CUSTOMER });
    expect(await consumeActivationCode(run, code)).toBeNull();
  });
});

describe("redeemActivationCode (the full activation decision)", () => {
  const DEVICE = "device-redeem-1";

  async function seeded() {
    const w = world();
    const code = mintActivationCode();
    await storeActivation(w.run, code, { customer: CUSTOMER, subscription: "sub_1" });
    return { ...w, code };
  }

  it("succeeds for an entitled customer and consumes the code for good", async () => {
    const { run, code } = await seeded();
    await writeEntitlement(run, CUSTOMER, "active", "sub_1", T0);
    const res = await redeemActivationCode(run, code, DEVICE);
    expect(res).toEqual({ ok: true, customer: CUSTOMER, plan: "pro", devices: 1 });
    expect(await isDeviceRegistered(run, CUSTOMER, DEVICE)).toBe(true);
    // Success never re-stores: the code is spent.
    expect(await redeemActivationCode(run, code, DEVICE)).toMatchObject({ ok: false, status: 404 });
  });

  it("404s unknown codes without leaking whether they ever existed", async () => {
    const { run } = world();
    expect(await redeemActivationCode(run, mintActivationCode(), DEVICE)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("puts the code back on a lapsed subscription so the buyer can retry", async () => {
    const { run, code } = await seeded();
    await writeEntitlement(run, CUSTOMER, "canceled", "sub_1", T0);
    expect(await redeemActivationCode(run, code, DEVICE)).toMatchObject({ ok: false, status: 402 });
    // Fix the subscription, retry the SAME code: it must still work.
    await writeEntitlement(run, CUSTOMER, "active", "sub_1", T0);
    expect(await redeemActivationCode(run, code, DEVICE)).toMatchObject({ ok: true });
  });

  it("puts the code back on the device limit so freeing a seat unblocks it", async () => {
    const { run, code } = await seeded();
    await writeEntitlement(run, CUSTOMER, "active", "sub_1", T0);
    for (let i = 1; i <= MAX_DEVICES; i++) await registerDevice(run, CUSTOMER, `device-${i}`);
    const refused = await redeemActivationCode(run, code, "device-4th-seat");
    expect(refused).toMatchObject({ ok: false, status: 403 });
    // The refusal must tell the buyer the way out: self-serve deactivation
    // lives in Settings on the old device.
    if (!refused.ok) expect(refused.error).toMatch(/Settings.*[Dd]eactivate/);
    // An already-registered device redeeming the same code still succeeds.
    expect(await redeemActivationCode(run, code, "device-2")).toMatchObject({ ok: true });
  });

  it("lets the refused 4th device redeem once a seat is freed the self-serve way", async () => {
    const { run, code } = await seeded();
    await writeEntitlement(run, CUSTOMER, "active", "sub_1", T0);
    for (let i = 1; i <= MAX_DEVICES; i++) await registerDevice(run, CUSTOMER, `device-${i}`);
    expect(await redeemActivationCode(run, code, "device-4th-seat")).toMatchObject({
      ok: false,
      status: 403,
    });
    await deactivateDevice(run, CUSTOMER, "device-1");
    // The refusal put the code back, so the SAME code now redeems.
    expect(await redeemActivationCode(run, code, "device-4th-seat")).toMatchObject({
      ok: true,
      devices: MAX_DEVICES,
    });
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
    // The refused device must not linger in the set (add-then-rollback).
    expect(await isDeviceRegistered(run, CUSTOMER, "device-4")).toBe(false);
    // Re-registering an existing device is not a new seat.
    expect(await registerDevice(run, CUSTOMER, "device-2")).toEqual({ ok: true, devices: 3 });
    expect(await isDeviceRegistered(run, CUSTOMER, "device-2")).toBe(true);
  });

  it("deactivation frees a seat and reports what remains", async () => {
    const { run } = world();
    for (let i = 1; i <= MAX_DEVICES; i++) await registerDevice(run, CUSTOMER, `device-${i}`);
    expect(await deactivateDevice(run, CUSTOMER, "device-2")).toEqual({ removed: true, devices: 2 });
    expect(await isDeviceRegistered(run, CUSTOMER, "device-2")).toBe(false);
    // The other seats are untouched, and the freed one is reusable.
    expect(await isDeviceRegistered(run, CUSTOMER, "device-1")).toBe(true);
    expect(await registerDevice(run, CUSTOMER, "device-4")).toEqual({ ok: true, devices: 3 });
  });

  it("deactivation is idempotent: absent devices and empty sets are calm no-ops", async () => {
    const { run } = world();
    await registerDevice(run, CUSTOMER, "device-1");
    expect(await deactivateDevice(run, CUSTOMER, "device-1")).toEqual({ removed: true, devices: 0 });
    // A retry (lost response, double click) reports the same free state.
    expect(await deactivateDevice(run, CUSTOMER, "device-1")).toEqual({ removed: false, devices: 0 });
    // A device that was never registered cannot corrupt anyone's seats.
    expect(await deactivateDevice(run, CUSTOMER, "device-never")).toEqual({
      removed: false,
      devices: 0,
    });
  });

  it("self-corrects an over-cap set instead of letting racers keep extra seats", async () => {
    const { run } = world();
    // Simulate the worst race outcome: two concurrent activations both got
    // their SADD in past the cap before either could check.
    for (let i = 1; i <= MAX_DEVICES + 1; i++) await run(["SADD", `hosted:devices:${CUSTOMER}`, `device-${i}`]);
    // A NEW device is refused and rolled back while the set is over cap.
    expect(await registerDevice(run, CUSTOMER, "device-9")).toEqual({
      ok: false,
      error: "device_limit",
    });
    expect(await isDeviceRegistered(run, CUSTOMER, "device-9")).toBe(false);
    // An EXISTING member stays registered (token refresh must keep working).
    expect(await registerDevice(run, CUSTOMER, "device-1")).toMatchObject({ ok: true });
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
  const PICKUP = "pickupnonce0123456789";
  const checkoutEvent = (over: Record<string, unknown> = {}, event: Record<string, unknown> = {}) => ({
    type: "checkout.session.completed",
    ...event,
    data: {
      object: {
        id: "cs_test_abc",
        customer: CUSTOMER,
        subscription: "sub_9",
        mode: "subscription",
        payment_status: "paid",
        metadata: { pickup: PICKUP },
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
    expect(await takeActivationCodeForSession(run, "cs_test_abc", PICKUP)).toBe(codes[0]);
  });

  it("files the pickup pair on completed checkout so the endpoint can tell lag from loss", async () => {
    const { run } = world();
    expect(await wasActivationFiled(run, "cs_test_abc", PICKUP)).toBe(false);
    await applyStripeEvent(run, checkoutEvent(), T0);
    expect(await wasActivationFiled(run, "cs_test_abc", PICKUP)).toBe(true);
    expect(await wasActivationCollected(run, "cs_test_abc", PICKUP)).toBe(false);
    // Collecting flips the marker a refreshed success page keys its
    // "already collected" answer on.
    await takeActivationCodeForSession(run, "cs_test_abc", PICKUP);
    expect(await wasActivationCollected(run, "cs_test_abc", PICKUP)).toBe(true);
  });

  it("ignores unpaid or non-subscription checkouts", async () => {
    const { run } = world();
    expect((await applyStripeEvent(run, checkoutEvent({ payment_status: "unpaid" }), T0)).handled).toBe(false);
    expect((await applyStripeEvent(run, checkoutEvent({ mode: "payment" }), T0)).handled).toBe(false);
    expect(await readEntitlement(run, CUSTOMER)).toBeNull();
  });

  it("mints on async_payment_succeeded and still refuses its unpaid sibling", async () => {
    const { run } = world();
    const codes: string[] = [];
    const mint = () => {
      const code = mintActivationCode();
      codes.push(code);
      return code;
    };
    // Async flows: completed arrives unpaid first, the paid signal later.
    const unpaidCompleted = checkoutEvent({ payment_status: "unpaid" }, { id: "evt_1" });
    expect((await applyStripeEvent(run, unpaidCompleted, T0, mint)).handled).toBe(false);
    const paidAsync = checkoutEvent({}, {
      id: "evt_2",
      type: "checkout.session.async_payment_succeeded",
    });
    const outcome = await applyStripeEvent(run, paidAsync, T0, mint);
    expect(outcome).toEqual({ handled: true, action: "activation_minted", customer: CUSTOMER });
    expect(codes).toHaveLength(1);
  });

  it("deduplicates redelivered events by event id: one delivery, one code", async () => {
    const { run } = world();
    const codes: string[] = [];
    const mint = () => {
      const code = mintActivationCode();
      codes.push(code);
      return code;
    };
    const event = checkoutEvent({}, { id: "evt_replay_1" });
    expect((await applyStripeEvent(run, event, T0, mint)).action).toBe("activation_minted");
    // Stripe retries carry the SAME event id (re-signed, same payload).
    expect((await applyStripeEvent(run, event, T0, mint)).action).toBe("duplicate_ignored");
    expect(codes).toHaveLength(1);
    expect(await consumeActivationCode(run, codes[0])).toMatchObject({ customer: CUSTOMER });
    expect(await consumeActivationCode(run, codes[0])).toBeNull();
  });

  it("mints at most one code per checkout session across DISTINCT event ids", async () => {
    const { run } = world();
    const codes: string[] = [];
    const mint = () => {
      const code = mintActivationCode();
      codes.push(code);
      return code;
    };
    expect((await applyStripeEvent(run, checkoutEvent({}, { id: "evt_a" }), T0, mint)).action).toBe(
      "activation_minted"
    );
    expect((await applyStripeEvent(run, checkoutEvent({}, { id: "evt_b" }), T0, mint)).action).toBe(
      "duplicate_ignored"
    );
    expect(codes).toHaveLength(1);
  });

  it("subscription.updated follows Stripe's status; revoking states fail closed, limbo states are no-ops", async () => {
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
    // "incomplete" never granted anything and resolves on its own; writing
    // "canceled" for it could only clobber a healthy record.
    await applyStripeEvent(run, sub("active"), T0);
    const limbo = await applyStripeEvent(run, sub("incomplete"), T0);
    expect(limbo).toEqual({ handled: true, action: "status_ignored", customer: CUSTOMER });
    expect((await readEntitlement(run, CUSTOMER))?.status).toBe("active");
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

  it("ignores an out-of-order older event instead of resurrecting a canceled customer", async () => {
    const { run } = world();
    const CREATED_T1 = Math.floor(T0 / 1000);
    const CREATED_T2 = CREATED_T1 + 60;
    const sub = (type: string, status: string, created: number) => ({
      type,
      created,
      data: { object: { id: "sub_9", customer: CUSTOMER, status } },
    });
    // The cancellation lands first (delivery order is not guaranteed) ...
    await applyStripeEvent(run, sub("customer.subscription.deleted", "canceled", CREATED_T2), T0);
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
    // ... then the OLDER "active" update arrives late: it must not win.
    const stale = await applyStripeEvent(
      run,
      sub("customer.subscription.updated", "active", CREATED_T1),
      T0
    );
    expect(stale).toEqual({ handled: true, action: "stale_ignored", customer: CUSTOMER });
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
    // A genuinely NEWER event still flows through.
    await applyStripeEvent(
      run,
      sub("customer.subscription.updated", "active", CREATED_T2 + 60),
      T0
    );
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(true);
  });

  it("acks unknown event types untouched", async () => {
    const { run } = world();
    const outcome = await applyStripeEvent(run, { type: "invoice.paid", data: { object: {} } }, T0);
    expect(outcome).toEqual({ handled: false });
  });

  it("a Redis fault mid-apply does NOT poison the dedup: the Stripe retry still mints", async () => {
    const { run } = world();
    // Fail the first write of the activation code (a transient Upstash blip
    // right after the entitlement write), then heal.
    let failNextActStore = true;
    const flaky: typeof run = async (command) => {
      if (failNextActStore && command[0] === "SET" && String(command[1]).startsWith("hosted:act:")) {
        failNextActStore = false;
        throw new Error("upstash blip");
      }
      return run(command);
    };
    const codes: string[] = [];
    const mint = () => {
      const code = mintActivationCode();
      codes.push(code);
      return code;
    };
    const event = checkoutEvent({}, { id: "evt_flaky" });
    await expect(applyStripeEvent(flaky, event, T0, mint)).rejects.toThrow("upstash blip");
    // The retry (same event id, as Stripe sends it) must re-process, not be
    // swallowed as duplicate_ignored: the markers are written only after the
    // effects land.
    const retry = await applyStripeEvent(flaky, event, T0, mint);
    expect(retry).toEqual({ handled: true, action: "activation_minted", customer: CUSTOMER });
    const redeemable = codes[codes.length - 1];
    expect(await consumeActivationCode(run, redeemable)).toMatchObject({ customer: CUSTOMER });
  });

  it("same-second conflicting events converge on canceled in EITHER delivery order", async () => {
    const CREATED = Math.floor(T0 / 1000);
    const active = {
      type: "customer.subscription.updated",
      created: CREATED,
      data: { object: { id: "sub_9", customer: CUSTOMER, status: "active" } },
    };
    const deleted = {
      type: "customer.subscription.deleted",
      created: CREATED,
      data: { object: { id: "sub_9", customer: CUSTOMER } },
    };
    // Order 1: active then deleted -> revocation ties-win.
    const w1 = world();
    await applyStripeEvent(w1.run, active, T0);
    await applyStripeEvent(w1.run, deleted, T0);
    expect(isEntitled(await readEntitlement(w1.run, CUSTOMER))).toBe(false);
    // Order 2: deleted then active -> a tied grant never resurrects.
    const w2 = world();
    await applyStripeEvent(w2.run, deleted, T0);
    const stale = await applyStripeEvent(w2.run, active, T0);
    expect(stale).toEqual({ handled: true, action: "stale_ignored", customer: CUSTOMER });
    expect(isEntitled(await readEntitlement(w2.run, CUSTOMER))).toBe(false);
  });

  it("a late checkout event cannot resurrect a newer cancellation, but its code still mints", async () => {
    const { run } = world();
    const CREATED = Math.floor(T0 / 1000);
    await applyStripeEvent(
      run,
      {
        type: "customer.subscription.deleted",
        created: CREATED + 120,
        data: { object: { id: "sub_9", customer: CUSTOMER } },
      },
      T0
    );
    const codes: string[] = [];
    const late = checkoutEvent({}, { id: "evt_late_checkout", created: CREATED });
    const outcome = await applyStripeEvent(run, late, T0, () => {
      const code = mintActivationCode();
      codes.push(code);
      return code;
    });
    // The code exists (the buyer paid) but redeeming it hits the entitlement
    // check, and the cache still says canceled.
    expect(outcome).toEqual({ handled: true, action: "activation_minted", customer: CUSTOMER });
    expect(isEntitled(await readEntitlement(run, CUSTOMER))).toBe(false);
    expect(await redeemActivationCode(run, codes[0], "device-late-1")).toMatchObject({
      ok: false,
      status: 402,
    });
  });
});
