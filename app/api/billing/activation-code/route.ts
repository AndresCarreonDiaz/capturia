// One-time activation-code pickup for the checkout success page (M11 slice
// 1; the polished success UX is slice 2). The webhook files the code under
// the Stripe Checkout session id, which only the buyer's browser and Stripe
// know; this endpoint hands it over exactly once (GETDEL) and 404s forever
// after, so a leaked success URL cannot be replayed.

import { takeActivationCodeForSession } from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get("session_id");
  const backend = await getHostedBackend(process.env);
  const code = await takeActivationCodeForSession(backend.run, sessionId);
  if (!code) {
    return Response.json(
      { error: "No activation code for this session (already collected?)." },
      { status: 404 }
    );
  }
  return Response.json({ code });
}
