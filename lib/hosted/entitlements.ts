// Entitlement lifecycle for the hosted tier (M11, issue #10): Stripe is the
// customer source of truth, Redis holds the runtime cache, and there are no
// user accounts. The chain is:
//
//   Stripe Checkout completes -> webhook mints a one-time activation code
//   bound to the Stripe customer -> the desktop app trades the code for a
//   long-lived refresh token (device registered, max 3) -> the refresh token
//   is traded for short-lived Ed25519 JWTs (lib/hosted/jwt.ts) that the LLM
//   proxy verifies statelessly.
//
// Everything takes the injected RedisRunner so unit tests drive the exact
// production logic against lib/hosted/memory-redis.ts. Refresh tokens are
// stored ONLY as SHA-256 hashes; the plaintext exists once, in the activate
// response. Nothing in this module logs codes or tokens.

import { createHash, randomBytes } from "node:crypto";
import type { RedisRunner } from "../upstash";
import {
  entitlementKey,
  isEntitled,
  readEntitlement,
  type Entitlement,
  type EntitlementStatus,
} from "./gate";

const ACTIVATION_TTL_S = 30 * 24 * 60 * 60; // unredeemed purchases surface via Stripe anyway
const SESSION_TTL_S = ACTIVATION_TTL_S;
const REFRESH_TTL_S = 400 * 24 * 60 * 60; // "long-lived": beyond a yearly cycle
export const MAX_DEVICES = 3;

// Crockford base32 without lookalikes; 16 chars = 80 random bits, far beyond
// online-guessing reach even without endpoint rate limits.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ACTIVATION_CODE_RE = /^CAPTURIA(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
const REFRESH_PREFIX = "crt_";

function activationKey(code: string): string {
  return `hosted:act:${code}`;
}

function devicesKey(customer: string): string {
  return `hosted:devices:${customer}`;
}

function refreshKey(token: string): string {
  return `hosted:refresh:${createHash("sha256").update(token).digest("hex")}`;
}

export function mintActivationCode(rand: (n: number) => Buffer = randomBytes): string {
  const bytes = rand(16);
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let i = 0; i < 4; i++) {
      group += CODE_ALPHABET[bytes[g * 4 + i] % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return `CAPTURIA-${groups.join("-")}`;
}

export function isValidDeviceId(deviceId: unknown): deviceId is string {
  return typeof deviceId === "string" && DEVICE_ID_RE.test(deviceId);
}

export async function writeEntitlement(
  run: RedisRunner,
  customer: string,
  status: EntitlementStatus,
  subscription: string | null,
  nowMs: number,
  eventAtMs?: number
): Promise<Entitlement> {
  const ent: Entitlement = { status, plan: "pro", subscription, updatedAt: nowMs };
  if (eventAtMs !== undefined) ent.eventAt = eventAtMs;
  await run(["SET", entitlementKey(customer), JSON.stringify(ent)]);
  return ent;
}

export interface ActivationRecord {
  customer: string;
  subscription: string | null;
}

export async function storeActivation(
  run: RedisRunner,
  code: string,
  record: ActivationRecord
): Promise<void> {
  await run(["SET", activationKey(code), JSON.stringify(record), "EX", ACTIVATION_TTL_S]);
}

// One-time: GETDEL means a replayed code is gone even if two activations
// race, and an attacker who somehow observes a redeemed code gets nothing.
export async function consumeActivationCode(
  run: RedisRunner,
  code: unknown
): Promise<ActivationRecord | null> {
  if (typeof code !== "string" || !ACTIVATION_CODE_RE.test(code)) return null;
  const raw = await run(["GETDEL", activationKey(code)]);
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as ActivationRecord;
    return typeof parsed?.customer === "string" && parsed.customer ? parsed : null;
  } catch {
    return null;
  }
}

// Checkout success pages only know their session id plus the pickup nonce
// the checkout endpoint embedded in their success URL, so the webhook files
// the code under a hash of BOTH for one one-time pickup. Binding the pickup
// to the nonce means a third party who initiated the checkout and only
// learned the session id (it is visible in the checkout URL they forwarded)
// still cannot poll the code out from under the payer; and hashing keeps the
// raw session id out of the keyspace.
export const PICKUP_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function pickupKey(sessionId: string, pickupNonce: string): string {
  const digest = createHash("sha256").update(`${sessionId}:${pickupNonce}`).digest("hex");
  return `hosted:pickup:${digest}`;
}

