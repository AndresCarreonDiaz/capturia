// Pure view logic for the public /metrics dashboard: validation of the two
// feeds it renders (the beacon summary and the GitHub releases list), the
// semver ordering for the versions table, download totalling, and the
// fetched-at label. No fetch, no DOM, no React, so every branch is unit
// testable and the client island stays a thin shell.

import { BEACON_EVENTS, type BeaconEvent, type BeaconSummary } from "./beacon";

// ------------------------------------------------------------- summary --

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Strict parse of the /api/beacon/summary response. The endpoint is ours,
// but the dashboard still refuses to render a shape it does not understand
// (a proxy error page, a half-broken deploy) rather than painting NaNs.
export function parseSummary(body: unknown): BeaconSummary | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.backend !== "memory" && record.backend !== "redis") return null;
  const { dau, wau, mau, activations, versionsOverflow } = record;
  if (
    !isCount(dau) ||
    !isCount(wau) ||
    !isCount(mau) ||
    !isCount(activations) ||
    !isCount(versionsOverflow)
  ) {
    return null;
  }
  if (typeof record.events !== "object" || record.events === null) return null;
  const eventsRaw = record.events as Record<string, unknown>;
  const events = {} as Record<BeaconEvent, number>;
  for (const event of BEACON_EVENTS) {
    if (!isCount(eventsRaw[event])) return null;
    events[event] = eventsRaw[event];
  }
  if (typeof record.versions !== "object" || record.versions === null) return null;
  const versions: Record<string, number> = {};
  for (const [version, count] of Object.entries(record.versions)) {
    if (isCount(count)) versions[version] = count;
  }
  return {
    backend: record.backend,
    day: typeof record.day === "string" ? record.day : "",
    month: typeof record.month === "string" ? record.month : "",
    dau,
    wau,
    mau,
    activations,
    events,
    versions,
    versionsOverflow,
  };
}

// ------------------------------------------------------------ versions --

// The beacon accepts x.y.z with an optional short prerelease suffix
// (lib/beacon.ts); this mirrors that shape for ordering.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

function parseSemver(version: string): { triple: [number, number, number]; pre: string | null } | null {
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  return {
    triple: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

// Semver descending: newest release first. A release outranks its own
// prereleases (0.2.0 before 0.2.0-beta); junk that somehow reached the hash
// (docs/telemetry.md covers manual cleanup) sinks below every real version.
export function compareVersionsDesc(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (!pa) return 1;
  if (!pb) return -1;
  for (let i = 0; i < 3; i++) {
    if (pa.triple[i] !== pb.triple[i]) return pb.triple[i] - pa.triple[i];
  }
  if ((pa.pre === null) !== (pb.pre === null)) return pa.pre === null ? -1 : 1;
  if (pa.pre !== null && pb.pre !== null && pa.pre !== pb.pre) {
    return pa.pre < pb.pre ? 1 : -1;
  }
  return 0;
}

export interface VersionRow {
  version: string;
  launches: number;
}

export function versionRows(versions: Record<string, number>): VersionRow[] {
  return Object.entries(versions)
    .map(([version, launches]) => ({ version, launches }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
}

// ------------------------------------------------------------ releases --

export interface ReleaseAssetRow {
  name: string;
  downloads: number;
}

export interface ReleaseRow {
  tag: string;
  publishedAt: string | null;
  assets: ReleaseAssetRow[];
  downloads: number;
}

// Parse of api.github.com/repos/<owner>/<repo>/releases: an array of
// releases, each with a tag, a publish date, and per-asset download counts.
// Entries without a usable tag are dropped (never invented); a non-array
// body (an error object, an HTML wall) refuses to parse. GitHub returns
// newest first and that order is kept.
export function parseReleases(body: unknown): ReleaseRow[] | null {
  if (!Array.isArray(body)) return null;
  const rows: ReleaseRow[] = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.tag_name !== "string" || record.tag_name === "") continue;
    const assets: ReleaseAssetRow[] = [];
    if (Array.isArray(record.assets)) {
      for (const asset of record.assets) {
        if (typeof asset !== "object" || asset === null) continue;
        const a = asset as Record<string, unknown>;
        if (typeof a.name !== "string") continue;
        assets.push({ name: a.name, downloads: isCount(a.download_count) ? a.download_count : 0 });
      }
    }
    rows.push({
      tag: record.tag_name,
      publishedAt: typeof record.published_at === "string" ? record.published_at : null,
      assets,
      downloads: assets.reduce((sum, a) => sum + a.downloads, 0),
    });
  }
  return rows;
}

export function totalDownloads(releases: ReleaseRow[]): number {
  return releases.reduce((sum, r) => sum + r.downloads, 0);
}

// "Jul 18, 2026" for the release header; UTC and a fixed locale so the
// label does not depend on where the dashboard is opened.
export function publishedLabel(publishedAt: string | null): string {
  const parsed = publishedAt === null ? NaN : Date.parse(publishedAt);
  if (Number.isNaN(parsed)) return "unpublished";
  return new Date(parsed).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ------------------------------------------------------------ freshness --

// The caption under the tiles: "just now", "42s ago", "3m ago", "2h ago".
// A clock skewed into the future reads as fresh, never as negative time.
export function fetchedAtLabel(fetchedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
