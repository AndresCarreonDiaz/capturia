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
import { entitlementKey, type Entitlement, type EntitlementStatus } from "./gate";

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

function sessionKey(sessionId: string): string {
  return `hosted:session:${sessionId}`;
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
  nowMs: number
): Promise<Entitlement> {
  const ent: Entitlement = { status, plan: "pro", subscription, updatedAt: nowMs };
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

// Checkout success pages only know their session id, so the webhook also
// files the code under the session for one one-time pickup. Session ids are
// unguessable and known only to the buyer's browser and Stripe.
export async function storeActivationBySession(
  run: RedisRunner,
  sessionId: string,
  code: string
): Promise<void> {
  await run(["SET", sessionKey(sessionId), code, "EX", SESSION_TTL_S]);
}

export async function takeActivationCodeForSession(
  run: RedisRunner,
  sessionId: unknown
): Promise<string | null> {
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) return null;
  const raw = await run(["GETDEL", sessionKey(sessionId)]);
  return typeof raw === "string" ? raw : null;
}

export type DeviceRegistration =
  | { ok: true; devices: number }
  | { ok: false; error: "device_limit" };

// Idempotent per device id; refuses the 4th distinct device. (The proposal's
// auto-deactivate-oldest UX belongs to the desktop entitlement slice; the
// hard cap is what protects the metered backend today.)
export async function registerDevice(
  run: RedisRunner,
  customer: string,
  deviceId: string
): Promise<DeviceRegistration> {
  const key = devicesKey(customer);
  const already = Number(await run(["SISMEMBER", key, deviceId])) === 1;
  if (!already) {
    const count = Number(await run(["SCARD", key])) || 0;
    if (count >= MAX_DEVICES) return { ok: false, error: "device_limit" };
    await run(["SADD", key, deviceId]);
  }
  return { ok: true, devices: Number(await run(["SCARD", key])) || 1 };
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

// Subscription statuses that keep the hosted tier on. incomplete/unpaid/
// canceled/incomplete_expired/paused all read as "not entitled"; see
// isEntitled in gate.ts for why past_due stays on.
const STATUS_MAP: Record<string, EntitlementStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
};

interface StripeEventLike {
  type?: unknown;
  data?: { object?: Record<string, unknown> };
}

export interface WebhookOutcome {
  handled: boolean;
  action?: "activation_minted" | "entitlement_updated" | "entitlement_revoked";
  customer?: string;
}

// Applies one verified Stripe event to the Redis cache. Returns a description
// safe to log (ids only, never codes or tokens). Unknown event types are
// acknowledged untouched so the webhook endpoint can subscribe broadly.
export async function applyStripeEvent(
  run: RedisRunner,
  event: StripeEventLike,
  nowMs: number,
  mintCode: () => string = mintActivationCode
): Promise<WebhookOutcome> {
  const type = typeof event?.type === "string" ? event.type : "";
  const object = event?.data?.object ?? {};
  const customer = typeof object.customer === "string" ? object.customer : null;

  if (type === "checkout.session.completed") {
    const paid = object.payment_status === "paid" || object.payment_status === "no_payment_required";
    if (!customer || object.mode !== "subscription" || !paid) return { handled: false };
    const subscription = typeof object.subscription === "string" ? object.subscription : null;
    await writeEntitlement(run, customer, "active", subscription, nowMs);
    const code = mintCode();
    await storeActivation(run, code, { customer, subscription });
    if (typeof object.id === "string" && object.id.startsWith("cs_")) {
      await storeActivationBySession(run, object.id, code);
    }
    return { handled: true, action: "activation_minted", customer };
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.created") {
    if (!customer) return { handled: false };
    const raw = typeof object.status === "string" ? object.status : "";
    const status = Object.hasOwn(STATUS_MAP, raw) ? STATUS_MAP[raw] : "canceled";
    const subscription = typeof object.id === "string" ? object.id : null;
    await writeEntitlement(run, customer, status, subscription, nowMs);
    return {
      handled: true,
      action: status === "canceled" ? "entitlement_revoked" : "entitlement_updated",
      customer,
    };
  }

  if (type === "customer.subscription.deleted") {
    if (!customer) return { handled: false };
    const subscription = typeof object.id === "string" ? object.id : null;
    await writeEntitlement(run, customer, "canceled", subscription, nowMs);
    return { handled: true, action: "entitlement_revoked", customer };
  }

  return { handled: false };
}
