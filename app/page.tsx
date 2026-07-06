import type { Metadata } from "next";
import Link from "next/link";
import LiveDemo from "@/components/landing/LiveDemo";
import SlotPreview, { type SlotCode } from "@/components/landing/SlotPreview";
import DeckPrime from "@/components/landing/DeckPrime";
import VotePreview from "@/components/landing/VotePreview";
import { CapturiaLogo, CapturiaMark } from "@/components/landing/Brand";
import styles from "@/components/landing/relaunch.module.css";

/* ─────────────────────────────────────────────────────────────
   Capturia landing, the M12 relaunch. Desktop-first positioning:
   a macOS menu bar app whose camera you use in Zoom, Meet, and
   Slack. Written for people who talk for a living, not developers.
   Server component, no CopilotKit import (bundle contract).
   ───────────────────────────────────────────────────────────── */

const GITHUB = "https://github.com/AndresCarreonDiaz/capturia";
const RELEASES = "https://github.com/AndresCarreonDiaz/capturia/releases";
const LICENSE = "https://github.com/AndresCarreonDiaz/capturia/blob/main/LICENSE";

export const metadata: Metadata = {
  title: "Capturia · The AI producer inside your camera",
  description:
    "Capturia is a macOS menu bar app for people who talk for a living. Speak normally on Zoom, Meet, or Slack and it renders your numbers, charts, and audience votes over your live camera feed. Free with your own AI key. Open source, MIT.",
  openGraph: {
    title: "Capturia · The AI producer inside your camera",
    description:
      "Talk normally on a call. Capturia listens on your Mac and renders your numbers, charts, and audience votes over your live camera feed.",
    type: "website",
  },
};

export default function Landing() {
  return (
    <main className="min-h-screen bg-[var(--studio-black)] text-[var(--studio-ink)] selection:bg-[var(--phosphor)]/30 selection:text-white">
      <TopNav />
      <Hero />
      <HumanCaption />
      <HowItWorks />
      <DeckSection />
      <OnScreen />
      <VotingSection />
      <Differentiators />
      <UseCases />
      <Pricing />
      <Faq />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}

/* ───── shared bits ───── */

function StarIcon({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" className={className}>
      <path
        d="M8 1.6l1.94 3.93 4.34.63-3.14 3.06.74 4.32L8 11.5l-3.88 2.04.74-4.32L1.72 6.16l4.34-.63L8 1.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
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
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] px-2 py-0.5 font-mono text-[9px] tracking-[0.2em] uppercase text-[var(--studio-graphite)]">
            for macOS
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-7 text-[13px] text-[var(--studio-graphite)]">
          <a href="#how" className="hover:text-white transition-colors">How it works</a>
          <a href="#voting" className="hover:text-white transition-colors">Audience voting</a>
          <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          <a href="#faq" className="hover:text-white transition-colors">FAQ</a>
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)] hover:text-white transition-colors"
          >
            <StarIcon />
            GitHub
          </a>
          <Link
            href="/studio"
            className="cta-solid inline-flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium"
          >
            Try the demo
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
        {/* Eyebrow: the relaunch announcement */}
        <div className="inline-flex items-center gap-2 rounded-full studio-pill px-3.5 py-1.5 reveal-up">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--phosphor)]" />
          <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-graphite)]">
            Now a macOS menu bar app
          </span>
        </div>

        {/* Headline */}
        <h1 className="display-serif mx-auto mt-7 max-w-4xl text-[clamp(3rem,10vw,7.5rem)] text-[var(--studio-ink)] reveal-up [animation-delay:80ms]">
          Speak.{" "}
          <span className="italic text-[var(--phosphor)] [text-shadow:0_0_36px_rgba(82,255,139,0.22)]">
            It shows.
          </span>
        </h1>

        {/* Subhead */}
        <p className="mx-auto mt-6 max-w-2xl text-[var(--studio-graphite)] text-base sm:text-lg leading-relaxed reveal-up [animation-delay:160ms]">
          Capturia is the AI producer inside your camera. Talk normally on Zoom,
          Meet, or Slack, and it renders your numbers, your charts, and your
          audience&rsquo;s votes over your live camera feed, right as you say them.
        </p>

        {/* CTAs */}
        <div className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3 reveal-up [animation-delay:240ms]">
          <Link
            href="/studio"
            className="cta-solid inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 text-[15px] font-semibold w-full sm:w-auto justify-center"
          >
            Try the live demo
            <span aria-hidden>→</span>
          </Link>
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            className="ghost-btn inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 text-[15px] font-medium w-full sm:w-auto justify-center"
          >
            <StarIcon />
            Star on GitHub
          </a>
        </div>
        <p className="mt-4 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)] reveal-up [animation-delay:300ms]">
          Free · open source · app release coming ·{" "}
          <a
            href={RELEASES}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--studio-graphite)] hover:text-white transition-colors underline decoration-dotted underline-offset-4"
          >
            get notified
          </a>
        </p>

        {/* The live demo, framed as a Mac screen: menu bar on top */}
        <div id="demo" className="mt-12 sm:mt-16 reveal-up [animation-delay:360ms] text-left">
          <div className="mx-auto max-w-[1200px]">
            <MenuBarStrip />
          </div>
          <LiveDemo />
        </div>

        {/* Trust strip */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-4 gap-y-2.5 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)] reveal-up [animation-delay:420ms]">
          <span className="text-[var(--phosphor)]">1st at the Generative UI Hackathon</span>
          <span aria-hidden className="trust-pip" />
          <span>One camera for every call app</span>
          <span aria-hidden className="trust-pip" />
          <span>On-device speech · nothing recorded</span>
        </div>
      </div>
    </section>
  );
}

