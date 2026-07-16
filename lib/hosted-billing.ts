// Pure decision logic for the desktop upgrade flow (M11 slice 2): where the
// billing endpoints live, what a valid activation code looks like, how the
// server's activate/token responses are validated, when the next JWT refresh
// should run, and what clearing a vault row means. Framework-free so vitest
// covers it and Electron main consumes the CJS build in electron/gen/
// (scripts/build-electron-libs.mjs); the fetching itself stays in
// electron/hosted-billing.js.

import { HOSTED_PROVIDER } from "./desktop-runtime";

// The one activation-code shape, shared by the server that mints codes
// (lib/hosted/entitlements.ts re-exports this) and the desktop client that
// validates paste input before it ever crosses an IPC boundary.
export const ACTIVATION_CODE_RE = /^CAPTURIA(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

// Users paste codes from a success page or an email: tolerate whitespace and
// lowercase, never anything that changes the code itself.
export function normalizeActivationCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return ACTIVATION_CODE_RE.test(code) ? code : null;
}

// The billing endpoints live on the same deployment as the hosted proxy:
// CAPTURIA_HOSTED_URL points at <origin>/api/hosted (lib/desktop-runtime.ts),
// so the billing origin is that URL with the /api/hosted suffix stripped.
// Deriving instead of adding a second env var means a dev override points
// BOTH surfaces at the same server and the checkout success page always
// lands on the deployment that minted the session.
const DEFAULT_HOSTED_BASE = "https://capturia.app/api/hosted";

export function billingOriginFromEnv(env: Record<string, string | undefined>): string {
  const base = (env.CAPTURIA_HOSTED_URL || DEFAULT_HOSTED_BASE).replace(/\/+$/, "");
  return base.replace(/\/api\/hosted$/, "");
}

export interface ActivationResult {
  refreshToken: string;
  token: string;
  /** Absolute ms timestamp (lib/hosted/jwt.ts signHostedJwt contract). */
  expiresAt: number;
  devices: number;
}

export function parseActivateResponse(body: unknown): ActivationResult | null {
  const b = body as Record<string, unknown> | null;
  if (
    !b ||
    typeof b.refreshToken !== "string" ||
    !b.refreshToken ||
    typeof b.token !== "string" ||
    !b.token ||
    typeof b.expiresAt !== "number" ||
    !Number.isFinite(b.expiresAt)
  ) {
    return null;
  }
  return {
    refreshToken: b.refreshToken,
    token: b.token,
    expiresAt: b.expiresAt,
    devices: typeof b.devices === "number" ? b.devices : 1,
  };
}

export interface TokenResult {
  token: string;
  expiresAt: number;
}

export function parseTokenResponse(body: unknown): TokenResult | null {
  const b = body as Record<string, unknown> | null;
  if (
    !b ||
    typeof b.token !== "string" ||
    !b.token ||
    typeof b.expiresAt !== "number" ||
    !Number.isFinite(b.expiresAt)
  ) {
    return null;
  }
  return { token: b.token, expiresAt: b.expiresAt };
}

// Refresh at 80% of the token's remaining lifetime: early enough that a
// presenter never hits a mid-call expiry even if one refresh attempt fails
// and the retry backoff below has to kick in, late enough that the server
// sees ~1 refresh per JWT. Clamped so a clock-skewed or hostile expiresAt
// can neither hammer the endpoint nor park the timer for a year.
export const MIN_REFRESH_DELAY_MS = 30_000;
export const MAX_REFRESH_DELAY_MS = 45 * 60_000;
// A failed refresh retries quickly when it might be transient (network,
// 5xx), slowly when the account is the problem (402: Stripe may recover the
// subscription on a card retry days later, so keep trying but gently).
export const RETRY_TRANSIENT_MS = 5 * 60_000;
export const RETRY_UNENTITLED_MS = 60 * 60_000;

export function computeRefreshDelayMs(expiresAtMs: number, nowMs: number): number {
  const remaining = expiresAtMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return MIN_REFRESH_DELAY_MS;
  const delay = Math.floor(remaining * 0.8);
  return Math.min(MAX_REFRESH_DELAY_MS, Math.max(MIN_REFRESH_DELAY_MS, delay));
}

// What a failed refresh means for the stored credentials. 401/403 are
// terminal for THIS refresh token (revoked, or the device was deactivated):
// keep nothing, the user re-activates with a fresh code. 402 keeps the
// refresh token (the subscription may recover) but the JWT is left to
// expire naturally. Anything else is transient: keep everything, retry.
export type RefreshFailure = "drop_credentials" | "keep_and_retry_slowly" | "keep_and_retry";

export function classifyRefreshFailure(status: number): RefreshFailure {
  if (status === 401 || status === 403) return "drop_credentials";
  if (status === 402) return "keep_and_retry_slowly";
  return "keep_and_retry";
}

// What clearing a vault row means. The Pro row is not a plain key: behind
// its JWT sit a refresh token and a pending re-mint timer, so it must go
// through the billing module's local deactivation or the refresh loop would
// quietly re-mint what the user just cleared. Every other row is a BYOK key
// and a straight keychain delete. Pure so the routing is pinned by tests;
// electron/main.js's keys:clear handler supplies the side effects.
export type VaultClearAction = "deactivate_hosted" | "clear_key";

export function classifyVaultClear(provider: string): VaultClearAction {
  return provider === HOSTED_PROVIDER ? "deactivate_hosted" : "clear_key";
}
