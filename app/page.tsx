import Link from "next/link";
import LiveDemo from "@/components/landing/LiveDemo";
import SlotPreview, { type SlotCode } from "@/components/landing/SlotPreview";
import { CapturiaLogo } from "@/components/landing/Brand";

/* ─────────────────────────────────────────────────────────────
   Capturia landing. Direction A, "On Air": a confident consumer
   product launch page. Broadcast DNA kept as polish (tally red,
   phosphor green, the live-on-air feeling). Every word written for
   founders and speakers, not crew or developers. Server component.
   ───────────────────────────────────────────────────────────── */

const GITHUB = "https://github.com/AndresCarreonDiaz/capturia";
const LICENSE = "https://github.com/AndresCarreonDiaz/capturia/blob/main/LICENSE";

export default function Landing() {
  return (
    <main className="min-h-screen bg-[var(--studio-black)] text-[var(--studio-ink)] selection:bg-[var(--phosphor)]/30 selection:text-white">
      <TopNav />
      <Hero />
      <HumanCaption />
      <HowItWorks />
      <OnScreen />
      <UseCases />
      <Pricing />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}

/* ───── 1. Slim sticky nav ───── */

function TopNav() {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-md bg-[var(--studio-black)]/80 border-b border-white/[0.06]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
        <Link
          href="/"
          aria-label="Capturia home"
          className="flex items-center gap-3 text-[var(--studio-ink)] hover:opacity-90 transition-opacity"
        >
          <CapturiaLogo style={{ height: 24, width: "auto" }} />
          <span className="hidden sm:flex items-center gap-1.5 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--tally)] tally-pulse" />
            <span className="text-[var(--tally)]">On&nbsp;Air</span>
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-7 text-[13px] text-[var(--studio-graphite)]">
          <a href="#how" className="hover:text-white transition-colors">How it works</a>
          <a href="#use-cases" className="hover:text-white transition-colors">Use cases</a>
          <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline px-2 py-1 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)] hover:text-white transition-colors"
          >
            Source
          </a>
          <Link
            href="/studio"
            className="cta-solid inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
          >
            Try it free
            <span aria-hidden>→</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ───── 2. Hero ───── */

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 studio-grid-bg opacity-[0.15] pointer-events-none" />
      <div aria-hidden className="grain-overlay" style={{ opacity: 0.025 }} />
      <div
        aria-hidden
        className="phosphor-wash"
        style={{ top: "-12%", left: "50%", transform: "translateX(-50%)", width: "60%", height: "60%" }}
      />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 pt-16 sm:pt-24 lg:pt-28 pb-12 sm:pb-16 relative text-center">
        {/* Eyebrow */}
        <div className="inline-flex items-center gap-2 rounded-full studio-pill px-3.5 py-1.5 reveal-up">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--phosphor)]" />
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-graphite)]">
            Live graphics, just by talking
          </span>
        </div>

        {/* Headline */}
        <h1 className="display-serif mx-auto mt-7 max-w-4xl text-[clamp(2.75rem,8vw,6.25rem)] text-[var(--studio-ink)] reveal-up [animation-delay:80ms]">
          Broadcast-grade graphics on your camera.{" "}
          <span className="italic text-[var(--phosphor)] [text-shadow:0_0_36px_rgba(82,255,139,0.22)]">
            Just by talking.
          </span>
        </h1>

        {/* Subhead */}
        <p className="mx-auto mt-6 max-w-2xl text-[var(--studio-graphite)] text-base sm:text-lg leading-relaxed reveal-up [animation-delay:160ms]">
          Capturia is an AI that puts your numbers, your name, and your headlines
          on screen the instant you say them. Perfect for pitches, talks, and demos
          on Zoom, Teams, and Meet.
        </p>

        {/* CTAs */}
        <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3 reveal-up [animation-delay:240ms]">
          <Link
            href="/studio"
            className="cta-solid inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 text-[15px] font-semibold w-full sm:w-auto justify-center"
          >
            Try it free
            <span aria-hidden>→</span>
          </Link>
          <a
            href="#demo"
            className="ghost-btn inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 text-[15px] font-medium w-full sm:w-auto justify-center"
          >
            See it work
          </a>
        </div>
        <p className="mt-4 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)] reveal-up [animation-delay:300ms]">
          Free · no signup · Chrome / Edge for voice
        </p>

        {/* The live demo: the proof */}
        <div id="demo" className="mt-12 sm:mt-16 reveal-up [animation-delay:360ms] text-left">
          <LiveDemo />
        </div>

        {/* Trust strip */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-2.5 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)] reveal-up [animation-delay:420ms]">
          <span className="text-[var(--phosphor)]">1st at the Generative UI Hackathon</span>
          <span aria-hidden className="trust-pip" />
          <span>Works in Zoom, Teams, Meet</span>
          <span aria-hidden className="trust-pip" />
          <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
            Open source
          </a>
        </div>
      </div>
    </section>
  );
}

