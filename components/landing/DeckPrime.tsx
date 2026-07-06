import styles from "./relaunch.module.css";

/**
 * DeckPrime: static, server-rendered visual for the deck priming story.
 * A PDF chip on the left, a marching connector, and the cue cards it primes
 * on the right. One card is on air, tied to the spoken line above the row,
 * so the whole loop reads at a glance: drop the deck, say the number,
 * the exact figure lands on your feed.
 */

interface DeckFact {
  page: string;
  label: string;
  value: string;
}

const FACTS: DeckFact[] = [
  { page: "p.07", label: "ARR", value: "$1.8M" },
  { page: "p.09", label: "Paying teams", value: "142" },
  { page: "p.12", label: "Net churn", value: "2.1%" },
];

interface CueCard {
  tag: string;
  value: string;
  label: string;
  onAir?: boolean;
}

const CARDS: CueCard[] = [
  { tag: "Cue · p.07", value: "$1.8M", label: "ARR", onAir: true },
  { tag: "Cue · p.09", value: "142", label: "Paying teams" },
  { tag: "Cue · p.12", value: "2.1%", label: "Net churn" },
];

function PdfGlyph() {
  return (
    <svg aria-hidden width="30" height="38" viewBox="0 0 30 38" className="shrink-0">
      <path
        d="M2 3a2 2 0 0 1 2-2h16l8 8v26a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3Z"
        fill="rgba(255,255,255,0.05)"
        stroke="rgba(255,255,255,0.28)"
        strokeWidth="1.2"
      />
      <path d="M20 1v8h8" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" />
      <text
        x="15"
        y="27"
        textAnchor="middle"
        fontFamily="var(--font-geist-mono), monospace"
        fontSize="8"
        letterSpacing="0.08em"
        fill="var(--tally)"
      >
        PDF
      </text>
    </svg>
  );
}

export default function DeckPrime() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,330px)_56px_minmax(0,1fr)] items-center gap-6 lg:gap-0">
      {/* The deck chip */}
      <div className="product-card rounded-2xl p-6 sm:p-7">
        <div className="flex items-center gap-4">
          <PdfGlyph />
          <div className="min-w-0">
            <p className="truncate text-[var(--studio-ink)] text-[14.5px] font-medium">
              seed-round-deck.pdf
            </p>
            <p className="mt-0.5 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
              18 pages · read on your Mac
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-2.5 border-t border-white/[0.06] pt-5">
          {FACTS.map((f) => (
            <div key={f.page} className="flex items-baseline gap-3 font-mono text-[11px]">
              <span className="text-[var(--studio-fade)]">{f.page}</span>
              <span className="text-[var(--studio-graphite)]">{f.label}</span>
              <span
                aria-hidden
                className="flex-1 border-b border-dotted border-white/[0.14] translate-y-[-3px]"
              />
              <span className="text-[var(--studio-ink)] tabular-nums">{f.value}</span>
            </div>
          ))}
        </div>

        <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--phosphor)]/35 px-3 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--phosphor)] live-dot-pulse" />
          <span className="font-mono text-[9px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
            Primed · 24 cue cards
          </span>
        </div>
      </div>

      {/* Connector: horizontal on desktop, vertical when stacked */}
      <div aria-hidden className="hidden lg:block relative h-[2px] mx-2">
        <div className={`absolute inset-0 ${styles.cueFlow}`} />
        <span className="absolute -right-1 top-1/2 -translate-y-1/2 border-y-[4px] border-y-transparent border-l-[6px] border-l-[var(--phosphor)]/70" />
      </div>
      <div aria-hidden className="lg:hidden relative w-[2px] h-10 mx-auto">
        <div className={`absolute inset-0 ${styles.cueFlowY}`} />
      </div>

      {/* The cue cards, one live */}
      <div>
        <div className="flex items-center gap-2.5 px-1">
          <span className="font-mono text-[var(--phosphor)] text-sm" aria-hidden>
            ›
          </span>
          <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
            voice
          </span>
          <span className="font-mono text-[11.5px] sm:text-[12.5px] text-[var(--studio-graphite)] truncate">
            …we closed the quarter at one point eight million…
          </span>
        </div>

        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          {CARDS.map((c) => (
            <div
              key={c.tag}
              className={`rounded-xl p-4 sm:p-5 border transition-colors ${
                c.onAir
                  ? "border-[var(--phosphor)]/50 bg-[var(--phosphor)]/[0.05] shadow-[0_0_36px_rgba(82,255,139,0.10)]"
                  : "border-white/[0.07] bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-[var(--studio-fade)]">
                  {c.tag}
                </span>
                {c.onAir ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--tally)] tally-pulse" />
                    <span className="font-mono text-[8px] tracking-[0.22em] uppercase text-[var(--tally)]">
                      On feed
                    </span>
                  </span>
                ) : (
                  <span className="font-mono text-[8px] tracking-[0.22em] uppercase text-[var(--studio-fade)]/70">
                    Armed
                  </span>
                )}
              </div>
              <p
                className={`display-serif mt-3 text-3xl sm:text-4xl ${
                  c.onAir ? "text-[var(--phosphor)]" : "text-[var(--studio-ink)]"
                }`}
              >
                {c.value}
              </p>
              <p className="mt-1 text-[12.5px] text-[var(--studio-graphite)]">{c.label}</p>
            </div>
          ))}
        </div>

        <p className="mt-4 px-1 font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
          Your figure, from your page, the moment you say it
        </p>
      </div>
    </div>
  );
}
