import Link from "next/link";
import LiveDemo from "@/components/landing/LiveDemo";
import SlotPreview, { type SlotCode } from "@/components/landing/SlotPreview";
import { CapturiaLogo } from "@/components/landing/Brand";

/* ─────────────────────────────────────────────────────────────
   Capturia landing. A broadcast-magazine page. The hero IS the
   product, looping. Sections after are issues of a technical
   journal: catalog, wiring, what's next.
   ───────────────────────────────────────────────────────────── */

export default function Landing() {
  return (
    <main className="min-h-screen bg-[var(--studio-black)] text-[var(--studio-ink)] selection:bg-[var(--phosphor)]/30 selection:text-white">
      <TallyBar />
      <Hero />
      <PullQuote />
      <IssueCatalog />
      <IssueWiring />
      <IssueRoadmap />
      <CueClose />
      <SiteFooter />
    </main>
  );
}

/* ───── 1. Sticky tally bar across the very top of the page ───── */

function TallyBar() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-[var(--studio-black)]/85 border-b border-white/[0.06]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 h-12 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 sm:gap-5 min-w-0">
          {/* Brand mark + wordmark, links to top */}
          <Link
            href="/"
            aria-label="Capturia home"
            className="flex items-center text-[var(--studio-ink)] hover:opacity-90 transition-opacity"
          >
            <CapturiaLogo style={{ height: 22, width: "auto" }} />
          </Link>

          {/* Vertical hairline divider */}
          <span aria-hidden className="hidden sm:inline-block w-px h-4 bg-white/10" />

          {/* On-Air status + episode tag */}
          <span className="hidden sm:flex items-center gap-2 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--tally)] tally-pulse" />
            <span className="text-[var(--tally)]">On&nbsp;Air</span>
            <span className="text-[var(--studio-fade)]">·</span>
            <span>EP&nbsp;001 · voice → screen</span>
          </span>
        </div>

        <nav className="flex items-center gap-1 sm:gap-2 font-mono text-[10px] tracking-[0.22em] uppercase">
          <Link
            href="/studio"
            className="px-2.5 py-1 text-[var(--phosphor)] hover:text-white transition-colors"
          >
            Cue&nbsp;the&nbsp;studio →
          </Link>
        </nav>
      </div>
    </header>
  );
}

/* ───── 2. Hero. Editorial title + the live looping demo ───── */

function Hero() {
  return (
    <section className="relative">
      <div aria-hidden className="absolute inset-0 studio-grid-bg opacity-40 pointer-events-none" />
      <div aria-hidden className="grain-overlay" />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-12 sm:pt-16 lg:pt-20 pb-10 sm:pb-14 relative">
        {/* Eyebrow strip */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          <span>Issue&nbsp;001</span>
          <span>·</span>
          <span>May&nbsp;2026</span>
          <span>·</span>
          <span className="text-[var(--phosphor)]">1st&nbsp;Place · Generative&nbsp;UI&nbsp;Hackathon</span>
        </div>

        {/* Editorial headline */}
        <h1 className="display-serif mt-5 sm:mt-7 text-[clamp(3.25rem,9vw,8rem)] text-[var(--studio-ink)] reveal-up">
          The chat is{" "}
          <span className="italic text-[var(--phosphor)] [text-shadow:0_0_30px_rgba(82,255,139,0.18)]">
            the screen.
          </span>
        </h1>

        {/* Subline */}
        <p className="mt-6 sm:mt-7 max-w-2xl text-[var(--studio-graphite)] text-base sm:text-lg leading-relaxed reveal-up [animation-delay:120ms]">
          You speak. An AI agent composes broadcast-grade overlays directly onto
          the video: lower thirds, sparklines, big counters, tickers. In under
          a second. There is no chat sidebar. No template gallery. No graphics
          operator. The utterance is the render.
        </p>

        {/* Hero demo */}
        <div className="mt-10 sm:mt-14 reveal-up [animation-delay:240ms]">
          <LiveDemo />
        </div>

        {/* Hero CTA + meta */}
        <div className="mt-10 sm:mt-12 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
          <Link
            href="/studio"
            className="cue-btn group inline-flex items-center gap-3 px-6 py-3 self-start font-mono text-[12px] tracking-[0.22em] uppercase"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--phosphor)] group-hover:scale-125 transition-transform" />
            Cue&nbsp;the&nbsp;studio
            <span className="text-[var(--phosphor)]">→</span>
          </Link>

          <p className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
            Free · no signup · Chrome / Edge for voice
          </p>
        </div>
      </div>
    </section>
  );
}