export async function storeActivationBySession(
  run: RedisRunner,
  sessionId: string,
  pickupNonce: string,
  code: string
): Promise<void> {
  await run(["SET", pickupKey(sessionId, pickupNonce), code, "EX", SESSION_TTL_S]);
}

// GETDEL on the hashed key: a wrong nonce is a plain miss, so probing can
// never destroy the real record, and the first correct pickup wins exactly
// once.
export async function takeActivationCodeForSession(
  run: RedisRunner,
  sessionId: unknown,
  pickupNonce: unknown
): Promise<string | null> {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return null;
  if (typeof pickupNonce !== "string" || !PICKUP_NONCE_RE.test(pickupNonce)) return null;
  const raw = await run(["GETDEL", pickupKey(sessionId, pickupNonce)]);
  return typeof raw === "string" ? raw : null;
}

export type DeviceRegistration =
  | { ok: true; devices: number }
  | { ok: false; error: "device_limit" };

// Idempotent per device id; refuses the 4th distinct device. (The proposal's
// auto-deactivate-oldest UX belongs to the desktop entitlement slice; the
// hard cap is what protects the metered backend today.) Add-first then
// self-correct: two racing activations can both SADD past the cap for a
// moment, but each rolls back its own overflow, so the set converges to at
// most MAX_DEVICES under any interleaving without needing Lua.
export async function registerDevice(
  run: RedisRunner,
  customer: string,
  deviceId: string
): Promise<DeviceRegistration> {
  const key = devicesKey(customer);
  const added = Number(await run(["SADD", key, deviceId])) === 1;
  const count = Number(await run(["SCARD", key])) || 1;
  if (added && count > MAX_DEVICES) {
    await run(["SREM", key, deviceId]);
    return { ok: false, error: "device_limit" };
  }
  return { ok: true, devices: Math.min(count, MAX_DEVICES) };
}

export type ActivationRedemption =
  | { ok: true; customer: string; plan: string; devices: number }
  | { ok: false; status: 402 | 403 | 404; error: string };

// The full code-redemption decision: consume the one-time code, then check
// entitlement and the device cap. The consuming GETDEL still guarantees
// exactly one concurrent winner, but a winner who fails a RECOVERABLE check
// (subscription lapsed, device limit) puts the record back before returning,
// so the customer can retry after fixing the condition instead of being
// permanently locked out of a code they paid for. Success never re-stores,
// so double redemption stays impossible.
export async function redeemActivationCode(
  run: RedisRunner,
  code: unknown,
  deviceId: string
): Promise<ActivationRedemption> {
  const activation = await consumeActivationCode(run, code);
  if (!activation) {
    // Unknown, malformed, expired, and already-used all read the same:
    // nothing here confirms whether a guessed code ever existed.
    return { ok: false, status: 404, error: "Invalid or already used activation code." };
  }

  const entitlement = await readEntitlement(run, activation.customer);
  if (!isEntitled(entitlement)) {
    await storeActivation(run, code as string, activation);
    return { ok: false, status: 402, error: "No active subscription for this activation code." };
  }

  const device = await registerDevice(run, activation.customer, deviceId);
  if (!device.ok) {
    await storeActivation(run, code as string, activation);
    return {
      ok: false,
      status: 403,
      error: "Device limit reached (3). Deactivate another device first.",
    };
  }

  return {
    ok: true,
    customer: activation.customer,
    plan: entitlement?.plan ?? "pro",
    devices: device.devices,
  };
}

export async function isDeviceRegistered(
  run: RedisRunner,
  customer: string,
  deviceId: string
): Promise<boolean> {
  return Number(await run(["SISMEMBER", devicesKey(customer), deviceId])) === 1;
}

export interface RefreshRecord {
  customer: string;
  deviceId: string;
  createdAt: number;
}

