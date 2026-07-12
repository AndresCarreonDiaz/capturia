// One-time activation-code pickup for the checkout success page (M11 slice
// 1; the polished success UX is slice 2). The webhook files the code under a
// hash of the Stripe Checkout session id AND the pickup nonce the checkout
// endpoint embedded in the success URL, so only the payer's browser holds
// the full pair; this endpoint hands the code over exactly once (GETDEL)
// and 404s forever after, so a leaked success URL cannot be replayed.

import { takeActivationCodeForSession } from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";
import { checkRateLimit, clientIpFrom } from "@/lib/hosted/gate";

export const dynamic = "force-dynamic";

// Human flow is one pickup per purchase; the ceiling only has to make
// guessing games pointless without tripping a buyer who double-refreshes.
const PICKUPS_PER_MINUTE = 10;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return Response.json({ error: "Billing state backend is not configured." }, { status: 503 });
  }
  const rate = await checkRateLimit(
    backend.run,
    `pickup-ip:${clientIpFrom(request)}`,
    PICKUPS_PER_MINUTE,
    Date.now()
  );
  if (!rate.allowed) {
    return Response.json(
      { error: "Too many attempts, slow down." },
      { status: 429, headers: { "retry-after": String(rate.retryAfterSec) } }
    );
  }

  const code = await takeActivationCodeForSession(
    backend.run,
    params.get("session_id"),
    params.get("pickup")
  );
  if (!code) {
    return Response.json(
      { error: "No activation code for this session (already collected?)." },
      { status: 404 }
    );
  }
  return Response.json({ code });
}
