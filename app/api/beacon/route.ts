import { createHash } from "node:crypto";
import { MAX_BEACON_BODY_BYTES, parseBeaconPayload } from "@/lib/beacon";
import { getBeaconStore } from "@/lib/beacon-store";

// Anonymous desktop beacon (docs/telemetry.md). The Capturia app POSTs
//   { installId, event, appVersion, macosVersion }
// on launch and on camera activation; storage is aggregate-only (unique
// installs in HyperLogLogs, plain counters), read back by the owner via
// /api/beacon/summary. Public endpoint, so: strict allowlist validation
// (lib/beacon.ts rejects extra fields outright), a small body cap, and a
// per-IP rate limit whose only IP-derived value is a truncated hash that
// expires with the limiter window. Never ships in the desktop bundle
// (scripts/build-electron-export.mjs relocates app/api out of that build).

// Beacons mutate per-request state; never let the framework cache anything.
export const dynamic = "force-dynamic";

// The limiter key: a truncated SHA-256 of the client IP. Raw IPs never reach
// storage, and the hash itself lives only for RATE_LIMIT_WINDOW_MS (the Lua
// script PEXPIREs it). Vercel/most proxies set x-forwarded-for; direct dev
// traffic has neither header and shares one local bucket.
function ipBucket(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = (forwarded?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

export async function POST(request: Request): Promise<Response> {
  const store = getBeaconStore();

  let allowed = true;
  try {
    allowed = await store.allow(ipBucket(request));
  } catch {
    // Limiter backend hiccup: fail open. The write below hits the same
    // backend and reports the real failure.
  }
  if (!allowed) {
    return Response.json({ error: "too many requests" }, { status: 429 });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: "unreadable body" }, { status: 400 });
  }
  if (text.length > MAX_BEACON_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = parseBeaconPayload(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 422 });
  }

  try {
    await store.record(parsed.payload);
  } catch (err) {
    // The desktop client is fire-and-forget and never retries, so this is
    // for the operator's logs, not the caller.
    console.warn("capturia: beacon store write failed:", err);
    return Response.json({ error: "store unavailable" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