/* ───── 3. Human caption tying the demo to reality ───── */

function HumanCaption() {
  return (
    <section className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-4xl px-6 py-14 sm:py-20 text-center">
        <p className="display-serif text-[var(--studio-ink)] text-[clamp(1.7rem,4vw,3rem)] leading-[1.18]">
          Everything above is{" "}
          <span className="italic text-[var(--phosphor)]">live</span>. No editing,
          no cuts. You just talk.
        </p>
      </div>
    </section>
  );
}

/* ───── 4. How it works ───── */

function HowItWorks() {
  const steps: Array<{ n: string; title: string; body: string }> = [
    {
      n: "1",
      title: "Turn on your camera",
      body: "Open Capturia in your browser and switch on your webcam. You are on air in seconds.",
    },
    {
      n: "2",
      title: "Talk like you normally would",
      body: "Say your numbers, your name, your point. No commands to memorize, no buttons to hunt for.",
    },
    {
      n: "3",
      title: "Graphics appear instantly",
      body: "Lower thirds, counters, charts, and tickers land on your video the moment you mention them.",
    },
  ];

  return (
    <section id="how" className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
      <SectionHead
        eyebrow="How it works"
        title={
          <>
            Three steps. <span className="italic text-[var(--phosphor)]">Zero learning curve.</span>
          </>
        }
        kicker="If you can hold a conversation, you can run Capturia."
      />

      <div className="mt-12 sm:mt-16 grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6">
        {steps.map((s, i) => (
          <div
            key={s.n}
            className="product-card rounded-2xl p-7 sm:p-8 reveal-up"
            style={{ animationDelay: `${i * 100}ms` }}
          >
            <div className="step-numeral text-6xl sm:text-7xl">{s.n}</div>
            <h3 className="mt-5 text-[var(--studio-ink)] text-lg font-semibold tracking-tight">
              {s.title}
            </h3>
            <p className="mt-2.5 text-[var(--studio-graphite)] text-[14.5px] leading-relaxed">
              {s.body}
            </p>
          </div>
        ))}
      </div>

      {/* Deck hook micro-line */}
      <div className="mt-6 flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-[var(--studio-mist)]/50 px-6 py-5 reveal-up [animation-delay:320ms]">
        <span aria-hidden className="mt-0.5 text-[var(--signal)] text-lg leading-none">+</span>
        <p className="text-[var(--studio-graphite)] text-[14.5px] leading-relaxed">
          <span className="text-[var(--studio-ink)] font-medium">Bring your pitch deck.</span>{" "}
          Drop it in once and your numbers are ready to show the moment you mention them.
        </p>
      </div>
    </section>
  );
}

/* ───── 5. What it can put on screen (live SlotPreview miniatures) ───── */

interface Slot {
  code: SlotCode;
  name: string;
}

const GROUPS: Array<{ heading: string; blurb: string; slots: Slot[] }> = [
  {
    heading: "Your numbers",
    blurb: "Traction, growth, and milestones, animated the instant you say them.",
    slots: [
      { code: "MTR", name: "Metrics" },
      { code: "BCT", name: "Big number" },
      { code: "RNG", name: "Stat ring" },
      { code: "PRG", name: "Progress" },
      { code: "CHT", name: "Chart" },
    ],
  },
  {
    heading: "Your story",
    blurb: "Name bars, key terms, and a live ticker that keep your message clear.",
    slots: [
      { code: "LTH", name: "Name bar" },
      { code: "KWD", name: "Key points" },
      { code: "TLN", name: "Timeline" },
      { code: "TKR", name: "Ticker" },
      { code: "BUB", name: "Quote" },
    ],
  },
  {
    heading: "Cinematic",
    blurb: "Broadcast touches that make any call look like a production.",
    slots: [
      { code: "BDG", name: "Live badge" },
      { code: "LBX", name: "Letterbox" },
    ],
  },
];

