"use client";
import type { CueCard } from "@/lib/deck/types";

interface Props {
  cards: CueCard[];
  fileName: string | null;
  onTrigger: (card: CueCard) => void;
  onClear: () => void;
}

// A left-edge rail of cue cards built from the loaded deck. Click a card (or say
// one of its aliases) to drop its overlays onto the feed. "Adapted" marks a cue
// that fell back to the nearest catalog component.
export default function CueDeck({ cards, fileName, onTrigger, onClear }: Props) {
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
        {cards.map((card) => (
          <button
            key={card.id}
            onClick={() => onTrigger(card)}
            className="w-full text-left px-2.5 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.12] border border-white/5 hover:border-white/20 transition-all group"
            title={card.aliases.slice(0, 4).join(" · ")}
          >
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
          </button>
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-white/10 text-white/30 text-[9px] font-mono tracking-wider">
        {validated}/{cards.length} cues ready · say a name or click
      </div>
    </div>
  );
}
