// Anonymous desktop beacon: the shared contract (docs/telemetry.md).
//
// The desktop app sends exactly one JSON shape to POST /api/beacon:
//   { installId, event, appVersion, macosVersion }
// and nothing else, ever. installId is a random UUID minted once per install
// on the user's machine; it identifies an installation, never a person. The
// endpoint is public (any curl can reach it), so parsing is strict allowlist
// validation: unknown fields, wrong types, or oversized values are rejected
// outright rather than stripped, which keeps the wire contract auditable
// (what the privacy doc says is sent is the ONLY thing the server accepts).
//
// This module is pure (no fetch, no Redis) so both the route handler and the
// tests share one definition of valid, and the key/date helpers keep the
// Redis store and the summary endpoint agreeing on names.

export const BEACON_EVENTS = ["launch", "camera-installed", "update-check"] as const;
export type BeaconEvent = (typeof BEACON_EVENTS)[number];

export interface BeaconPayload {
  installId: string;
  event: BeaconEvent;
  appVersion: string;
  macosVersion: string;
}

// RFC 4122 textual shape (any version). Normalized to lowercase so the
// same install never counts twice in a HyperLogLog because of casing.
export const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// appVersion is what app.getVersion() reports: package.json semver, x.y.z
// with an optional short prerelease suffix. Pinning the exact shape (not
// just "short and printable") keeps junk strings out of the versions hash,
// whose fields are a capped, long-lived metric (see MAX_VERSION_FIELDS).
const APP_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,15})?$/;
// macosVersion is what process.getSystemVersion() reports ("15.5", "26.0",
// "26.0.1"): two or three numeric components.
const MACOS_VERSION_RE = /^\d{1,4}\.\d{1,4}(\.\d{1,4})?$/;

const ALLOWED_KEYS = ["installId", "event", "appVersion", "macosVersion"] as const;

// Body size cap for the route, far above the real payload (~130 bytes).
export const MAX_BEACON_BODY_BYTES = 512;

// Per-IP rate limit: a real install sends at most a few events per launch,
// so 30/minute is generous headroom for shared NATs while still bounding a
// curl loop against the metered backend.
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 60_000;

// The public summary GET rides the same limiter with a tighter budget: the
// CDN's s-maxage serves almost every reader, so 10/minute per IP is plenty
// for cache misses while bounding what a curl loop can spend in Redis
// commands (a summary read is one nine-command pipeline).
export const SUMMARY_RATE_LIMIT_MAX = 10;

// Unique-install keys expire on their own: dailies live long enough to
// compute a trailing week plus a debugging margin, monthlies long enough for
// a year-over-year look. Event counters are tiny, bounded, and deliberately
// permanent (they ARE the funnel history); the versions hash gets its own
// long TTL below so a poisoned state ages out.
export const DAY_KEY_TTL_S = 40 * 24 * 3600;
export const MONTH_KEY_TTL_S = 400 * 24 * 3600;

// Cap on distinct appVersion fields in the versions hash: real releases are
// rare, and the cap keeps a forged-but-valid payload loop from minting
// unbounded hash fields on the metered backend. Rejected NEW versions are
// not dropped silently: they increment an overflow counter the summary
// surfaces, so a poisoning attempt is visible instead of quietly freezing
// the metric, and the hash carries a long TTL so a poisoned state ages out.
// Manual recovery: HDEL the junk fields from beacon:versions (docs/telemetry.md).
export const MAX_VERSION_FIELDS = 200;
export const VERSIONS_TTL_S = 800 * 24 * 3600;

export type BeaconParse =
  | { ok: true; payload: BeaconPayload }
  | { ok: false; error: string };

// Strict parse of an untrusted request body. Rejects (never strips) extra
// fields; returns a normalized copy on success.
export function parseBeaconPayload(body: unknown): BeaconParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown field: ${key}` };
    }
  }
  const { installId, event, appVersion, macosVersion } = record;
  if (typeof installId !== "string" || !INSTALL_ID_RE.test(installId)) {
    return { ok: false, error: "installId must be a UUID" };
  }
  if (typeof event !== "string" || !(BEACON_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, error: "event must be one of launch, camera-installed, update-check" };
  }
  if (typeof appVersion !== "string" || !APP_VERSION_RE.test(appVersion)) {
    return { ok: false, error: "appVersion must be a semver version string" };
  }
  if (typeof macosVersion !== "string" || !MACOS_VERSION_RE.test(macosVersion)) {
    return { ok: false, error: "macosVersion must be a numeric version string" };
  }
  return {
    ok: true,
    payload: {
      installId: installId.toLowerCase(),
      event: event as BeaconEvent,
      appVersion,
      macosVersion,
    },
  };
}

// UTC date stamps so a beacon at 23:59 in one timezone and 00:01 in another
// land deterministically; every machine (serverless region, laptop) buckets
// identically.
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function utcDayStamp(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

export function utcMonthStamp(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}`;
}

const DAY_MS = 24 * 3600 * 1000;

// Today plus the previous n-1 UTC days, newest first. WAU is the unique
// count across these for n=7.
export function lastNDayStamps(now: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => utcDayStamp(now - i * DAY_MS));
}

// One place for every Redis key name, so the store, the summary, and the
// docs cannot drift. Layout:
//   beacon:ids:d:<YYYYMMDD>  HLL of installIds seen that UTC day   (TTL 40d)
//   beacon:ids:m:<YYYYMM>    HLL of installIds seen that UTC month (TTL 400d)
//   beacon:activated         HLL of installIds that ever activated the camera
//   beacon:count:<event>     plain counter per event
//   beacon:versions          hash appVersion -> launch count (TTL 800d)
//   beacon:versions-overflow launches whose NEW version hit the field cap (TTL 800d)
//   beacon:rl:<bucket>       per-IP-hash rate limit counter (TTL 60s)
export const beaconKeys = {
  day: (now: number) => `beacon:ids:d:${utcDayStamp(now)}`,
  month: (now: number) => `beacon:ids:m:${utcMonthStamp(now)}`,
  week: (now: number) => lastNDayStamps(now, 7).map((s) => `beacon:ids:d:${s}`),
  count: (event: BeaconEvent) => `beacon:count:${event}`,
  activated: "beacon:activated",
  versions: "beacon:versions",
  versionsOverflow: "beacon:versions-overflow",
  rateLimit: (bucket: string) => `beacon:rl:${bucket}`,
};

// What the owner-only summary endpoint returns. All aggregates, no per-user
// records: unique counts come from HyperLogLogs, so individual installIds
// are not even recoverable from storage.
export interface BeaconSummary {
  backend: "memory" | "redis";
  day: string;
  month: string;
  dau: number;
  wau: number;
  mau: number;
  activations: number;
  events: Record<BeaconEvent, number>;
  versions: Record<string, number>;
  // Launches whose NEW appVersion was refused by the field cap. Zero when
  // healthy; anything else means someone is minting versions and the hash
  // needs a look (see MAX_VERSION_FIELDS).
  versionsOverflow: number;
}
