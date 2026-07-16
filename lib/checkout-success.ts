// Pure logic for the checkout success overlay (M11 slice 2): recognizing the
// Stripe redirect params and collecting the one-time activation code from
// /api/billing/activation-code. Framework-free so the polling behavior
// (webhook lag, the exactly-once pickup, network hiccups) is unit-tested;
// components/landing/CheckoutSuccess.tsx is the thin client shell around it.

export interface CheckoutReturnParams {
  sessionId: string;
  pickup: string;
}

const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{8,200}$/;
const PICKUP_RE = /^[A-Za-z0-9_-]{16,64}$/;

// The checkout endpoint builds success_url as
//   {origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}&pickup=<nonce>
// (app/api/billing/checkout/route.ts). Anything that does not match both
// shapes is not our redirect and renders nothing.
export function parseCheckoutReturn(search: string): CheckoutReturnParams | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("checkout") !== "success") return null;
  const sessionId = params.get("session_id") ?? "";
  const pickup = params.get("pickup") ?? "";
  if (!SESSION_ID_RE.test(sessionId) || !PICKUP_RE.test(pickup)) return null;
  return { sessionId, pickup };
}

export type PickupOutcome =
  | { status: "ok"; code: string }
  /** A code existed for this session and was already handed out. */
  | { status: "gone" }
  /** The webhook still had not minted when the window closed; refreshing later will work. */
  | { status: "pending" }
  /** The caller dismissed the overlay: nothing was fetched that could consume the code. */
  | { status: "aborted" }
  | { status: "error" };

export interface PickupOptions {
  /** Total attempts including the first (webhook can lag the redirect by seconds). */
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Checked before EVERY request so a dismissed overlay stops spending
   * attempts. (Burning the code is no longer the stake: the server re-files
   * it for a grace window after every hand-out, so even a request that wins
   * the pickup after dismissal leaves it collectable on the next visit.)
   */
  shouldAbort?: () => boolean;
  /** Cancels the in-flight request itself on dismiss; same outcome, sooner. */
  signal?: AbortSignal;
}

// Collect the code, tolerating webhook lag: the redirect can beat the
// checkout.session.completed delivery. The endpoint distinguishes the two
// misses for us: 404 means "not minted YET" (keep polling; if the window
// closes it is still only pending, a later refresh will succeed), 410 means
// the code was already collected or its record expired, so polling stops
// immediately. Any 2xx short-circuits.
export async function collectActivationCode(
  { sessionId, pickup }: CheckoutReturnParams,
  {
    attempts = 12,
    delayMs = 5000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    shouldAbort = () => false,
    signal,
  }: PickupOptions = {}
): Promise<PickupOutcome> {
  const url = `/api/billing/activation-code?session_id=${encodeURIComponent(
    sessionId
  )}&pickup=${encodeURIComponent(pickup)}`;
  let sawServerError = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    if (shouldAbort() || signal?.aborted) return { status: "aborted" };
    let res: Response;
    try {
      res = await fetchImpl(url, { cache: "no-store", signal });
    } catch {
      if (shouldAbort() || signal?.aborted) return { status: "aborted" };
      sawServerError = true;
      continue; // network blip: the next attempt decides
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (typeof body?.code === "string" && body.code) return { status: "ok", code: body.code };
      // A 200 whose body was lost or mangled is not a dead end: the server
      // re-files the code for a grace window after every hand-out, so the
      // next attempt simply re-collects it.
      sawServerError = true;
      continue;
    }
    if (res.status === 410) return { status: "gone" };
    if (res.status === 429) {
      // Rate limiting (a double-refresh, an office NAT) is webhook-lag
      // shaped, not a server fault: honor retry-after and keep polling.
      const retryAfterSec = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        await sleep(Math.min(retryAfterSec, 30) * 1000);
      }
      continue;
    }
    if (res.status !== 404) sawServerError = true; // 5xx: keep trying, report honestly
  }
  return sawServerError ? { status: "error" } : { status: "pending" };
}
