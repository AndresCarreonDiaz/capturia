// Per-request spend brakes for the hosted LLM proxy (M11, issue #10). This is
// layer 2 of the defense-in-depth stack decided on the issue: the stateless
// JWT check is layer 1 (lib/hosted/jwt.ts), Cloudflare AI Gateway per-user
// dollar caps are layer 3, and the GCP project spend cap is layer 4. Every
// gate here runs against the injected RedisRunner (lib/upstash.ts for real
// deploys, lib/hosted/memory-redis.ts for dev/tests), so the logic is
// identical in both modes and unit-testable with a fake clock.
//
// Deliberately simple commands instead of one Lua script (contrast
// lib/vote-store-redis.ts): the dev fallback would otherwise need a Lua
// interpreter, and a lost race between two serverless invocations costs at
// most one extra generation, which the outer layers still cap. Votes needed
// exact atomic semantics; brakes need cheap, shared, testable logic.

import type { RedisRunner } from "../upstash";

type Env = Record<string, string | undefined>;

export interface GateConfig {
  /** Sliding-window request ceiling per user (legit cadence is ~2/min). */
  ratePerMinute: number;
  /** Monthly included token allowance per user (proxy-side brake, not billing). */
  monthlyTokenBudget: number;
  /** Backstop TTL for the one-stream-per-user lease. */
  leaseTtlMs: number;
}

