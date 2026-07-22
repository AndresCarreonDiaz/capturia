"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BeaconSummary } from "@/lib/beacon";
import {
  fetchedAtLabel,
  parseReleases,
  parseSummary,
  publishedLabel,
  totalDownloads,
  versionRows,
  type ReleaseRow,
} from "@/lib/metrics-view";

// The client half of /metrics (the server shell is app/metrics/page.tsx,
// same split as the landing page and components/landing/*). Two public
// feeds, zero credentials: the beacon summary (CDN-cached, aggregates only)
// and the GitHub releases list (CORS-enabled, the same download counts the
// releases page shows). All parsing and ordering is lib/metrics-view.ts;
// this file is fetch, state, and markup.

const RELEASES_API = "https://api.github.com/repos/AndresCarreonDiaz/capturia/releases";
// Data refetches once it is a minute old; a 10s heartbeat keeps the
// "updated Ns ago" caption honest between refetches. Both exist only while
// the tab is visible: a hidden tab holds no timer at all.
const REFRESH_MS = 60_000;
const HEARTBEAT_MS = 10_000;

type SummaryState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; summary: BeaconSummary };

type ReleasesState =
  | { kind: "loading" }
  | { kind: "rate-limited" }
  | { kind: "error"; message: string }
  | { kind: "ok"; releases: ReleaseRow[] };

async function loadSummary(): Promise<SummaryState> {
  try {
    const res = await fetch("/api/beacon/summary");
    if (!res.ok) return { kind: "error", message: `the summary endpoint answered ${res.status}` };
    const summary = parseSummary(await res.json());
    return summary
      ? { kind: "ok", summary }
      : { kind: "error", message: "the summary endpoint answered an unexpected shape" };
  } catch {
    return { kind: "error", message: "the summary endpoint did not answer" };
  }
}

async function loadReleases(): Promise<ReleasesState> {
  try {
    const res = await fetch(RELEASES_API);
    // Unauthenticated GitHub API quota is per IP; a shared network can
    // exhaust it. Not an error wall, just a wait.
    if (res.status === 403 || res.status === 429) return { kind: "rate-limited" };
    if (!res.ok) return { kind: "error", message: `GitHub answered ${res.status}` };
    const releases = parseReleases(await res.json());
    return releases
      ? { kind: "ok", releases }
      : { kind: "error", message: "GitHub answered an unexpected shape" };
  } catch {
    return { kind: "error", message: "GitHub did not answer" };
  }
}

