import { createHash } from "node:crypto";
import { RATE_LIMIT_WINDOW_MS, SUMMARY_RATE_LIMIT_MAX } from "@/lib/beacon";
import { getBeaconStore } from "@/lib/beacon-store";

// Public aggregate readout for the desktop beacon (docs/telemetry.md):
//   curl https://www.capturia.dev/api/beacon/summary
// Returns { dau, wau, mau, activations, events, versions, ... }; the /metrics
// page renders it. Public by decision, not by accident: every number is an
// aggregate count, the uniques live in HyperLogLogs that can only answer
// "how many", never "who", and the download counts shown alongside them are
// public on GitHub anyway. There is nothing per-user to protect. If gating
// is ever wanted back, the old bearer-token gate lives in this file's git
// history.
//
// Unauthenticated and a few Redis commands per hit means the Upstash bill
// needs guarding instead: the CDN serves nearly every reader (Cache-Control
// below), and a light per-IP limit bounds the cache-miss path.

// The counts are live per-request state; the framework must never cache the
// handler. Edge caching is the CDN's job, via the response header below.
export const dynamic = "force-dynamic";

// Five minutes fresh plus ten stale-while-revalidate: adoption numbers do
// not move faster than that, and one origin read per five minutes keeps the
// Redis spend flat no matter how many tabs watch the dashboard.
const CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=600";

// Same limiter key idiom as the POST route (app/api/beacon/route.ts): a
// truncated SHA-256 of the client IP, gone when the window expires. The
// summary: namespace keeps dashboard reads from eating the POST budget.
function ipBucket(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = (forwarded?.split(",")[0] || request.headers.get("x-real-ip") || "local").trim();
  return `summary:${createHash("sha256").update(ip).digest("hex").slice(0, 16)}`;
}

export async function GET(request: Request): Promise<Response> {
  const store = getBeaconStore();

  let allowed = true;
  try {
    allowed = await store.allow(ipBucket(request), Date.now(), SUMMARY_RATE_LIMIT_MAX);
  } catch {
    // Limiter backend hiccup: fail open, same as the POST route. The read
    // below hits the same backend and reports the real failure.
  }
  if (!allowed) {
    return Response.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(RATE_LIMIT_WINDOW_MS / 1000) } }
    );
  }

  try {
    return Response.json(await store.summary(), {
      headers: { "cache-control": CACHE_CONTROL },
    });
  } catch (err) {
    console.warn("capturia: beacon summary failed:", err);
    return Response.json({ error: "store unavailable" }, { status: 503 });
  }
}