/* ───── 3. Pull quote. A single editorial sentence as breather ───── */

function PullQuote() {
  return (
    <section className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-5xl px-6 sm:px-8 py-16 sm:py-20">
        <p className="display-serif text-[var(--studio-ink)] text-[clamp(1.6rem,3.6vw,2.7rem)] leading-[1.2]">
          Every utterance is either a{" "}
          <span className="italic text-[var(--signal)]">tool call that changes the screen</span>
          , or silence. The agent never replies in prose. It composes.
        </p>
        <div className="mt-8 fade-rule" />
        <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-6 font-mono text-[11px]">
          <Stat label="Components" value="12" accent="phosphor" />
          <Stat label="Tools" value="06" accent="signal" />
          <Stat label="End-to-end" value="<1s" accent="amber" />
          <Stat label="Cost / utterance" value="~$0.0001" accent="magenta" />
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "phosphor" | "signal" | "amber" | "magenta";
}) {
  const color =
    accent === "phosphor"
      ? "var(--phosphor)"
      : accent === "signal"
      ? "var(--signal)"
      : accent === "amber"
      ? "var(--amber-cue)"
      : "var(--magenta-sweep)";
  return (
    <div>
      <div className="display-serif tabular-nums text-[clamp(1.75rem,3vw,2.5rem)]" style={{ color }}>
        {value}
      </div>
      <div className="mt-1 text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
        {label}
      </div>
    </div>
  );
}

/* ───── 4. Issue 001. The Catalog ───── */

interface Slot {
  code: SlotCode;
  name: string;
  blurb: string;
  accent: "phosphor" | "signal" | "amber" | "magenta" | "tally" | "graphite";
}

const SLOTS: Slot[] = [
  { code: "MTR", name: "MetricsPanel",     blurb: "KPI card with sparklines, count-up tween, green/red row flash.", accent: "signal" },
  { code: "BCT", name: "BigCounter",       blurb: "Huge animated number. Per-digit roll. Milestone halo at 1k, 10k, 100k.", accent: "phosphor" },
  { code: "RNG", name: "StatRing",         blurb: "Radial donut, cyan/violet/pink stroke, sparkle dots at 85% and up.", accent: "signal" },
  { code: "PRG", name: "ProgressBar",      blurb: "Cycling-hue fill, glowing leading bead, emerald pulse at 100%.", accent: "phosphor" },
  { code: "CHT", name: "FloatingChart",    blurb: "Sparkline or bars. Gradient area-fill. Live-growing series.", accent: "signal" },
  { code: "TLN", name: "Timeline",         blurb: "Horizontal stepper. Halo ripple on the active step.", accent: "amber" },
  { code: "LTH", name: "LowerThird",       blurb: "Broadcast name bar. Typewriter reveal. Underline sweep.", accent: "amber" },
  { code: "KWD", name: "KeywordHighlight", blurb: "Chips stagger in. Rotating palette. Shimmer sweep at mount.", accent: "magenta" },
  { code: "BDG", name: "LiveBadge",        blurb: "Pulsing pill with a ring ripple radiating outward.", accent: "tally" },
  { code: "TKR", name: "Ticker",           blurb: "Cable-news scroll. Alternating dot colors. Breathing sheen.", accent: "magenta" },
  { code: "BUB", name: "ChatBubble",       blurb: "Speech bubble. 3-dot typing indicator. Typewriter text.", accent: "graphite" },
  { code: "LBX", name: "Letterbox",        blurb: "Cinematic black bars that slide in from the screen edges.", accent: "graphite" },
];

function accentColor(a: Slot["accent"]) {
  switch (a) {
    case "phosphor": return "var(--phosphor)";
    case "signal":   return "var(--signal)";
    case "amber":    return "var(--amber-cue)";
    case "magenta":  return "var(--magenta-sweep)";
    case "tally":    return "var(--tally)";
    case "graphite": return "var(--studio-graphite)";
  }
}