export default function MetricsDashboard() {
  const [summary, setSummary] = useState<SummaryState>({ kind: "loading" });
  const [releases, setReleases] = useState<ReleasesState>({ kind: "loading" });
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // Refs mirror the in-flight and freshness state for the heartbeat
  // callback, which must read current values without re-arming the timer.
  const inFlight = useRef(false);
  const fetchedAtRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    const [s, r] = await Promise.all([loadSummary(), loadReleases()]);
    const t = Date.now();
    inFlight.current = false;
    fetchedAtRef.current = t;
    setSummary(s);
    setReleases(r);
    setFetchedAt(t);
    setNow(t);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const beat = () => {
      const t = Date.now();
      setNow(t);
      const at = fetchedAtRef.current;
      if (at === null || t - at >= REFRESH_MS) void load();
    };
    // The timer exists only while the tab is visible (no churn while
    // hidden); coming back beats immediately, so the first load happens on
    // mount and a stale tab catches up the moment it is looked at.
    const sync = () => {
      if (document.visibilityState === "visible") {
        beat();
        if (timer === null) timer = window.setInterval(beat, HEARTBEAT_MS);
      } else if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="mt-10 sm:mt-12 space-y-14 sm:space-y-16">
      {/* Freshness strip: backend, fetched-at, and the manual refresh */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] tracking-[0.2em] uppercase">
          {summary.kind === "ok" &&
            (summary.summary.backend === "memory" ? (
              <span className="text-[var(--amber-cue)]">
                backend: memory · numbers reset on cold starts
              </span>
            ) : (
              <span className="text-[var(--studio-fade)]">backend: redis</span>
            ))}
          {fetchedAt !== null && (
            <span className="text-[var(--studio-fade)]">
              updated {fetchedAtLabel(fetchedAt, now)}
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          disabled={refreshing}
          className="ghost-btn rounded-full px-5 py-2 font-mono text-[10px] tracking-[0.2em] uppercase disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Beacon aggregates */}
      <section>
        <SectionRow eyebrow="Desktop beacon" title="Installs, counted anonymously." />

        {summary.kind === "loading" && <LoadingCard label="Reading the beacon summary…" />}
        {summary.kind === "error" && (
          <ErrorCard label={`Could not load the beacon summary: ${summary.message}.`} />
        )}

        {summary.kind === "ok" && (
          <>
            <div className="mt-7 grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
              <StatTile label="MAU" hint="unique installs this month" value={summary.summary.mau} />
              <StatTile label="WAU" hint="unique installs, trailing 7 days" value={summary.summary.wau} />
              <StatTile label="DAU" hint="unique installs today" value={summary.summary.dau} />
              <StatTile
                label="Camera activations"
                hint="installs that ever installed the camera"
                value={summary.summary.activations}
                accent
              />
            </div>

            <div className="mt-4 product-card rounded-2xl px-6 py-5 flex flex-wrap items-center gap-x-10 gap-y-3">
              <EventCount label="Launches" value={summary.summary.events.launch} />
              <EventCount label="Camera installed" value={summary.summary.events["camera-installed"]} />
            </div>

            <VersionsTable
              versions={summary.summary.versions}
              overflow={summary.summary.versionsOverflow}
            />
          </>
        )}
      </section>

      {/* GitHub downloads */}
      <section>
        <SectionRow eyebrow="GitHub releases" title="Downloads, on the public record." />

        {releases.kind === "loading" && <LoadingCard label="Counting release downloads…" />}
        {releases.kind === "rate-limited" && (
          <div className="mt-7 product-card rounded-2xl px-6 py-5">
            <p className="text-[var(--amber-cue)] text-[14px]">
              GitHub rate limit, try again in a bit.
            </p>
          </div>
        )}
        {releases.kind === "error" && (
          <ErrorCard label={`Could not load the release downloads: ${releases.message}.`} />
        )}

        {releases.kind === "ok" && (
          <div className="mt-7 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 sm:gap-5">
            <StatTile
              label="Total downloads"
              hint="all assets, all releases"
              value={totalDownloads(releases.releases)}
              accent
            />
            <div className="space-y-4">
              {releases.releases.length === 0 && (
                <div className="product-card rounded-2xl px-6 py-5 text-[var(--studio-graphite)] text-[14px]">
                  No releases published yet.
                </div>
              )}
              {releases.releases.map((release) => (
                <ReleaseCard key={release.tag} release={release} />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ───── presentational bits ───── */

function SectionRow({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
          {eyebrow}
        </span>
        <span className="h-px flex-1 bg-white/[0.08]" />
      </div>
      <h2 className="display-serif mt-4 text-[clamp(1.6rem,3.5vw,2.4rem)] text-[var(--studio-ink)]">
        {title}
      </h2>
    </div>
  );
}

function StatTile({
  label,
  hint,
  value,
  accent = false,
}: {
  label: string;
  hint: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="product-card rounded-2xl p-6">
      <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
        {label}
      </p>
      <p
        className={`display-serif mt-3 text-4xl sm:text-5xl tabular-nums ${
          accent ? "text-[var(--phosphor)]" : "text-[var(--studio-ink)]"
        }`}
      >
        {value.toLocaleString("en-US")}
      </p>
      <p className="mt-2.5 text-[var(--studio-graphite)] text-[12.5px] leading-relaxed">{hint}</p>
    </div>
  );
}

function EventCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
        {label}
      </span>
      <span className="font-mono text-[15px] tabular-nums text-[var(--studio-ink)]">
        {value.toLocaleString("en-US")}
      </span>
    </div>
  );
}

function VersionsTable({
  versions,
  overflow,
}: {
  versions: Record<string, number>;
  overflow: number;
}) {
  const rows = versionRows(versions);
  if (rows.length === 0 && overflow === 0) return null;
  return (
    <div className="mt-4 product-card rounded-2xl overflow-hidden">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-white/[0.08]">
            <th className="px-6 py-3.5 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)] font-normal">
              Version
            </th>
            <th className="px-6 py-3.5 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)] font-normal text-right">
              Launches
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.version} className="border-b border-white/[0.04] last:border-b-0">
              <td className="px-6 py-3 font-mono text-[13px] text-[var(--studio-ink)]">
                {row.version}
              </td>
              <td className="px-6 py-3 font-mono text-[13px] tabular-nums text-[var(--studio-graphite)] text-right">
                {row.launches.toLocaleString("en-US")}
              </td>
            </tr>
          ))}
          {overflow > 0 && (
            <tr>
              <td className="px-6 py-3 font-mono text-[13px] text-[var(--amber-cue)]">
                past the version cap
              </td>
              <td className="px-6 py-3 font-mono text-[13px] tabular-nums text-[var(--amber-cue)] text-right">
                {overflow.toLocaleString("en-US")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ReleaseCard({ release }: { release: ReleaseRow }) {
  return (
    <div className="product-card rounded-2xl px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[14px] text-[var(--studio-ink)]">{release.tag}</span>
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
            {publishedLabel(release.publishedAt)}
          </span>
        </div>
        <span className="font-mono text-[13px] tabular-nums text-[var(--phosphor)]">
          {release.downloads.toLocaleString("en-US")}
        </span>
      </div>
      {release.assets.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {release.assets.map((asset) => (
            <li key={asset.name} className="flex items-baseline justify-between gap-4">
              <span className="font-mono text-[12px] text-[var(--studio-graphite)] truncate">
                {asset.name}
              </span>
              <span className="font-mono text-[12px] tabular-nums text-[var(--studio-graphite)]">
                {asset.downloads.toLocaleString("en-US")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoadingCard({ label }: { label: string }) {
  return (
    <div className="mt-7 product-card rounded-2xl px-6 py-5">
      <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
        {label}
      </p>
    </div>
  );
}

function ErrorCard({ label }: { label: string }) {
  return (
    <div className="mt-7 product-card rounded-2xl px-6 py-5">
      <p className="text-[var(--tally)] text-[14px]">{label}</p>
    </div>
  );
}
