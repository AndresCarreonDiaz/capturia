import type { Metadata } from "next";
import Link from "next/link";
import { CapturiaLogo } from "@/components/landing/Brand";
import MetricsDashboard from "@/components/metrics/MetricsDashboard";

/* Public adoption dashboard. Unlisted by design: nothing in the landing nav
   or footer points here, it is reachable by URL and noindexed. The numbers
   are public by decision (docs/telemetry.md): the beacon stores aggregate
   counts that cannot identify anyone, and the download counts are the same
   ones GitHub already publishes on the releases page. Server shell only;
   fetching, refresh, and state live in the client island, the same split
   the landing uses (app/page.tsx + components/landing/*). */

const TELEMETRY_DOC =
  "https://github.com/AndresCarreonDiaz/capturia/blob/main/docs/telemetry.md";

export const metadata: Metadata = {
  title: "Capturia metrics",
  description:
    "Capturia adoption in public: anonymous beacon aggregates and GitHub release download counts.",
  robots: { index: false, follow: false },
};

export default function MetricsPage() {
  return (
    <main className="min-h-screen bg-[var(--studio-black)] text-[var(--studio-ink)] selection:bg-[var(--phosphor)]/30 selection:text-white">
      <header className="sticky top-0 z-50 backdrop-blur-md bg-[var(--studio-black)]/80 border-b border-white/[0.06]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <Link
            href="/"
            aria-label="Capturia home"
            className="inline-flex text-[var(--studio-ink)] hover:opacity-90 transition-opacity"
          >
            <CapturiaLogo style={{ height: 24, width: "auto" }} />
          </Link>
          <Link href="/" className="text-[13px] text-[var(--studio-graphite)] hover:text-white transition-colors">
            Back to the site
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 sm:px-6 pt-14 sm:pt-20 pb-20 sm:pb-24">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
            Metrics
          </span>
          <span className="h-px flex-1 bg-white/[0.08]" />
        </div>
        <h1 className="display-serif mt-4 text-[clamp(2.4rem,6vw,4rem)] leading-[1.04] text-[var(--studio-ink)]">
          Adoption, <span className="italic text-[var(--phosphor)]">in public</span>.
        </h1>
        <p className="mt-4 max-w-2xl text-[var(--studio-graphite)] text-[14.5px] leading-relaxed">
          Every number on this page is an aggregate: how many, never who. The
          desktop beacon stores unique installs in HyperLogLogs that cannot
          name a single install, and the download counts are the ones GitHub
          publishes for every release.{" "}
          <a href={TELEMETRY_DOC} target="_blank" rel="noopener noreferrer" className="cue-link">
            docs/telemetry.md
          </a>{" "}
          shows the exact bytes behind each count.
        </p>

        <MetricsDashboard />
      </div>

      <footer className="border-t border-white/[0.06] bg-[var(--studio-mist)]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 flex flex-wrap items-center gap-x-6 gap-y-2.5 text-[13px] text-[var(--studio-graphite)]">
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
          <Link href="/privacy" className="hover:text-white transition-colors">
            Privacy
          </Link>
          <a
            href="https://github.com/AndresCarreonDiaz/capturia"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
        </div>
      </footer>
    </main>
  );
}