/** A slim macOS menu bar over the demo: the active app is your call app,
 *  and Capturia sits in the tray. Sells "menu bar app" without a word. */
function MenuBarStrip() {
  return (
    <div className="flex items-center justify-between rounded-t-xl border border-b-0 border-[var(--studio-line)] bg-white/[0.035] px-3 sm:px-4 h-8">
      <div className="flex items-center gap-3 sm:gap-4 font-mono text-[9px] sm:text-[10px] text-[var(--studio-fade)] min-w-0">
        <span className="text-[var(--studio-graphite)] font-semibold shrink-0">Zoom</span>
        <span className="hidden sm:inline">Meeting</span>
        <span className="hidden sm:inline">Edit</span>
        <span className="hidden md:inline">View</span>
        <span className="hidden md:inline">Window</span>
      </div>
      <div className="flex items-center gap-2.5 sm:gap-3.5">
        <span
          className="flex items-center gap-1.5"
          title="Capturia, running in your menu bar"
        >
          <CapturiaMark style={{ height: 13, width: "auto" }} className="text-[var(--studio-ink)]" />
          <span className="hidden sm:inline font-mono text-[8px] tracking-[0.2em] uppercase text-[var(--phosphor)]">
            listening
          </span>
        </span>
        <span aria-hidden className="h-3 w-px bg-white/[0.12]" />
        <span className="font-mono text-[9px] sm:text-[10px] text-[var(--studio-fade)] tabular-nums">
          Tue 9:41
        </span>
      </div>
    </div>
  );
}

/* ───── 3. Human caption tying the demo to the desktop app ───── */

function HumanCaption() {
  return (
    <section className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-4xl px-6 py-14 sm:py-20 text-center">
        <p className="display-serif text-[var(--studio-ink)] text-[clamp(1.7rem,4vw,3rem)] leading-[1.18]">
          Everything above is{" "}
          <span className="italic text-[var(--phosphor)]">live</span>. No editing,
          no cuts. You just talk.
        </p>
        <p className="mt-5 text-[var(--studio-graphite)] text-[15px] leading-relaxed max-w-xl mx-auto">
          That is the browser demo, free at{" "}
          <Link href="/studio" className="cue-link">
            /studio
          </Link>
          . The macOS app renders the same graphics over your real camera feed,
          in every call you take.
        </p>
      </div>
    </section>
  );
}

