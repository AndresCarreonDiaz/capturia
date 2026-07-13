// Activation endpoint (M11 slice 1): trades a one-time activation code
// (minted by the Stripe webhook, or the dev seed) for a long-lived refresh
// token plus a first short-lived JWT. Registers the device in Redis with a
// hard cap of 3 per customer; recoverable refusals (lapsed subscription,
// device limit) put the code back so the buyer can retry after fixing them.
// The refresh token is returned exactly once and stored only as a hash;
// there are no user accounts to log into.

import { isValidDeviceId, mintRefreshToken, redeemActivationCode } from "@/lib/hosted/entitlements";
import { getHostedBackend } from "@/lib/hosted/backend";
import { jwtPrivateKeyFromEnv, signHostedJwt } from "@/lib/hosted/jwt";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const privateKey = jwtPrivateKeyFromEnv(process.env);
  if (!privateKey) {
    return Response.json(
      { error: "Hosted tier is not configured on this deployment." },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
    deviceId?: unknown;
  } | null;
  if (!body || typeof body.code !== "string" || !isValidDeviceId(body.deviceId)) {
    return Response.json({ error: "Expected { code, deviceId }." }, { status: 400 });
  }

  let backend;
  try {
    backend = await getHostedBackend(process.env);
  } catch {
    return Response.json({ error: "Hosted tier state backend is not configured." }, { status: 503 });
  }

  const redemption = await redeemActivationCode(backend.run, body.code, body.deviceId);
  if (!redemption.ok) {
    return Response.json({ error: redemption.error }, { status: redemption.status });
  }

  const refreshToken = await mintRefreshToken(
    backend.run,
    redemption.customer,
    body.deviceId,
    Date.now()
  );
  const { token, expiresAt } = signHostedJwt({
    customer: redemption.customer,
    device: body.deviceId,
    plan: redemption.plan,
    privateKey,
  });
  return Response.json({ refreshToken, token, expiresAt, devices: redemption.devices });
}
