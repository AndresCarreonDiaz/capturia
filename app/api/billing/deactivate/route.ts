// Self-serve device deactivation (issue #10): the calling device releases
// its own seat so the buyer can move Capturia Pro to a new Mac without
// support. Authenticated exactly like the proxy and the usage endpoint (the
// Ed25519 device JWT from the keychain): the JWT names both the customer and
// the registered device, so the route can only ever free the caller's own
// slot, never someone else's. Idempotent: deactivating an already-free
// device answers the same 200, so a retry after a lost response cannot fail.
// The device's refresh token stops minting on its next use (the token
// endpoint re-checks registration), which is how "deactivated" propagates.

import { deactivateDevice } from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";
import { jwtPublicKeyFromEnv, verifyHostedJwt } from "@/lib/hosted/jwt";
import { hostedTokenFromRequest } from "@/lib/hosted/proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const publicKey = jwtPublicKeyFromEnv(process.env);
  if (!publicKey) {
    return Response.json(
      { error: "Hosted tier is not configured on this deployment." },
      { status: 503 }
    );
  }
  const verdict = verifyHostedJwt(hostedTokenFromRequest(request), publicKey);
  if (!verdict.ok) {
    return Response.json({ error: verdict.error }, { status: 401 });
  }

  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return Response.json({ error: "Hosted tier state backend is not configured." }, { status: 503 });
  }

  const { devices } = await deactivateDevice(backend.run, verdict.claims.sub, verdict.claims.device);
  return Response.json({ ok: true, devices });
}