function IssueCatalog() {
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
      <SectionHead
        issue="Issue 001"
        title="The Catalog"
        kicker="Twelve typed components. The agent sees them all. It composes."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 mt-12 sm:mt-14">
        {SLOTS.map((s, i) => (
          <SlotCard key={s.code} slot={s} index={i} />
        ))}
      </div>

      <p className="mt-10 max-w-3xl text-[var(--studio-graphite)] text-[15px] leading-relaxed">
        Each slot is a Zod schema in <code className="font-mono text-[var(--studio-ink)]">lib/catalog.ts</code>{" "}
        and a React component in <code className="font-mono text-[var(--studio-ink)]">components/overlays/</code>.
        The schemas are the single source of truth for the system prompt and the renderer at once. Same
        contract, both sides.
      </p>
    </section>
  );
}

function SlotCard({ slot, index }: { slot: Slot; index: number }) {
  const color = accentColor(slot.accent);
  return (
    <div className="slot-card flex flex-col overflow-hidden">
      {/* Live preview monitor */}
      <SlotPreview code={slot.code} />

      {/* Metadata */}
      <div className="p-4 sm:p-5 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <span
            className="display-serif italic text-3xl sm:text-4xl tabular-nums leading-none"
            style={{ color }}
          >
            {slot.code}
          </span>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
              {String(index + 1).padStart(2, "0")} / 12
            </span>
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: color, boxShadow: `0 0 10px ${color}` }}
            />
          </div>
        </div>

        <div className="mt-1 text-[var(--studio-ink)] text-[13px] sm:text-[14px] font-medium">
          {slot.name}
        </div>
        <div className="text-[var(--studio-graphite)] text-[12px] leading-snug">
          {slot.blurb}
        </div>
      </div>
    </div>
  );
}

/* ───── 5. Issue 002. The Wiring ───── */

function IssueWiring() {
  return (
    <section className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
        <SectionHead
          issue="Issue 002"
          title="The Wiring"
          kicker="One model call. One tool call. One React state update. About 150ms TTFT."
        />

        <div className="mt-12 grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-16">
          {/* Prose column */}
          <div className="space-y-6 text-[var(--studio-graphite)] text-[15px] leading-relaxed">
            <p>
              Voice or typed text becomes an{" "}
              <span className="text-[var(--studio-ink)]">AG-UI shared-state session</span>.
              The agent (Gemini 2.5 Flash-Lite,{" "}
              <code className="font-mono text-[var(--studio-ink)]">maxSteps: 1</code>,
              temperature zero) sees a typed catalog and decides what to render where. It returns a
              single tool call. CopilotKit dispatches it. React state mutates. The overlay layer
              reconciles with a 60-millisecond staggered entrance per new item.
            </p>
            <p>
              No DOM strings. No prose responses. No retries. The agent picks{" "}
              <code className="font-mono text-[var(--studio-ink)]">bump_metric</code> over{" "}
              <code className="font-mono text-[var(--studio-ink)]">modify_overlay</code> when it can.
              That&apos;s where the live feel comes from. Values count up; rows flash; charts append
              points instead of being rebuilt.
            </p>
            <p>
              Agent JSON is untrusted at the edge.{" "}
              <code className="font-mono text-[var(--studio-ink)]">normalizeProps()</code> coerces
              malformed shapes (Gemini occasionally returns{" "}
              <code className="font-mono text-[var(--studio-ink)]">[{"{"}text: &ldquo;x&rdquo;{"}"}]</code>{" "}
              instead of <code className="font-mono text-[var(--studio-ink)]">[&ldquo;x&rdquo;]</code>)
              before they hit components. Each renderer is also defensively iterable. Partial props
              can&apos;t crash the tree.
            </p>
          </div>

          {/* Tech stack + diagram column */}
          <div className="space-y-10">
            <StackList />
            <ArchitectureFlow />
          </div>
        </div>
      </div>
    </section>
  );
}

