// One-time activation-code pickup for the checkout success page (M11 slice
// 1; the polished success UX is slice 2). The webhook files the code under a
// hash of the Stripe Checkout session id AND the pickup nonce the checkout
// endpoint embedded in the success URL, so only the payer's browser holds
// the full pair; this endpoint hands the code to exactly one credential
// holder (GETDEL plus a short re-file grace window so a dropped response
// cannot burn the code), and a leaked success URL cannot be replayed once
// the grace lapses.
//
// Response contract, chosen so nothing here is a purchase oracle: every
// state beyond 200 that admits a code ever existed (410) is keyed on the
// session+nonce PAIR, never the session id alone. A caller without the
// nonce always sees a flat 404.
//   200: the code (first pickup, a grace-window repeat, or the mid-mint
//        retake below)
//   404: webhook not landed yet for this pair, or the caller is not the
//        nonce holder; the success page keeps polling
//   410: this pair's code was collected, or its record expired; polling is
//        pointless and the page says so

import {
  takeActivationCodeForSession,
  wasActivationCollected,
  wasActivationFiled,
} from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";
import { checkRateLimit, clientIpFrom } from "@/lib/hosted/gate";

export const dynamic = "force-dynamic";

// Must clear the success page's own poll (12 requests/min) plus a
// double-refresh overlap plus office-NAT neighbors sharing an IP. The limit
// is defense-in-depth only: pickup needs the unguessable 16-64 char nonce,
// so even an uncapped guesser gets nothing but 404s.
const PICKUPS_PER_MINUTE = 30;

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

  const sessionId = params.get("session_id");
  const pickup = params.get("pickup");
  const code = await takeActivationCodeForSession(backend.run, sessionId, pickup);
  if (code) return Response.json({ code });

  // Miss. Both probes below shape-check internally and are keyed on the
  // hashed session+nonce pair, so a malformed or missing nonce falls
  // straight through them to the flat 404.
  if (await wasActivationCollected(backend.run, sessionId, pickup)) {
    return Response.json(
      { error: "This session's activation code was already collected." },
      { status: 410 }
    );
  }
  if (!(await wasActivationFiled(backend.run, sessionId, pickup))) {
    return Response.json({ error: "No activation code for this session yet." }, { status: 404 });
  }
  // Filed for this exact pair, not collected, yet the take missed: either
  // the webhook wrote the record but our GETDEL ran just before it landed
  // (the filed marker is written after the record, so one retake closes
  // that race) or the record has expired.
  const retaken = await takeActivationCodeForSession(backend.run, sessionId, pickup);
  if (retaken) return Response.json({ code: retaken });
  if (await wasActivationCollected(backend.run, sessionId, pickup)) {
    return Response.json(
      { error: "This session's activation code was already collected." },
      { status: 410 }
    );
  }
  return Response.json(
    { error: "This session's activation code expired. Write to support@capturia.app." },
    { status: 410 }
  );
}
