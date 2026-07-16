import styles from "./relaunch.module.css";

/**
 * VotePreview: a static, server-rendered composition selling the audience
 * voting loop. A camera frame carries the on-feed QR badge and a live tally
 * panel; a phone card overlaps the corner showing the voter's side.
 *
 * Everything is CSS: the bars fill and breathe on raw keyframes (see
 * relaunch.module.css), the phone bobs on the existing idle-bob utility.
 * The QR is decorative, a deterministic pattern with real finder squares so
 * it reads as a QR at a glance without encoding anything.
 */

const QR_SIZE = 21;

/** Deterministic pseudo-random module grid with QR finder patterns. */
function qrModules(): boolean[][] {
  let seed = 20260706;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const grid: boolean[][] = Array.from({ length: QR_SIZE }, () =>
    Array.from({ length: QR_SIZE }, () => rnd() > 0.52)
  );

  // 7x7 finder pattern: solid ring, light gap, solid 3x3 core.
  const finder = (top: number, left: number) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = y === 0 || y === 6 || x === 0 || x === 6;
        const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        grid[top + y][left + x] = ring || core;
      }
    }
  };
  finder(0, 0);
  finder(0, QR_SIZE - 7);
  finder(QR_SIZE - 7, 0);

  // Light separators around each finder (row/col 7 and 13 on a 21 grid).
  for (let i = 0; i <= 7; i++) {
    grid[7][i] = false;
    grid[i][7] = false;
    grid[7][QR_SIZE - 1 - i] = false;
    grid[i][QR_SIZE - 8] = false;
    grid[QR_SIZE - 8][i] = false;
    grid[QR_SIZE - 1 - i][7] = false;
  }

  // Timing tracks.
  for (let i = 8; i < QR_SIZE - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  return grid;
}

function FauxQr() {
  const grid = qrModules();
  return (
    <svg
      viewBox={`0 0 ${QR_SIZE} ${QR_SIZE}`}
      className="w-full h-auto"
      role="img"
      aria-label="QR code your audience scans to vote"
      shapeRendering="crispEdges"
    >
      {grid.flatMap((row, y) =>
        row.map((on, x) =>
          on ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#0b0d10" /> : null
        )
      )}
    </svg>
  );
}

interface PollOption {
  label: string;
  pct: number;
  color: string;
  leading?: boolean;
}

const OPTIONS: PollOption[] = [
  { label: "Ship the native camera", pct: 62, color: "var(--phosphor)", leading: true },
  { label: "More overlay styles", pct: 24, color: "var(--signal)" },
  { label: "Windows version", pct: 14, color: "var(--amber-cue)" },
];

export default function VotePreview() {
  return (
    <div className="relative sm:pb-10">
      {/* The camera frame: what your audience sees on the call */}
      <div className="relative aspect-video overflow-hidden border border-[var(--studio-line)] bg-gradient-to-br from-[#0c0e12] via-[#0a0b0e] to-[#15181d]">
        <div aria-hidden className="absolute inset-0 crt-grid" />
        <div aria-hidden className="absolute inset-0 crt-scanlines" />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.55) 100%)",
          }}
        />

        {/* Frame chrome */}
        <div className="absolute top-3 left-3 sm:top-4 sm:left-4 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--tally)] tally-pulse" />
          <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.22em] uppercase text-[var(--tally)]">
            On Air
          </span>
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
            · your camera feed
          </span>
        </div>

        {/* Live tally panel */}
        <div className="absolute left-3 sm:left-6 top-1/2 -translate-y-1/2 w-[62%] sm:w-[54%] max-w-[340px] rounded-xl border border-white/10 bg-black/60 backdrop-blur-md p-3.5 sm:p-5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--phosphor)] live-dot-pulse" />
            <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.24em] uppercase text-[var(--phosphor)]">
              Live poll
            </span>
          </div>
          <p className="mt-2 text-[var(--studio-ink)] text-[13px] sm:text-[15px] font-semibold tracking-tight">
            What should we build next?
          </p>
          <div className="mt-3 sm:mt-4 space-y-2.5 sm:space-y-3">
            {OPTIONS.map((o, i) => (
              <div key={o.label}>
                <div className="flex items-baseline justify-between gap-2">
                  <span
                    className={`text-[11px] sm:text-[12.5px] truncate ${
                      o.leading ? "text-[var(--studio-ink)] font-medium" : "text-[var(--studio-graphite)]"
                    }`}
                  >
                    {o.label}
                  </span>
                  <span className="font-mono text-[10px] sm:text-[11px] tabular-nums text-[var(--studio-graphite)]">
                    {o.pct}%
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                  <div
                    className={`h-full rounded-full ${styles.tallyBar}`}
                    style={
                      {
                        width: `${o.pct}%`,
                        background: o.color,
                        boxShadow: `0 0 10px ${o.color}`,
                        "--fill-delay": `${200 + i * 160}ms`,
                      } as React.CSSProperties
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 sm:mt-4 font-mono text-[9px] sm:text-[10px] tracking-[0.18em] uppercase text-[var(--studio-fade)]">
            231 votes · counting
          </p>
        </div>

        {/* On-feed QR badge, top-right like the real VoteQRBadge */}
        <div className="absolute right-3 top-10 sm:right-6 sm:top-8 w-[88px] sm:w-[124px] rounded-lg bg-white p-2 sm:p-2.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)]">
          <FauxQr />
          <p className="mt-1.5 text-center font-mono text-[7px] sm:text-[9px] tracking-[0.2em] uppercase text-[#0b0d10]">
            Scan to vote
          </p>
        </div>
      </div>

      {/* The phone: what a viewer does after scanning. In flow below the
          frame on phones, hanging off the corner from sm up. */}
      <div className="relative mx-auto -mt-9 w-[140px] sm:absolute sm:mx-0 sm:mt-0 sm:-bottom-2 sm:right-10 sm:w-[150px] rotate-2 idle-bob rounded-[1.4rem] border border-white/[0.14] bg-[#0f1216] p-2.5 sm:p-3 shadow-[0_18px_60px_rgba(0,0,0,0.65)]">
        <div className="mx-auto h-1 w-9 rounded-full bg-white/15" />
        <p className="mt-2 truncate font-mono text-[7.5px] sm:text-[8.5px] tracking-[0.08em] text-[var(--studio-fade)]">
          capturia.dev/vote/kj3p
        </p>
        <p className="mt-1.5 text-[10px] sm:text-[11px] font-medium leading-snug text-[var(--studio-ink)]">
          What should we build next?
        </p>
        <div className="mt-2 space-y-1.5">
          <div className="rounded-md border border-[var(--phosphor)]/60 bg-[var(--phosphor)]/15 px-2 py-1.5 text-[9px] sm:text-[10px] text-[var(--phosphor)] flex items-center justify-between gap-1">
            <span className="truncate">Ship the native camera</span>
            <svg aria-hidden width="9" height="9" viewBox="0 0 10 10" className="shrink-0">
              <path d="M1.5 5.5l2.4 2.4L8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="rounded-md border border-white/10 px-2 py-1.5 text-[9px] sm:text-[10px] text-[var(--studio-graphite)] truncate">
            More overlay styles
          </div>
          <div className="rounded-md border border-white/10 px-2 py-1.5 text-[9px] sm:text-[10px] text-[var(--studio-graphite)] truncate">
            Windows version
          </div>
        </div>
        <p className="mt-2 text-center font-mono text-[7px] sm:text-[8px] tracking-[0.22em] uppercase text-[var(--phosphor)]">
          Vote counted
        </p>
      </div>
    </div>
  );
}