function OnScreen() {
  return (
    <section className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
        <SectionHead
          eyebrow="What it can put on screen"
          title={
            <>
              A whole control room, <span className="italic text-[var(--signal)]">on your voice</span>.
            </>
          }
          kicker="These are live, the same graphics you saw running in the demo above."
        />

        <div className="mt-12 sm:mt-16 space-y-12 sm:space-y-16">
          {GROUPS.map((group, gi) => (
            <div key={group.heading}>
              <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-1.5">
                <h3 className="display-serif text-[var(--studio-ink)] text-2xl sm:text-3xl">
                  {group.heading}
                </h3>
                <p className="text-[var(--studio-graphite)] text-[13.5px] sm:max-w-md sm:text-right leading-relaxed">
                  {group.blurb}
                </p>
              </div>
              <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
                {group.slots.map((s, i) => (
                  <div
                    key={s.code}
                    className="product-card rounded-xl overflow-hidden reveal-up"
                    style={{ animationDelay: `${(gi * 3 + i) * 50}ms` }}
                  >
                    <div className="rounded-t-xl overflow-hidden">
                      <SlotPreview code={s.code} />
                    </div>
                    <div className="px-3.5 py-3 text-[var(--studio-ink)] text-[13px] font-medium">
                      {s.name}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───── 6. Use cases ───── */

function UseCases() {
  const cases: Array<{ tag: string; title: string; body: string; accent: string }> = [
    {
      tag: "Founders",
      title: "Pitch with proof",
      body: "Say your revenue and growth and watch it land on screen. Investors see traction, not just slides.",
      accent: "var(--phosphor)",
    },
    {
      tag: "Speakers",
      title: "Own the talk",
      body: "Your name, your title, and your key points appear as broadcast lower thirds while you speak.",
      accent: "var(--amber-cue)",
    },
    {
      tag: "Course creators",
      title: "Make lessons stick",
      body: "Highlight terms, show progress, and mark chapters live, so students always know where they are.",
      accent: "var(--magenta-sweep)",
    },
    {
      tag: "Consultants",
      title: "Demo like a network",
      body: "Put live KPIs and a branded ticker on your call. Every client meeting feels like a broadcast.",
      accent: "var(--signal)",
    },
  ];

  return (
    <section id="use-cases" className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
      <SectionHead
        eyebrow="Use cases"
        title={
          <>
            Built for the people <span className="italic text-[var(--phosphor)]">on camera</span>.
          </>
        }
        kicker="No crew, no graphics operator, no post-production. Just you and your voice."
      />

      <div className="mt-12 sm:mt-16 grid grid-cols-1 sm:grid-cols-2 gap-5 sm:gap-6">
        {cases.map((c, i) => (
          <div
            key={c.tag}
            className="product-card rounded-2xl p-7 sm:p-8 reveal-up"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: c.accent, boxShadow: `0 0 12px ${c.accent}` }}
              />
              <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
                {c.tag}
              </span>
            </div>
            <h3 className="display-serif mt-4 text-[var(--studio-ink)] text-2xl sm:text-3xl">
              {c.title}
            </h3>
            <p className="mt-3 text-[var(--studio-graphite)] text-[15px] leading-relaxed">
              {c.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───── 7. Pricing teaser ───── */

function Pricing() {
  return (
    <section id="pricing" className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-20 sm:py-28">
        <SectionHead
          eyebrow="Pricing"
          title={
            <>
              Start free today. <span className="italic text-[var(--phosphor)]">Go pro soon.</span>
            </>
          }
          kicker="The browser studio is free and open source. The desktop camera is on the way."
        />

        <div className="mt-12 sm:mt-16 grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
          {/* Free */}
          <div className="product-card rounded-2xl p-8 reveal-up flex flex-col">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[var(--studio-ink)] text-xl font-semibold tracking-tight">Free</h3>
              <span className="display-serif text-[var(--studio-ink)] text-4xl">$0</span>
            </div>
            <p className="mt-2 text-[var(--studio-graphite)] text-[14px]">
              Use it in your browser, right now.
            </p>
            <ul className="mt-7 space-y-3.5 text-[14.5px] text-[var(--studio-graphite)] flex-1">
              <Feature>Run the full studio in your browser</Feature>
              <Feature>All graphics, driven by your voice</Feature>
              <Feature>Bring your own AI key (BYOK)</Feature>
              <Feature>Voice in Chrome and Edge</Feature>
            </ul>
            <Link
              href="/studio"
              className="cta-solid mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-semibold"
            >
              Try it free
              <span aria-hidden>→</span>
            </Link>
          </div>

          {/* Pro (coming soon) */}
          <div className="pro-card rounded-2xl p-8 reveal-up [animation-delay:120ms] flex flex-col">
            <div className="flex items-center justify-between">
              <h3 className="text-[var(--studio-ink)] text-xl font-semibold tracking-tight">Pro</h3>
              <span className="rounded-full border border-[var(--phosphor)]/40 px-2.5 py-1 font-mono text-[9px] tracking-[0.22em] uppercase text-[var(--phosphor)]">
                Coming soon
              </span>
            </div>
            <p className="mt-2 text-[var(--studio-graphite)] text-[14px]">
              Capturia as a desktop camera.
            </p>
            <ul className="mt-7 space-y-3.5 text-[14.5px] text-[var(--studio-graphite)] flex-1">
              <Feature accent="var(--phosphor)">Shows up as a camera in Zoom, Teams, and Meet</Feature>
              <Feature accent="var(--phosphor)">Drop your deck, numbers ready on cue</Feature>
              <Feature accent="var(--phosphor)">No browser limits, works everywhere</Feature>
              <Feature accent="var(--phosphor)">Built-in voice, no extension needed</Feature>
            </ul>
            <a
              href={GITHUB}
              target="_blank"
              rel="noopener noreferrer"
              className="ghost-btn mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-medium"
            >
              Notify me on GitHub
              <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Feature({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <li className="flex items-start gap-3">
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 16 16"
        className="mt-0.5 shrink-0"
        style={{ color: accent ?? "var(--studio-fade)" }}
      >
        <path
          d="M3 8.5l3 3 7-7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{children}</span>
    </li>
  );
}

/* ───── 8. Final CTA ───── */

function FinalCta() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="phosphor-wash"
        style={{ bottom: "-20%", left: "50%", transform: "translateX(-50%)", width: "70%", height: "70%" }}
      />
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-24 sm:py-32 text-center relative">
        <div className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--tally)] tally-pulse" />
          <span className="text-[var(--tally)]">On Air</span>
          <span>· ready when you are</span>
        </div>
        <h2 className="display-serif mt-6 text-[clamp(2.5rem,7vw,5.5rem)] leading-[1.02]">
          Try it free.{" "}
          <span className="italic text-[var(--phosphor)] [text-shadow:0_0_36px_rgba(82,255,139,0.22)]">
            Just start talking.
          </span>
        </h2>
        <p className="mt-6 text-[var(--studio-graphite)] max-w-xl mx-auto text-base sm:text-lg leading-relaxed">
          The fastest way to feel what Capturia does is to talk at it for thirty seconds.
          Open the studio and watch your words turn into graphics.
        </p>

        <div className="mt-10 flex flex-col items-center gap-4">
          <Link
            href="/studio"
            className="cta-solid inline-flex items-center gap-2.5 rounded-full px-9 py-4 text-base font-semibold"
          >
            Try it free
            <span aria-hidden>→</span>
          </Link>
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
            Free · no signup · Chrome / Edge for voice
          </span>
        </div>
      </div>
    </section>
  );
}

/* ───── 9. Footer ───── */

function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-8 items-start">
        <div className="max-w-md">
          <Link
            href="/"
            aria-label="Capturia home"
            className="inline-flex text-[var(--studio-ink)] hover:opacity-90 transition-opacity"
          >
            <CapturiaLogo style={{ height: 34, width: "auto" }} />
          </Link>
          <p className="mt-4 text-[var(--studio-graphite)] text-[14px] leading-relaxed">
            Broadcast-grade graphics on your camera, composed live from your voice.
          </p>
          <p className="mt-3 text-[var(--studio-fade)] text-[12.5px] leading-relaxed">
            Built solo by Andres Carreon, founder of Bubblio. 1st place at the
            Generative UI Global Hackathon, May 2026.
          </p>
          <p className="mt-3 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
            Open source · built on open standards ·{" "}
            <a
              href={LICENSE}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition-colors"
            >
              MIT
            </a>
          </p>
        </div>

        <nav className="flex flex-col sm:items-end gap-2.5 text-[13px] text-[var(--studio-graphite)]">
          <Link href="/studio" className="hover:text-white transition-colors">
            Open the studio
          </Link>
          <a href="#how" className="hover:text-white transition-colors">How it works</a>
          <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
            GitHub
          </a>
        </nav>
      </div>

      <div className="border-t border-white/[0.04]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-10 flex items-center justify-between font-mono text-[9px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          <span>Capturia · {new Date().getFullYear()}</span>
          <span>Stream&nbsp;idle · 00:00:00</span>
        </div>
      </div>
    </footer>
  );
}

/* ───── shared: section heading block ───── */

function SectionHead({
  eyebrow,
  title,
  kicker,
}: {
  eyebrow: string;
  title: React.ReactNode;
  kicker?: string;
}) {
  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
          {eyebrow}
        </span>
        <span className="h-px flex-1 bg-white/[0.08]" />
      </div>
      <h2 className="display-serif mt-4 text-[clamp(2rem,5vw,3.75rem)] leading-[1.04] text-[var(--studio-ink)]">
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
