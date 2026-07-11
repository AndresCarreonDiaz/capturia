// Activation endpoint (M11 slice 1): trades a one-time activation code
// (minted by the Stripe webhook, or the dev seed) for a long-lived refresh
// token plus a first short-lived JWT. Registers the device in Redis with a
// hard cap of 3 per customer. The refresh token is returned exactly once
// and stored only as a hash; there are no user accounts to log into.

import {
  consumeActivationCode,
  isValidDeviceId,
  mintRefreshToken,
  registerDevice,
} from "@/lib/hosted/entitlements";
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

  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
    deviceId?: unknown;
  } | null;
  if (!body || typeof body.code !== "string" || !isValidDeviceId(body.deviceId)) {
    return Response.json({ error: "Expected { code, deviceId }." }, { status: 400 });
  }

  const backend = await getHostedBackend(process.env);
  const activation = await consumeActivationCode(backend.run, body.code);
  if (!activation) {
    // Unknown, malformed, expired, and already-used all read the same:
    // nothing here confirms whether a guessed code ever existed.
    return Response.json({ error: "Invalid or already used activation code." }, { status: 404 });
  }

  const entitlement = await readEntitlement(backend.run, activation.customer);
  if (!isEntitled(entitlement)) {
    return Response.json(
      { error: "No active subscription for this activation code." },
      { status: 402 }
    );
  }

  const device = await registerDevice(backend.run, activation.customer, body.deviceId);
  if (!device.ok) {
    return Response.json(
      { error: "Device limit reached (3). Deactivate another device first." },
      { status: 403 }
    );
  }

  const refreshToken = await mintRefreshToken(
    backend.run,
    activation.customer,
    body.deviceId,
    Date.now()
  );
  const { token, expiresAt } = signHostedJwt({
    customer: activation.customer,
    device: body.deviceId,
    plan: entitlement?.plan ?? "pro",
    privateKey,
  });
  return Response.json({ refreshToken, token, expiresAt, devices: device.devices });
}
