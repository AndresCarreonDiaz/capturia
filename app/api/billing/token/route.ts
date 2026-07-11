// Token refresh endpoint (M11 slice 1): refresh token -> short-lived
// Ed25519-signed JWT (~1h, lib/hosted/jwt.ts). Every refresh re-checks the
// entitlement cache and the device registration, so a canceled subscription
// or removed device stops minting within one JWT lifetime even though the
// proxy verifies JWTs statelessly.

import { isDeviceRegistered, lookupRefreshToken } from "@/lib/hosted/entitlements";
import { isEntitled, readEntitlement } from "@/lib/hosted/gate";
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

  const body = (await request.json().catch(() => null)) as { refreshToken?: unknown } | null;
  if (!body || typeof body.refreshToken !== "string") {
    return Response.json({ error: "Expected { refreshToken }." }, { status: 400 });
  }

  const backend = await getHostedBackend(process.env);
  const record = await lookupRefreshToken(backend.run, body.refreshToken);
  if (!record) {
    return Response.json({ error: "Invalid refresh token." }, { status: 401 });
  }

  const entitlement = await readEntitlement(backend.run, record.customer);
  if (!isEntitled(entitlement)) {
    return Response.json({ error: "Subscription is no longer active." }, { status: 402 });
  }
  if (!(await isDeviceRegistered(backend.run, record.customer, record.deviceId))) {
    return Response.json({ error: "This device has been deactivated." }, { status: 403 });
  }

  const { token, expiresAt } = signHostedJwt({
    customer: record.customer,
    device: record.deviceId,
    plan: entitlement?.plan ?? "pro",
    privateKey,
  });
  return Response.json({ token, expiresAt });
}