export async function mintRefreshToken(
  run: RedisRunner,
  customer: string,
  deviceId: string,
  nowMs: number,
  rand: (n: number) => Buffer = randomBytes
): Promise<string> {
  const token = REFRESH_PREFIX + rand(32).toString("base64url");
  const record: RefreshRecord = { customer, deviceId, createdAt: nowMs };
  await run(["SET", refreshKey(token), JSON.stringify(record), "EX", REFRESH_TTL_S]);
  return token;
}

// Hash lookup: constant-shape work regardless of what was submitted, and the
// store never contains anything a dump could replay as a credential.
export async function lookupRefreshToken(
  run: RedisRunner,
  token: unknown
): Promise<RefreshRecord | null> {
  if (typeof token !== "string" || !token.startsWith(REFRESH_PREFIX) || token.length > 256) {
    return null;
  }
  const raw = await run(["GET", refreshKey(token)]);
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as RefreshRecord;
    return typeof parsed?.customer === "string" && parsed.customer ? parsed : null;
  } catch {
    return null;
  }
}

// --- Stripe webhook -> entitlement cache -------------------------------

// Subscription statuses that keep the hosted tier on; see isEntitled in
// gate.ts for why past_due stays on.
const STATUS_MAP: Record<string, EntitlementStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
};

// Statuses that positively end access. "incomplete" is deliberately absent
// from both maps: an incomplete subscription never granted anything and
// resolves to active or incomplete_expired on its own, so writing "canceled"
// for it could only clobber a healthy record from another subscription.
const REVOKED_STATUSES = new Set(["canceled", "unpaid", "paused", "incomplete_expired"]);

interface StripeEventLike {
  id?: unknown;
  type?: unknown;
  /** Stripe event creation time, unix SECONDS. */
  created?: unknown;
  data?: { object?: Record<string, unknown> };
}

export interface WebhookOutcome {
  handled: boolean;
  action?:
    | "activation_minted"
    | "entitlement_updated"
    | "entitlement_revoked"
    | "duplicate_ignored"
    | "stale_ignored"
    | "status_ignored";
  customer?: string;
}

const EVENT_DEDUP_TTL_S = 3 * 24 * 60 * 60; // covers Stripe's 3-day retry schedule

function eventDedupKey(eventId: string): string {
  return `hosted:evt:${eventId}`;
}

function mintMarkerKey(sessionId: string): string {
  return `hosted:act-minted:${sessionId}`;
}

// Skip a subscription-state write when the stored record came from a NEWER
// Stripe event: delivery order is explicitly not guaranteed, and without the
// watermark a delayed "active" could resurrect a canceled customer (or a
// delayed "canceled" lock out a paying one) until the next event, which for
// a resurrected cancellation never comes. event.created has SECOND
// granularity, so same-second ties are decided fail-closed: a revocation
// ties-wins, a grant must be strictly newer; either delivery order of a
// same-second active+canceled pair converges on canceled. The read-then-
// write pair is not atomic (this module deliberately avoids Lua for
// memory-mode parity); the remaining window is one Redis round trip on
// truly concurrent deliveries, Stripe stays the source of truth, and the
// token refresh re-consults Stripe-driven state within one JWT lifetime.
async function isStaleEvent(
  run: RedisRunner,
  customer: string,
  eventAtMs: number | null,
  revoking: boolean
): Promise<boolean> {
  if (eventAtMs === null) return false;
  const current = await readEntitlement(run, customer);
  if (typeof current?.eventAt !== "number") return false;
  return revoking ? current.eventAt > eventAtMs : current.eventAt >= eventAtMs;
}