/* ───── 4. How it works (desktop flow) ───── */

function HowItWorks() {
  const steps: Array<{ n: string; title: string; body: string }> = [
    {
      n: "1",
      title: "It lives in your menu bar",
      body: "Capturia sits next to your clock. Open the Control Room and your camera comes up in a live preview, producer on standby.",
    },
    {
      n: "2",
      title: "Talk like you always do",
      body: "Say your numbers, your names, your point. Speech is understood on your Mac. No bot joins your call and nothing is recorded.",
    },
    {
      n: "3",
      title: "Your feed carries the graphics",
      body: "Metrics, charts, lower thirds, and polls land over your live camera while you speak. Your audience sees a produced broadcast.",
    },
  ];

  return (
    <section id="how" className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
      <SectionHead
        eyebrow="How it works"
        title={
          <>
            A producer in your menu bar.{" "}
            <span className="italic text-[var(--phosphor)]">Zero crew.</span>
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

      {/* Honest note: how broadcasting works today */}
      <div className="mt-6 flex items-start gap-3 rounded-2xl border border-white/[0.06] bg-[var(--studio-mist)]/50 px-6 py-5 reveal-up [animation-delay:320ms]">
        <span aria-hidden className="mt-0.5 text-[var(--amber-cue)] text-lg leading-none">◈</span>
        <p className="text-[var(--studio-graphite)] text-[14.5px] leading-relaxed">
          <span className="text-[var(--studio-ink)] font-medium">
            How it reaches your call today:
          </span>{" "}
          you share the Control Room window in Zoom, Meet, or Slack, or route it
          through OBS. Your audience sees the same feed either way. A native
          camera extension, where you pick Capturia like any webcam, is built and
          waiting on Apple approval.
        </p>
      </div>
    </section>
  );
}

/* ───── 5. Deck priming ───── */

function DeckSection() {
  return (
    <section id="deck" className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
        <SectionHead
          eyebrow="Deck priming"
          title={
            <>
              Drop your deck.{" "}
              <span className="italic text-[var(--signal)]">Your numbers stand by.</span>
            </>
          }
          kicker="Give Capturia your PDF once. It reads every figure on your Mac and arms a cue card for each one. Mention your churn and the exact number from your deck lands on screen. Nothing on your feed is ever made up."
        />

        <div className="mt-12 sm:mt-16 reveal-up">
          <DeckPrime />
        </div>
      </div>
    </section>
  );
}

/* ───── 6. What it can put on screen (live SlotPreview miniatures) ───── */

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
    <section id="onscreen" className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
      <SectionHead
        eyebrow="What it can put on screen"
        title={
          <>
            A whole control room, <span className="italic text-[var(--signal)]">on your voice</span>.
          </>
        }
        kicker="These are live, the same components the app renders over your camera. Every one is sized to stay legible after your meeting app compresses the video."
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
    </section>
  );
}

/* ───── 7. Audience voting (the Pro flagship) ───── */

