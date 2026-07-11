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
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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

// Sliding window as two weighted fixed windows (the @upstash/ratelimit
// "sliding window" algorithm): INCR the current minute bucket, weight the
// previous bucket by how much of it still overlaps the trailing 60s. Refused
// attempts still count, so hammering a 429 never makes it clear faster.
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
  return {
    allowed: weighted <= limit,
    retryAfterSec: Math.max(1, Math.ceil((RATE_WINDOW_MS - (nowMs % RATE_WINDOW_MS)) / 1000)),
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

// One concurrent generation per user: a human cannot present two meetings at
// once, so a second parallel stream is either a bug or shared credentials.
// SET NX PX acquires; release deletes only when the value is still ours
// (GET+DEL rather than Lua for memory-mode parity; the worst case of the
// non-atomic window is deleting a lease the TTL was about to reap anyway).
export async function acquireLease(
  run: RedisRunner,
  customer: string,
  ttlMs: number,
  requestId: string
): Promise<Lease | null> {
  const key = `hosted:lease:${customer}`;
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
  | { ok: true; lease: Lease }
  | { ok: false; status: number; error: string; retryAfterSec?: number };

// The full brake stack in gate order. Cheapest and most global first; the
// lease is last so a refused request never leaves a stale lock behind.
export async function gateHostedCall(
  run: RedisRunner,
  customer: string,
  cfg: GateConfig,
  requestId: string,
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
  const lease = await acquireLease(run, customer, cfg.leaseTtlMs, requestId);
  if (!lease) {
    return {
      ok: false,
      status: 409,
      error: "Another generation is already streaming for this account.",
    };
  }
  return { ok: true, lease };
}