// Applies one verified Stripe event to the Redis cache. Returns a description
// safe to log (ids only, never codes or tokens). Unknown event types are
// acknowledged untouched so the webhook endpoint can subscribe broadly.
// Deliveries are deduplicated on event.id (Stripe retries re-sign the same
// event) and ordered by event.created (Stripe does not guarantee order).
//
// MARKER ORDER MATTERS: both dedup markers are read-checked up front but
// WRITTEN only after the event's effects have all landed. A crash or Redis
// fault mid-apply therefore leaves no marker, the delivery fails non-2xx,
// and the Stripe retry re-processes the event instead of being swallowed as
// a duplicate; a paid activation can never be lost to a transient fault.
// Re-processing is safe because entitlement writes are idempotent under the
// watermark and the worst concurrent-duplicate outcome is one extra
// activation code for the SAME customer (benign) rather than a lost one.
export async function applyStripeEvent(
  run: RedisRunner,
  event: StripeEventLike,
  nowMs: number,
  mintCode: () => string = mintActivationCode
): Promise<WebhookOutcome> {
  const type = typeof event?.type === "string" ? event.type : "";
  const object = event?.data?.object ?? {};
  const customer = typeof object.customer === "string" ? object.customer : null;
  const eventAtMs =
    typeof event?.created === "number" && Number.isFinite(event.created)
      ? Math.floor(event.created * 1000)
      : null;

  const eventId = typeof event?.id === "string" && event.id ? event.id : null;
  if (eventId && (await run(["GET", eventDedupKey(eventId)])) !== null) {
    return { handled: true, action: "duplicate_ignored" };
  }
  const markProcessed = async () => {
    if (eventId) await run(["SET", eventDedupKey(eventId), "1", "EX", EVENT_DEDUP_TTL_S]);
  };

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    const paid = object.payment_status === "paid" || object.payment_status === "no_payment_required";
    if (!customer || object.mode !== "subscription" || !paid) return { handled: false };
    const sessionId = typeof object.id === "string" && object.id.startsWith("cs_") ? object.id : null;
    // One activation code per checkout session, even if Stripe delivers the
    // paid state through several distinct events (completed + async variants
    // carry different event ids, so the event dedup alone would not stop a
    // second mint).
    if (sessionId && (await run(["GET", mintMarkerKey(sessionId)])) !== null) {
      await markProcessed();
      return { handled: true, action: "duplicate_ignored", customer };
    }
    const subscription = typeof object.subscription === "string" ? object.subscription : null;
    if (!(await isStaleEvent(run, customer, eventAtMs, false))) {
      await writeEntitlement(run, customer, "active", subscription, nowMs, eventAtMs ?? undefined);
    }
    const code = mintCode();
    await storeActivation(run, code, { customer, subscription });
    const metadata = object.metadata as Record<string, unknown> | undefined;
    const pickup = typeof metadata?.pickup === "string" ? metadata.pickup : null;
    if (sessionId && pickup && PICKUP_NONCE_RE.test(pickup)) {
      await storeActivationBySession(run, sessionId, pickup, code);
    }
    if (sessionId) {
      await run(["SET", mintMarkerKey(sessionId), "1", "EX", ACTIVATION_TTL_S]);
    }
    await markProcessed();
    return { handled: true, action: "activation_minted", customer };
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.created") {
    if (!customer) return { handled: false };
    const raw = typeof object.status === "string" ? object.status : "";
    const status = Object.hasOwn(STATUS_MAP, raw)
      ? STATUS_MAP[raw]
      : REVOKED_STATUSES.has(raw)
        ? "canceled"
        : null;
    if (status === null) {
      await markProcessed();
      return { handled: true, action: "status_ignored", customer };
    }
    if (await isStaleEvent(run, customer, eventAtMs, status === "canceled")) {
      await markProcessed();
      return { handled: true, action: "stale_ignored", customer };
    }
    const subscription = typeof object.id === "string" ? object.id : null;
    await writeEntitlement(run, customer, status, subscription, nowMs, eventAtMs ?? undefined);
    await markProcessed();
    return {
      handled: true,
      action: status === "canceled" ? "entitlement_revoked" : "entitlement_updated",
      customer,
    };
  }

  if (type === "customer.subscription.deleted") {
    if (!customer) return { handled: false };
    if (await isStaleEvent(run, customer, eventAtMs, true)) {
      await markProcessed();
      return { handled: true, action: "stale_ignored", customer };
    }
    const subscription = typeof object.id === "string" ? object.id : null;
    await writeEntitlement(run, customer, "canceled", subscription, nowMs, eventAtMs ?? undefined);
    await markProcessed();
    return { handled: true, action: "entitlement_revoked", customer };
  }

  return { handled: false };
}