// Defaults follow the issue #10 proposal: ~10 req/min vs ~2/min legit, and a
// token budget sized so 20 "AI hours" of Flash-Lite-class usage fits with
// headroom (billing-grade hour metering is a later slice; this counter only
// has to stop runaway spend).
export function gateConfigFromEnv(env: Env = process.env): GateConfig {
  return {
    ratePerMinute: positiveInt(env.CAPTURIA_HOSTED_RATE_LIMIT, 10),
    monthlyTokenBudget: positiveInt(env.CAPTURIA_HOSTED_MONTHLY_TOKENS, 5_000_000),
    leaseTtlMs: positiveInt(env.CAPTURIA_HOSTED_LEASE_TTL_MS, 120_000),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  // Floor BEFORE the > 0 check so "0.5" falls back instead of becoming 0.
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// For per-IP rate limiting on the anonymous billing endpoints: first hop of
// x-forwarded-for (Vercel sets it; spoofing only lets an attacker throttle
// the identity they made up, not anyone else).
export function clientIpFrom(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}

const KILL_KEY = "hosted:kill";
const RATE_WINDOW_MS = 60_000;
const USAGE_TTL_S = 40 * 24 * 60 * 60; // outlives the month it counts, then GC

export type EntitlementStatus = "active" | "trialing" | "past_due" | "canceled";

export interface Entitlement {
  status: EntitlementStatus;
  plan: string;
  subscription: string | null;
  updatedAt: number;
  /**
   * Stripe event timestamp (ms) that produced this record; the ordering
   * watermark that stops an out-of-order webhook overwriting a newer state.
   * Absent on records written before ordering was guarded.
   */
  eventAt?: number;
}

export function entitlementKey(customer: string): string {
  return `hosted:ent:${customer}`;
}

export async function readEntitlement(
  run: RedisRunner,
  customer: string
): Promise<Entitlement | null> {
  const raw = await run(["GET", entitlementKey(customer)]);
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as Entitlement;
    return typeof parsed?.status === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// past_due stays entitled: Stripe retries the card for days and cutting a
// live presenter off over a failed retry is the wrong failure mode. Access
// ends when the subscription actually transitions to canceled/unpaid
// (webhook flips the record) or the JWT refresh is refused.
export function isEntitled(ent: Entitlement | null): boolean {
  return !!ent && (ent.status === "active" || ent.status === "trialing" || ent.status === "past_due");
}

export async function isKillSwitchOn(run: RedisRunner): Promise<boolean> {
  const raw = await run(["GET", KILL_KEY]);
  return raw !== null && raw !== undefined && String(raw) !== "0";
}

export function monthKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7); // "2026-07"
}

function usageKey(customer: string, nowMs: number): string {
  return `hosted:usage:${customer}:${monthKey(nowMs)}`;
}

// When a request is refused, the honest retry-after is the earliest instant
// a NEW attempt would be admitted. Attempts INCR before the check, so the
// next attempt at elapsed e is admitted when previous*(1-e) + current + 1 <=
// limit; when even current + 1 exceeds the limit, no instant in this window
// works and the wait extends into the next window, where today's current
// bucket becomes the decaying previous one.
function refusalRetryMs(previous: number, current: number, limit: number, nowMs: number): number {
  const intoWindow = nowMs % RATE_WINDOW_MS;
  const headroom = limit - current - 1;
  if (headroom >= 0) {
    if (previous <= 0) return 0;
    const needElapsed = Math.max(0, 1 - headroom / previous);
    return Math.max(0, needElapsed * RATE_WINDOW_MS - intoWindow);
  }
  const nextElapsed = current > 0 ? Math.max(0, 1 - (limit - 1) / current) : 0;
  return RATE_WINDOW_MS - intoWindow + nextElapsed * RATE_WINDOW_MS;
}

// Sliding window as two weighted fixed windows (the @upstash/ratelimit
// "sliding window" algorithm): INCR the current minute bucket, weight the
// previous bucket by how much of it still overlaps the trailing 60s. Refused
// attempts still count, so hammering a 429 never makes it clear faster; the
// retry-after hint accounts for that, so honoring it actually succeeds.
export async function checkRateLimit(
  run: RedisRunner,
  customer: string,
  limit: number,
  nowMs: number
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const window = Math.floor(nowMs / RATE_WINDOW_MS);
  const currentKey = `hosted:rl:${customer}:${window}`;
  const current = Number(await run(["INCR", currentKey])) || 0;
  if (current === 1) {
    await run(["PEXPIRE", currentKey, RATE_WINDOW_MS * 2]);
  }
  const prevRaw = await run(["GET", `hosted:rl:${customer}:${window - 1}`]);
  const previous = Number(prevRaw) || 0;
  const elapsed = (nowMs % RATE_WINDOW_MS) / RATE_WINDOW_MS;
  const weighted = previous * (1 - elapsed) + current;
  const allowed = weighted <= limit;
  return {
    allowed,
    retryAfterSec: allowed
      ? 1
      : Math.max(1, Math.ceil(refusalRetryMs(previous, current, limit, nowMs) / 1000)),
  };
}

export async function readMonthlyUsage(
  run: RedisRunner,
  customer: string,
  nowMs: number
): Promise<number> {
  return Number(await run(["GET", usageKey(customer, nowMs)])) || 0;
}

// Post-call accounting; the pre-call gate reads the same counter, so a call
// in flight is never double-blocked but the NEXT call sees its cost. Tokens
// are floored at 1 so a response whose usage metadata went missing still
// costs something.
export async function recordUsage(
  run: RedisRunner,
  customer: string,
  totalTokens: number,
  nowMs: number
): Promise<number> {
  const key = usageKey(customer, nowMs);
  const tokens = Math.max(1, Math.floor(totalTokens) || 0);
  const total = Number(await run(["INCRBY", key, tokens])) || 0;
  await run(["EXPIRE", key, USAGE_TTL_S]);
  return total;
}

export interface Lease {
  release(): Promise<void>;
}

// The desktop app legitimately runs two hosted call classes at once: the live
// overlay stream and a one-shot deck-codegen :generateContent. Each lane gets
// its own lease so they never 409 each other, while two concurrent calls in
// the SAME lane still read as a bug or shared credentials.
export type LeaseLane = "stream" | "batch";

// One concurrent generation per user per lane: a human cannot present two
// meetings at once, so a second parallel stream is either a bug or shared
// credentials. SET NX PX acquires; release deletes only when the value is
// still ours (GET+DEL rather than Lua for memory-mode parity; the worst case
// of the non-atomic window is deleting a lease the TTL was about to reap
// anyway).
export async function acquireLease(
  run: RedisRunner,
  customer: string,
  ttlMs: number,
  requestId: string,
  lane: LeaseLane = "stream"
): Promise<Lease | null> {
  const key = `hosted:lease:${customer}:${lane}`;
  const reply = await run(["SET", key, requestId, "NX", "PX", ttlMs]);
  if (reply !== "OK") return null;
  return {
    async release() {
      const owner = await run(["GET", key]);
      if (owner === requestId) await run(["DEL", key]);
    },
  };
}

export type GateDecision =
  | { ok: true }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

// The brake stack in gate order, cheapest and most global first. None of
// these need the request body, so the route runs them BEFORE parsing it;
// the per-lane lease is acquired separately once the call is planned, so a
// refused or malformed request never leaves a stale lock behind.
export async function gateHostedCall(
  run: RedisRunner,
  customer: string,
  cfg: GateConfig,
  nowMs = Date.now()
): Promise<GateDecision> {
  if (await isKillSwitchOn(run)) {
    return { ok: false, status: 503, error: "Hosted generation is temporarily paused." };
  }
  const ent = await readEntitlement(run, customer);
  if (!isEntitled(ent)) {
    return { ok: false, status: 402, error: "No active Capturia subscription for this account." };
  }
  const rate = await checkRateLimit(run, customer, cfg.ratePerMinute, nowMs);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      error: "Rate limit exceeded, slow down.",
      retryAfterSec: rate.retryAfterSec,
    };
  }
  const used = await readMonthlyUsage(run, customer, nowMs);
  if (used >= cfg.monthlyTokenBudget) {
    return {
      ok: false,
      status: 429,
      error: "Monthly included usage exhausted; hosted generation resumes next cycle.",
    };
  }
  return { ok: true };
}
