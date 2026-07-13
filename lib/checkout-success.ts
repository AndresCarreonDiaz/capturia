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
  | { status: "gone" }
  | { status: "error" };

export interface PickupOptions {
  /** Total attempts including the first (webhook can lag the redirect by seconds). */
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

// Collect the code, tolerating webhook lag: the redirect can beat the
// checkout.session.completed delivery, so 404 early on means "not minted
// YET" and is retried; a 404 that survives every attempt means the code was
// already collected (the endpoint GETDELs) or the session is unknown, which
// the UI explains rather than retries. Any 2xx short-circuits immediately.
export async function collectActivationCode(
  { sessionId, pickup }: CheckoutReturnParams,
  {
    attempts = 8,
    delayMs = 2500,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: PickupOptions = {}
): Promise<PickupOutcome> {
  const url = `/api/billing/activation-code?session_id=${encodeURIComponent(
    sessionId
  )}&pickup=${encodeURIComponent(pickup)}`;
  let sawServerError = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    let res: Response;
    try {
      res = await fetchImpl(url, { cache: "no-store" });
    } catch {
      sawServerError = true;
      continue; // network blip: the next attempt decides
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (typeof body?.code === "string" && body.code) return { status: "ok", code: body.code };
      return { status: "error" };
    }
    if (res.status !== 404) sawServerError = true; // 429/5xx: keep trying, report honestly
  }
  return sawServerError ? { status: "error" } : { status: "gone" };
}
