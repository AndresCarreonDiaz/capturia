import { timingSafeEqual } from "node:crypto";
import { getBeaconStore } from "@/lib/beacon-store";

// Owner-only aggregate readout for the desktop beacon (docs/telemetry.md):
//   curl -H "Authorization: Bearer $CAPTURIA_METRICS_TOKEN" \
//     https://capturia.app/api/beacon/summary
// Returns { dau, wau, mau, activations, events, versions, ... }. Aggregates
// only; there is nothing per-user to expose even to the owner. Guarded by
// CAPTURIA_METRICS_TOKEN; with the env var unset the endpoint stays sealed
// (503) so a deploy can never leak metrics by forgetting the token.

// The counts are live per-request state; never serve a cached readout.
export const dynamic = "force-dynamic";

function tokenOk(request: Request): boolean {
  const expected = process.env.CAPTURIA_METRICS_TOKEN;
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const presented = Buffer.from(match[1]);
  const secret = Buffer.from(expected);
  return presented.length === secret.length && timingSafeEqual(presented, secret);
}

export async function GET(request: Request): Promise<Response> {
  if (!process.env.CAPTURIA_METRICS_TOKEN) {
    return Response.json({ error: "metrics token not configured" }, { status: 503 });
  }
  if (!tokenOk(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await getBeaconStore().summary());
  } catch (err) {
    console.warn("capturia: beacon summary failed:", err);
    return Response.json({ error: "store unavailable" }, { status: 503 });
  }
}
