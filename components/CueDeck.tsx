"use client";
import type { CueCard } from "@/lib/deck/types";

interface Props {
  cards: CueCard[];
  fileName: string | null;
  // Rail index the next-card hotkey (mod+Alt+Right) fires now; null once the
  // silent walk is past the end of the deck. Lights that card's badge.
  nextIndex: number | null;
  onTrigger: (card: CueCard) => void;
  onClear: () => void;
}

// This component renders nothing until a deck loads, which only happens
// client-side, so reading navigator here can never desync hydration (the
// server always renders the empty-deck null).
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/i.test(navigator.platform);
const MOD = IS_MAC ? "⌘⌥" : "Ctrl+Alt+";
const NEXT_KEY = IS_MAC ? "⌘⌥→" : "Ctrl+Alt+Right";

// A left-edge rail of cue cards built from the loaded deck. Click a card, say
// one of its aliases, or press its silent hotkey (mod+Alt+digit; mod+Alt+Right
// walks the deck) to drop its overlays onto the feed. "Adapted" marks a cue
// that fell back to the nearest catalog component.
//
// The number badges are a PERSISTENT subtle affordance, not a reveal while
// the modifier combo is held: on desktop the combos are global shortcuts the
// OS consumes while Capturia is not even focused, so the renderer cannot see
// the modifier being held in exactly the moment the feature exists for. The
// codebase's standing pattern for key hints is the same (the CommandBar's
// always-on push-to-talk line), so the rail follows it.
export default function CueDeck({ cards, fileName, nextIndex, onTrigger, onClear }: Props) {
  if (cards.length === 0) return null;
  const validated = cards.filter((c) => !c.adapted).length;

  return (
    <div className="absolute top-16 left-4 z-30 w-52 max-h-[60vh] flex flex-col rounded-xl bg-black/45 border border-white/10 backdrop-blur-md overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-white/70 text-[10px] font-mono uppercase tracking-[0.18em] truncate" title={fileName ?? ""}>
          {fileName ? fileName.replace(/\.pdf$/i, "") : "Cue deck"}
        </span>
        <button
          onClick={onClear}
          aria-label="Clear deck"
          className="text-white/30 hover:text-white/80 text-sm leading-none transition-colors"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {cards.map((card, i) => (
          <button
            key={card.id}
            onClick={() => onTrigger(card)}
            data-cue-next={i === nextIndex ? "" : undefined}
            className="w-full flex items-start gap-2 text-left px-2.5 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.12] border border-white/5 hover:border-white/20 transition-all group"
            title={card.aliases.slice(0, 4).join(" · ")}
          >
            {/* The card's silent hotkey (first nine cards only; later cards
                keep the empty badge so labels stay aligned). The lit badge is
                the card the next-card hotkey fires. */}
            <span
              aria-hidden
              title={i === nextIndex ? `Next up (${NEXT_KEY})` : undefined}
              className={`mt-0.5 w-3.5 shrink-0 text-center text-[9px] font-mono leading-4 rounded-sm ${
                i === nextIndex
                  ? "text-[var(--phosphor,#52ff8b)] bg-[rgba(82,255,139,0.12)]"
                  : "text-white/25 bg-white/[0.06]"
              }`}
            >
              {i < 9 ? i + 1 : ""}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-white/90 text-xs font-medium truncate group-hover:text-white">
                  {card.label}
                </span>
                <span className="text-[9px] font-mono uppercase tracking-widest text-[var(--phosphor,#52ff8b)]/80 shrink-0">
                  {card.specs[0]?.type}
                </span>
              </div>
              {card.adapted && (
                <span className="text-[9px] font-mono text-[var(--amber-cue,#fcb454)]/80 uppercase tracking-wider">
                  adapted
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-white/30 text-[9px] font-mono tracking-wider">
        <span className="block">
          {validated}/{cards.length} cues ready · say a name or click
        </span>
        <span className="block text-white/20">
          {MOD}1-9 fires a card · {NEXT_KEY} next
        </span>
      </div>
    </div>
  );
}