function StackList() {
  const rows: Array<[string, React.ReactNode]> = [
    ["Runtime",   <>CopilotKit&nbsp;1.57 · <span className="text-[var(--studio-graphite)]">@copilotkit/runtime/v2 · single-route</span></>],
    ["Model",     <>Gemini&nbsp;2.5&nbsp;Flash-Lite · <span className="text-[var(--studio-graphite)]">@ai-sdk/google · maxSteps 1 · temp 0</span></>],
    ["Catalog",   <>A2UI · <span className="text-[var(--studio-graphite)]">createCatalog + Zod schemas</span></>],
    ["Framework", <>Next.js&nbsp;16.2 · React&nbsp;19.2 · <span className="text-[var(--studio-graphite)]">Tailwind v4 · TypeScript</span></>],
    ["Voice",     <>Web&nbsp;Speech&nbsp;API · <span className="text-[var(--studio-graphite)]">600ms restart debounce</span></>],
    ["Record",    <>MediaRecorder + getDisplayMedia · <span className="text-[var(--studio-graphite)]">VP9 + Opus webm</span></>],
  ];

  return (
    <div className="border border-white/[0.06] bg-[var(--studio-black)]/60">
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          Tech&nbsp;stack
        </span>
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          v0.1.0
        </span>
      </div>
      <dl className="divide-y divide-white/[0.05]">
        {rows.map(([label, value]) => (
          <div key={label} className="px-4 py-3 grid grid-cols-[7rem_1fr] gap-4 items-baseline">
            <dt className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
              {label}
            </dt>
            <dd className="font-mono text-[12px] text-[var(--studio-ink)] leading-snug">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ArchitectureFlow() {
  const lines = [
    "  voice / typing",
    "       │",
    "       ▼",
    "  AG-UI session  ───►  Gemini 2.5 Flash-Lite",
    "       ▲                          │",
    "       │                          ▼",
    "  React state  ◄── normalize ── tool call",
    "       │",
    "       ▼",
    "  OverlayLayer  ( 60ms stagger · FLIP transitions )",
    "       │",
    "       ▼",
    "  composited frame  ●  on air",
  ];
  return (
    <div className="border border-white/[0.06] bg-[var(--studio-black)]/60">
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          Signal&nbsp;path
        </span>
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--phosphor)]">
          live
        </span>
      </div>
      <pre className="px-4 py-4 font-mono text-[11.5px] leading-[1.55] text-[var(--studio-ink)] overflow-x-auto">
        {lines.join("\n")}
      </pre>
    </div>
  );
}

/* ───── 6. Issue 003. What's Next: Virtual Camera ───── */

function IssueRoadmap() {
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
      <SectionHead
        issue="Issue 003"
        title={
          <>
            Where this{" "}
            <span className="italic text-[var(--signal)]">might go</span>.
          </>
        }
        kicker="The web version got the loop running. After that, here's a direction that sounds fun to chase."
      />

      <div className="mt-12 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-10 lg:gap-16">
        <div className="space-y-6 text-[var(--studio-graphite)] text-[15px] leading-relaxed">
          <p>
            People keep asking about Zoom plugins. The more interesting move might be
            skipping plugins entirely and shipping Capturia as a{" "}
            <span className="text-[var(--studio-ink)]">desktop camera device</span>{" "}
            instead. A macOS Camera Extension first, with a Windows DirectShow filter as a
            possible follow-up, publishing the composited webcam-plus-overlays feed to the
            operating system. Every video tool would see a{" "}
            <span className="text-[var(--studio-ink)]">Capturia Camera</span>{" "}
            in its dropdown, the same way Snap Camera and NVIDIA Broadcast show up today. No
            per-platform plugin work. Just a system-level video source.
          </p>
          <p>
            The existing web codebase (twelve components, agent, Zod catalog, overlay layer,
            animations) would slot in as the{" "}
            <span className="text-[var(--studio-ink)]">renderer inside the desktop wrapper</span>,
            no rewrite needed. Tauri or Electron on the outside, a hidden canvas at 30fps in
            the middle, a CoreMediaIO extension on macOS to publish the feed. Maybe Deepgram
            for voice once we&apos;re outside the browser, which would clear up a couple of
            annoyances in one move. A few weeks of focus for a Mac MVP, probably. Longer if
            signed, notarized, cross-platform end up mattering. We&apos;ll see how it feels.
          </p>
        </div>

        <Roadmap />
      </div>
    </section>
  );
}

function Roadmap() {
  const columns: Array<{
    title: string;
    items: Array<{ label: string; status: "shipped" | "queued" }>;
  }> = [
    {
      title: "Now",
      items: [
        { label: "Web studio",      status: "shipped" },
        { label: "AG-UI loop",      status: "shipped" },
        { label: "12 components",   status: "shipped" },
        { label: "Voice + typing",  status: "shipped" },
      ],
    },
    {
      title: "Q3 · 2026",
      items: [
        { label: "Tauri shell",     status: "queued" },
        { label: "macOS camera ext",status: "queued" },
        { label: "Deepgram voice",  status: "queued" },
        { label: "Push-to-talk",    status: "queued" },
      ],
    },
    {
      title: "Q4 · 2026",
      items: [
        { label: "Windows DS filter", status: "queued" },
        { label: "Signed + notarized",status: "queued" },
        { label: "Zoom / Meet auto",  status: "queued" },
        { label: "Presets",           status: "queued" },
      ],
    },
    {
      title: "2027",
      items: [
        { label: "MCP data feeds",  status: "queued" },
        { label: "Sponsor blocks",  status: "queued" },
        { label: "Body tracking",   status: "queued" },
        { label: "Extension SDK",   status: "queued" },
      ],
    },
  ];

  return (
    <div className="border border-white/[0.06] bg-[var(--studio-mist)]/40">
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          Roadmap
        </span>
        <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          ■ shipped · ◌ queued
        </span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-white/[0.05]">
        {columns.map((col) => (
          <div key={col.title} className="p-4">
            <div className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-graphite)]">
              {col.title}
            </div>
            <ul className="mt-3 space-y-2">
              {col.items.map((it) => (
                <li
                  key={it.label}
                  className="flex items-start gap-2 font-mono text-[11px] leading-snug"
                >
                  <span
                    className={`mt-1.5 ${
                      it.status === "shipped"
                        ? "text-[var(--phosphor)]"
                        : "text-[var(--studio-fade)]"
                    }`}
                  >
                    {it.status === "shipped" ? "■" : "◌"}
                  </span>
                  <span
                    className={
                      it.status === "shipped"
                        ? "text-[var(--studio-ink)]"
                        : "text-[var(--studio-graphite)]"
                    }
                  >
                    {it.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───── 7. Closing cue ───── */

function CueClose() {
  return (
    <section className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-24 sm:py-32 text-center">
        <div className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          Cue · ready · 00:00:00
        </div>
        <h2 className="display-serif mt-6 text-[clamp(2.4rem,6vw,5rem)] leading-none">
          Open the studio.{" "}
          <span className="italic text-[var(--phosphor)]">Speak to it.</span>
        </h2>
        <p className="mt-6 text-[var(--studio-graphite)] max-w-xl mx-auto">
          The fastest way to feel what Capturia is, is to talk at it for thirty seconds.
          Free. No signup. Voice works in Chrome and Edge.
        </p>

        <div className="mt-10 inline-flex flex-col items-center gap-3">
          <Link
            href="/studio"
            className="cue-btn group inline-flex items-center gap-3 px-8 py-4 font-mono text-[13px] tracking-[0.22em] uppercase"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--phosphor)] group-hover:scale-125 transition-transform" />
            Cue&nbsp;the&nbsp;studio
            <span className="text-[var(--phosphor)]">→</span>
          </Link>
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
            Bring your webcam · headphones recommended
          </span>
        </div>
      </div>
    </section>
  );
}

/* ───── 8. Footer ───── */

function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-6 items-end">
        <div>
          <Link
            href="/"
            aria-label="Capturia home"
            className="inline-flex text-[var(--studio-ink)] hover:opacity-90 transition-opacity"
          >
            <CapturiaLogo style={{ height: 36, width: "auto" }} />
          </Link>
          <div className="mt-3 font-mono text-[11px] text-[var(--studio-graphite)] leading-relaxed">
            Built solo by Andres Carreon · founder, Bubblio · 1st place at the Generative UI Global Hackathon · May 2026
          </div>
        </div>

        <nav className="flex items-center gap-1 font-mono text-[10px] tracking-[0.22em] uppercase">
          <Link
            href="/studio"
            className="px-2.5 py-1 text-[var(--phosphor)] hover:text-white transition-colors"
          >
            Studio →
          </Link>
        </nav>
      </div>

      <div className="border-t border-white/[0.04]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-9 flex items-center justify-between font-mono text-[9px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          <span>Stream&nbsp;idle · 00:00:00</span>
          <span>EOL · ◇</span>
        </div>
      </div>
    </footer>
  );
}

/* ───── shared: section heading block ───── */

function SectionHead({
  issue,
  title,
  kicker,
}: {
  issue: string;
  title: React.ReactNode;
  kicker?: string;
}) {
  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          {issue}
        </span>
        <span className="h-px flex-1 bg-white/[0.08]" />
      </div>
      <h2 className="display-serif mt-4 text-[clamp(2rem,5vw,3.75rem)] leading-[1.02] text-[var(--studio-ink)]">
        {title}
      </h2>
      {kicker && (
        <p className="mt-4 text-[var(--studio-graphite)] text-[15px] sm:text-[16px] max-w-2xl leading-relaxed">
          {kicker}
        </p>
      )}
    </div>
  );
}