function VotingSection() {
  return (
    <section id="voting" className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-10 lg:gap-14 items-center">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[10px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
                Audience voting
              </span>
              <span className="rounded-full border border-[var(--phosphor)]/40 px-2.5 py-1 font-mono text-[9px] tracking-[0.22em] uppercase text-[var(--phosphor)]">
                Pro flagship
              </span>
            </div>
            <h2 className="display-serif mt-4 text-[clamp(2rem,5vw,3.75rem)] leading-[1.04] text-[var(--studio-ink)]">
              Your audience votes.{" "}
              <span className="italic text-[var(--phosphor)]">
                Your camera shows the count.
              </span>
            </h2>
            <p className="mt-5 text-[var(--studio-graphite)] text-[15px] sm:text-[16px] leading-relaxed">
              Say &ldquo;let&rsquo;s put it to a vote&rdquo; and a QR code renders
              on your feed. Viewers scan it with their phones, tap an answer, and
              the tally climbs live on camera while you keep talking.
            </p>
            <ul className="mt-7 space-y-3.5 text-[14.5px] text-[var(--studio-graphite)]">
              <Feature accent="var(--phosphor)">
                Nothing for your audience to install or sign up for
              </Feature>
              <Feature accent="var(--phosphor)">
                No second-screen setup, the QR lives on your camera
              </Feature>
              <Feature accent="var(--phosphor)">
                Results render on your feed, so every eye stays on you
              </Feature>
            </ul>
            <p className="mt-7 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
              Hosted voting for any crowd size ships with Pro
            </p>
          </div>

          <div className="reveal-up">
            <VotePreview />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───── 8. Why it feels different ───── */

function Differentiators() {
  const points: Array<{ tag: string; title: string; body: string; accent: string }> = [
    {
      tag: "Camera",
      title: "Every call app at once",
      body: "Capturia works at the camera level, not as a plugin. One setup covers Zoom, Meet, Slack, and whatever your next client uses.",
      accent: "var(--phosphor)",
    },
    {
      tag: "Privacy",
      title: "No bot in your meeting",
      body: "Speech is understood on your Mac. Your call audio never leaves it, nothing is recorded, and no extra participant joins your call.",
      accent: "var(--signal)",
    },
    {
      tag: "Truth",
      title: "Real numbers only",
      body: "Figures on your feed come from your deck or your words, never from a model guessing. If your audience sees it, you said it.",
      accent: "var(--amber-cue)",
    },
    {
      tag: "Legibility",
      title: "Readable after compression",
      body: "Meeting apps crush pixels. Every overlay holds a minimum type size and contrast floor so the far end reads it, even on a bad connection.",
      accent: "var(--magenta-sweep)",
    },
  ];

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
      <SectionHead
        eyebrow="Why it feels different"
        title={
          <>
            Built like a camera, <span className="italic text-[var(--phosphor)]">not a plugin</span>.
          </>
        }
        kicker="Four decisions we refuse to walk back."
      />

      <div className="mt-12 sm:mt-16 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
        {points.map((p, i) => (
          <div
            key={p.tag}
            className="product-card rounded-2xl p-6 sm:p-7 reveal-up"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: p.accent, boxShadow: `0 0 12px ${p.accent}` }}
              />
              <span className="font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
                {p.tag}
              </span>
            </div>
            <h3 className="mt-4 text-[var(--studio-ink)] text-[17px] font-semibold tracking-tight">
              {p.title}
            </h3>
            <p className="mt-2.5 text-[var(--studio-graphite)] text-[14px] leading-relaxed">
              {p.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───── 9. Use cases ───── */

function UseCases() {
  const cases: Array<{ tag: string; title: string; body: string; accent: string }> = [
    {
      tag: "Founders",
      title: "Pitch with proof",
      body: "Say your revenue and the exact figure from your deck lands on screen. Investors watch traction happen instead of squinting at slide 14.",
      accent: "var(--phosphor)",
    },
    {
      tag: "Teachers",
      title: "Keep every eye on the lesson",
      body: "Key terms, timelines, and progress appear while you explain them, and a quick vote tells you who is following along.",
      accent: "var(--amber-cue)",
    },
    {
      tag: "Sales",
      title: "Demo like a broadcast",
      body: "Live KPIs, a name bar with your title, and the numbers your customer cares about on cue. Every discovery call looks produced.",
      accent: "var(--signal)",
    },
    {
      tag: "Community hosts",
      title: "Make the room part of the show",
      body: "Run polls off a QR on your feed, shout out members with lower thirds, and keep a ticker of what is coming next.",
      accent: "var(--magenta-sweep)",
    },
  ];

  return (
    <section id="use-cases" className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
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
      </div>
    </section>
  );
}

/* ───── 10. Pricing ───── */

function Pricing() {
  return (
    <section id="pricing" className="mx-auto max-w-5xl px-4 sm:px-6 py-20 sm:py-28">
      <SectionHead
        eyebrow="Pricing"
        title={
          <>
            Free with your key. <span className="italic text-[var(--phosphor)]">Pro when you want zero setup.</span>
          </>
        }
        kicker="The free tier is the real product, not a trial. Pro adds hosted everything for people who never want to think about API keys."
      />

      <div className="mt-12 sm:mt-16 grid grid-cols-1 md:grid-cols-2 gap-5 sm:gap-6">
        {/* Free */}
        <div className="product-card rounded-2xl p-8 reveal-up flex flex-col">
          <div className="flex items-center justify-between">
            <h3 className="text-[var(--studio-ink)] text-xl font-semibold tracking-tight">Free</h3>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
              Bring your own key
            </span>
          </div>
          <p className="mt-2 text-[var(--studio-graphite)] text-[14px]">
            Everything Capturia does, powered by your own AI key.
          </p>
          <ul className="mt-7 space-y-3.5 text-[14.5px] text-[var(--studio-graphite)] flex-1">
            <Feature>Your key stays in the macOS Keychain, never on our servers</Feature>
            <Feature>Full overlay library, voice control, deck priming</Feature>
            <Feature>The browser studio, free to try right now</Feature>
            <Feature>Open source under MIT</Feature>
          </ul>
          <Link
            href="/studio"
            className="cta-solid mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-semibold"
          >
            Try the live demo
            <span aria-hidden>→</span>
          </Link>
        </div>

        {/* Pro (coming) */}
        <div className="pro-card rounded-2xl p-8 reveal-up [animation-delay:120ms] flex flex-col">
          <div className="flex items-center justify-between">
            <h3 className="text-[var(--studio-ink)] text-xl font-semibold tracking-tight">Pro</h3>
            <span className="rounded-full border border-[var(--phosphor)]/40 px-2.5 py-1 font-mono text-[9px] tracking-[0.22em] uppercase text-[var(--phosphor)]">
              Coming
            </span>
          </div>
          <p className="mt-2 text-[var(--studio-graphite)] text-[14px]">
            Sign in and talk. We handle the rest.
          </p>
          <ul className="mt-7 space-y-3.5 text-[14.5px] text-[var(--studio-graphite)] flex-1">
            <Feature accent="var(--phosphor)">Hosted AI keys, no API setup at all</Feature>
            <Feature accent="var(--phosphor)">Hosted audience voting for any crowd size</Feature>
            <Feature accent="var(--phosphor)">Premium features as they ship</Feature>
          </ul>
          <a
            href={RELEASES}
            target="_blank"
            rel="noopener noreferrer"
            className="ghost-btn mt-8 inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-[15px] font-medium"
          >
            Get notified on GitHub
            <span aria-hidden>→</span>
          </a>
        </div>
      </div>

      <p className="mt-6 text-center font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
        Pro pricing lands with the public release
      </p>
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

/* ───── 11. FAQ: the honest answers ───── */

const FAQS: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: "Can I download the app today?",
    a: (
      <>
        Not yet. The build is not signed for distribution, and we will not hand
        out an unsigned app. Star or watch the{" "}
        <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="cue-link">
          GitHub repo
        </a>{" "}
        and the release will find you the moment it is up. The{" "}
        <Link href="/studio" className="cue-link">
          browser demo
        </Link>{" "}
        works right now.
      </>
    ),
  },
  {
    q: "How does it get into my call right now?",
    a: (
      <>
        You share the Control Room window in Zoom, Meet, or Slack, or route it
        through OBS. Your audience sees the composed feed either way. The native
        camera extension, where Capturia shows up as a webcam you pick inside the
        call app, is built and waiting on Apple approval.
      </>
    ),
  },
  {
    q: "Does it record my calls?",
    a: (
      <>
        No. Speech is understood on your Mac and your call audio never leaves it.
        No bot joins the meeting, nothing is uploaded, nothing is stored. Only
        the short commands you speak are sent to your own AI provider to decide
        what to render.
      </>
    ),
  },
  {
    q: "What does free actually cost?",
    a: (
      <>
        Capturia itself is free and open source under MIT. You bring your own AI
        key, stored in the macOS Keychain and never sent to our servers, and you
        pay your model provider directly for what you use.
      </>
    ),
  },
  {
    q: "Which call apps does it work with?",
    a: (
      <>
        Any app that can show a shared window today, and any app that can pick a
        camera once the extension ships. Zoom, Meet, Slack, Teams, Webex,
        Discord: if it does video, it works.
      </>
    ),
  },
];

function Faq() {
  return (
    <section id="faq" className="border-y border-white/[0.06] bg-[var(--studio-mist)]">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-20 sm:py-28">
        <SectionHead
          eyebrow="FAQ"
          title={
            <>
              Straight answers, <span className="italic text-[var(--phosphor)]">on the record</span>.
            </>
          }
        />

        <div className="mt-10 sm:mt-12 border-t border-white/[0.08]">
          {FAQS.map((f, i) => (
            <details key={f.q} className={`${styles.faqItem} border-b border-white/[0.08]`}>
              <summary className="flex items-center justify-between gap-4 py-5 sm:py-6 group">
                <span className="flex items-baseline gap-4 min-w-0">
                  <span className="font-mono text-[10px] tracking-[0.2em] text-[var(--studio-fade)] tabular-nums shrink-0">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[var(--studio-ink)] text-[15.5px] sm:text-[17px] font-medium tracking-tight group-hover:text-white transition-colors">
                    {f.q}
                  </span>
                </span>
                <svg
                  aria-hidden
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  className={`${styles.faqIcon} shrink-0 text-[var(--phosphor)]`}
                >
                  <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </summary>
              <div className={`${styles.faqBody} pb-6 pl-[42px] pr-8`}>
                <p className="text-[var(--studio-graphite)] text-[14.5px] leading-relaxed">{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───── 12. Final CTA ───── */

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
          Give your camera{" "}
          <span className="italic text-[var(--phosphor)] [text-shadow:0_0_36px_rgba(82,255,139,0.22)]">
            a producer.
          </span>
        </h2>
        <p className="mt-6 text-[var(--studio-graphite)] max-w-xl mx-auto text-base sm:text-lg leading-relaxed">
          The fastest way to get it is to talk at the demo for thirty seconds.
          Then star the repo, and the macOS release will find you.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/studio"
            className="cta-solid inline-flex items-center gap-2.5 rounded-full px-9 py-4 text-base font-semibold w-full sm:w-auto justify-center"
          >
            Try the live demo
            <span aria-hidden>→</span>
          </Link>
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            className="ghost-btn inline-flex items-center gap-2.5 rounded-full px-9 py-4 text-base font-medium w-full sm:w-auto justify-center"
          >
            <StarIcon />
            Star on GitHub
          </a>
        </div>
        <p className="mt-5 font-mono text-[10px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
          No email, no list ·{" "}
          <a
            href={RELEASES}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--studio-graphite)] hover:text-white transition-colors underline decoration-dotted underline-offset-4"
          >
            watch releases
          </a>{" "}
          to get notified
        </p>
      </div>
    </section>
  );
}

/* ───── 13. Footer ───── */

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
            A macOS menu bar app that listens while you talk and renders visuals
            over your live camera feed. Free with your own key. Open source.
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
            Try the live demo
          </Link>
          <a href="#how" className="hover:text-white transition-colors">How it works</a>
          <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
            GitHub
          </a>
          <a href={RELEASES} target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
            Releases
          </a>
        </nav>
      </div>

      <div className="border-t border-white/[0.04]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-10 flex items-center justify-between font-mono text-[9px] tracking-[0.24em] uppercase text-[var(--studio-fade)]">
          <span>Capturia · {new Date().getFullYear()}</span>
          <span>Program&nbsp;out · standing&nbsp;by</span>
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
