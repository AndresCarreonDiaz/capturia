import type { ReactNode } from "react";
import Link from "next/link";
import { CapturiaLogo } from "@/components/landing/Brand";

// Shared shell for the legal pages (/privacy, /terms): the landing's studio
// look reduced to a readable single-column document. Server component; the
// pages are static text, so no client code belongs here.

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 sm:mt-12">
      <h2 className="display-serif text-[var(--studio-ink)] text-2xl sm:text-3xl">{title}</h2>
      <div className="mt-3.5 space-y-3.5 text-[var(--studio-graphite)] text-[14.5px] leading-relaxed">
        {children}
      </div>
    </section>
  );
}

export default function LegalShell({
  eyebrow,
  title,
  lastUpdated,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[var(--studio-black)] text-[var(--studio-ink)] selection:bg-[var(--phosphor)]/30 selection:text-white">
      <header className="sticky top-0 z-50 backdrop-blur-md bg-[var(--studio-black)]/80 border-b border-white/[0.06]">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
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

      <article className="mx-auto max-w-3xl px-4 sm:px-6 pt-14 sm:pt-20 pb-20 sm:pb-24">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
            {eyebrow}
          </span>
          <span className="h-px flex-1 bg-white/[0.08]" />
        </div>
        <h1 className="display-serif mt-4 text-[clamp(2.4rem,6vw,4rem)] leading-[1.04] text-[var(--studio-ink)]">
          {title}
        </h1>
        <p className="mt-4 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          Last updated: {lastUpdated}
        </p>
        {children}
      </article>

      <footer className="border-t border-white/[0.06] bg-[var(--studio-mist)]">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 flex flex-wrap items-center gap-x-6 gap-y-2.5 text-[13px] text-[var(--studio-graphite)]">
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
          <Link href="/privacy" className="hover:text-white transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-white transition-colors">
            Terms
          </Link>
          <a href="mailto:capturia@andresio.com" className="hover:text-white transition-colors">
            capturia@andresio.com
          </a>
        </div>
      </footer>
    </main>
  );
}
