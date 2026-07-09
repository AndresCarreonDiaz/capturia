import type { DeckExtract, DeckSlide, CueCard, DeckFacts } from "./types";
import { validateOrFallback } from "./fallback";
import type { RawSpec } from "./validate";

const MAX_CARDS = 12;
const STOP = new Set([
  "the", "and", "for", "with", "our", "your", "you", "are", "was", "this", "that",
  "from", "into", "over", "have", "has", "will", "can", "all", "any", "out", "how",
  "why", "what", "who", "per", "via", "but", "not", "its", "it's", "we", "us",
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

// Parse "$1.8M" / "47%" / "18,000" into a plain number when possible, applying
// K/M/B scale. Returns null if there is no usable number.
function parseScaled(value: string): number | null {
  const m = value.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const scale = (m[2] || "").toLowerCase();
  if (scale === "k") n *= 1e3;
  else if (scale === "m") n *= 1e6;
  else if (scale === "b") n *= 1e9;
  return n;
}

function topKeywords(slide: DeckSlide, n: number): string[] {
  const counts = new Map<string, number>();
  for (const w of words(`${slide.title} ${slide.bullets.join(" ")}`)) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function isStepsSlide(slide: DeckSlide): boolean {
  if (/agenda|roadmap|timeline|steps|plan|process|journey|phases?/i.test(slide.title)) return true;
  return slide.bullets.length >= 3 && slide.bullets.every((b) => b.length <= 48);
}

// Turn one slide into a candidate overlay spec + a human label + voice aliases.
function planSlide(slide: DeckSlide): { raw: RawSpec; label: string; aliases: string[] } {
  const id = `cue-${slide.index}`;
  const titleWords = words(slide.title);
  const baseAliases = [
    slide.title.toLowerCase().trim(),
    `slide ${slide.index + 1}`,
    ...titleWords,
  ].filter(Boolean);

  // 2+ numbers → a metrics panel of the speaker's real figures.
  if (slide.numbers.length >= 2) {
    return {
      raw: {
        id,
        type: "MetricsPanel",
        position: "top-right",
        props: {
          title: slide.title || "Metrics",
          metrics: slide.numbers.slice(0, 4),
        },
      },
      label: slide.title || "Metrics",
      aliases: [...baseAliases, "numbers", "metrics", "stats", "kpis", "the numbers"],
    };
  }

  // Exactly one number → a big animated counter if it parses, else a 1-row panel.
  if (slide.numbers.length === 1) {
    const num = slide.numbers[0];
    const scaled = parseScaled(num.value);
    if (scaled != null) {
      const prefix = num.value.trim().startsWith("$") ? "$" : undefined;
      const suffix = num.value.includes("%") ? "%" : undefined;
      return {
        raw: {
          id,
          type: "BigCounter",
          position: "center-right",
          props: { value: scaled, label: num.label || slide.title || "Total", prefix, suffix },
        },
        label: num.label || slide.title || "Counter",
        aliases: [...baseAliases, num.label.toLowerCase(), "the number", "counter"].filter(Boolean),
      };
    }
    return {
      raw: {
        id,
        type: "MetricsPanel",
        position: "top-right",
        props: { title: slide.title || "Metric", metrics: [num] },
      },
      label: num.label || slide.title || "Metric",
      aliases: [...baseAliases, "numbers", num.label.toLowerCase()].filter(Boolean),
    };
  }

  // Title slide with a detected name → a broadcast lower-third.
  if (slide.index === 0 && slide.names.length > 0) {
    return {
      raw: {
        id,
        type: "LowerThird",
        position: "full-bottom",
        props: { name: slide.names[0], subtitle: slide.names[1] || slide.title || "" },
      },
      label: slide.names[0],
      aliases: [...baseAliases, "my name", "intro", "who i am", "introduction"],
    };
  }

  // Agenda / roadmap / short bullet list → a timeline stepper.
  if (isStepsSlide(slide) && slide.bullets.length >= 2) {
    return {
      raw: {
        id,
        type: "Timeline",
        position: "top-center",
        props: {
          steps: slide.bullets.slice(0, 5).map((label) => ({ label })),
          currentStep: 0,
        },
      },
      label: slide.title || "Timeline",
      aliases: [...baseAliases, "roadmap", "agenda", "steps", "timeline", "plan"],
    };
  }

  // Bullet content → glowing keyword chips.
  const kws = topKeywords(slide, 5);
  if (kws.length >= 2) {
    return {
      raw: {
        id,
        type: "KeywordHighlight",
        position: "bottom-right",
        props: { keywords: kws, color: "auto" },
      },
      label: slide.title || "Highlights",
      aliases: [...baseAliases, "keywords", "highlights", "topics"],
    };
  }

  // Nothing structured → a name bar from the title (or ChatBubble via fallback).
  return {
    raw: {
      id,
      type: "LowerThird",
      position: "full-bottom",
      props: { name: slide.title || "Slide", subtitle: "" },
    },
    label: slide.title || `Slide ${slide.index + 1}`,
    aliases: baseAliases,
  };
}

// Build the cue deck from an extracted deck. Each card is validated through the
// catalog Zod gate; anything that fails degrades to a ChatBubble (adapted=true).
export function buildCues(extract: DeckExtract): CueCard[] {
  const cards: CueCard[] = [];
  for (const slide of extract.slides) {
    if (cards.length >= MAX_CARDS) break;
    // Skip empty slides (no title, no bullets, no numbers).
    if (!slide.title && slide.bullets.length === 0 && slide.numbers.length === 0) continue;

    const { raw, label, aliases } = planSlide(slide);
    const [spec, adapted] = validateOrFallback(raw, slide.title || label);
    cards.push({
      id: `cue-${slide.index}`,
      label: label.slice(0, 42),
      aliases: [...new Set(aliases.map((a) => a.trim().toLowerCase()).filter((a) => a.length >= 3))],
      slideIndex: slide.index,
      specs: [spec],
      adapted,
    });
  }
  return cards;
}

// Compact deck view for the agent (so live speech uses real values).
export function toDeckFacts(extract: DeckExtract): DeckFacts {
  return {
    fileName: extract.fileName,
    slideCount: extract.slideCount,
    slides: extract.slides.slice(0, 24).map((s) => ({
      index: s.index,
      title: s.title,
      bullets: s.bullets.slice(0, 4),
      numbers: s.numbers.slice(0, 6),
      names: s.names.slice(0, 3),
    })),
  };
}

interface CueMatch {
  card: CueCard;
  alias: string;
  score: number;
}

type Span = readonly [start: number, end: number];

function overlapsAny(start: number, end: number, spans: readonly Span[]): boolean {
  return spans.some(([s, e]) => start < e && s < end);
}

// Evidence already spent by fired cards, RE-DERIVED against the current text:
// each fired card consumes the first occurrence of its longest alias present.
// Deriving spans fresh every update (instead of storing offsets) keeps
// consumption stable while engines rescore words, insert apostrophes, or
// split compounds, and it widens naturally as the hypothesis grows through a
// longer alias of the fired card ("quarter" fired, "next quarter plan" is
// what ends up consumed). A fired mention the engine rescored away simply
// consumes nothing; the fired card itself stays excluded regardless.
function consumedSpans(cards: CueCard[], p: string, fired: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  for (const card of cards) {
    if (!fired.has(card.id)) continue;
    let best: Span | null = null;
    let bestLen = 0;
    for (const alias of card.aliases) {
      if (alias.length <= bestLen) continue;
      const idx = p.indexOf(alias);
      if (idx === -1) continue;
      best = [idx, idx + alias.length];
      bestLen = alias.length;
    }
    if (best) spans.push(best);
  }
  return spans;
}

function bestCueMatch(
  cards: CueCard[],
  p: string,
  opts?: { fired?: ReadonlySet<string>; minScore?: number }
): CueMatch | null {
  const fired = opts?.fired;
  // Require a reasonably specific match (>= 4 chars) so single short words
  // don't hijack normal speech.
  const minScore = opts?.minScore ?? 4;
  const spans = fired?.size ? consumedSpans(cards, p, fired) : [];
  let best: CueMatch | null = null;
  for (const card of cards) {
    if (fired?.has(card.id)) continue;
    for (const alias of card.aliases) {
      if (alias.length < minScore) continue;
      // Latest occurrence that is not consumed evidence = newest usable
      // evidence; step left past occurrences a fired card already spent.
      let idx = p.lastIndexOf(alias);
      while (idx !== -1 && overlapsAny(idx, idx + alias.length, spans)) {
        idx = idx > 0 ? p.lastIndexOf(alias, idx - 1) : -1;
      }
      if (idx === -1) continue;
      const score = alias.length; // longer alias = stronger
      if (!best || score > best.score) best = { card, alias, score };
    }
  }
  return best;
}

// Find the best cue for a spoken/typed phrase. Returns the card if a confident
// alias match is found, else null (so the utterance falls through to the agent).
// firedIds carries the segment's already-fired cards into the final match:
// they are excluded outright AND the evidence they consumed cannot be
// replayed, so only a cue grounded in fresh text can fire at the final.
export function matchCue(
  cards: CueCard[],
  phrase: string,
  firedIds?: readonly string[]
): CueCard | null {
  const fired = firedIds?.length ? new Set(firedIds) : undefined;
  return bestCueMatch(cards, phrase.toLowerCase(), { fired })?.card ?? null;
}

// Cue matching on INTERIM (volatile) transcript text, so a primed card lands
// while the sentence is still being spoken instead of waiting for the
// sentence final. The state is per speech segment; the caller resets it at
// segment boundaries.
//
// The interim path is deliberately higher-precision than the final path;
// every rule below was earned by watching real hypotheses break a simpler
// design:
//
// 1. Stronger aliases only (>= 6 chars). buildCues sprays 4-5 char single
//    title words ("plan", "next", "steps") across cards; mid-hypothesis
//    those routinely belong to a sentence heading somewhere else. They
//    still fire via the final path once the sentence is complete.
// 2. A card fires only after winning TWO CONSECUTIVE updates: growing
//    hypotheses walk through other cards' aliases and 1s snapshot engines
//    revise earlier words. Cost: about one word (Web Speech) or one
//    snapshot (apple-speech) of latency.
// 3. Fired cards are excluded outright for the rest of the segment: an
//    oscillating hypothesis can never re-fire one.
// 4. Fired EVIDENCE is consumed: a fired card's strongest alias span in the
//    current text is off-limits to other cards (see consumedSpans), so one
//    spoken "the numbers" cannot chain-fire every numeric slide sharing
//    that alias, no matter how the hypothesis is revised around it. The
//    final path applies the same rule through matchCue(cards, text, fired).
export interface InterimCueState {
  firedIds: string[]; // cards fired this segment, never re-fired within it
  candidateId: string | null; // last update's winner, awaiting confirmation
}

const INTERIM_MIN_SCORE = 6;

export function matchInterimCue(
  cards: CueCard[],
  interim: string,
  state: InterimCueState | null
): { fire: CueCard | null; state: InterimCueState } {
  const prev = state ?? { firedIds: [], candidateId: null };
  const text = interim.trim();
  // Same guard as the final path: one lone word is not a command yet. An
  // empty or too-short update leaves the segment state untouched.
  if (!text || text.split(/\s+/).length < 2) return { fire: null, state: prev };
  const m = bestCueMatch(cards, text.toLowerCase(), {
    fired: new Set(prev.firedIds),
    minScore: INTERIM_MIN_SCORE,
  });
  if (!m) return { fire: null, state: { ...prev, candidateId: null } };
  if (m.card.id !== prev.candidateId) {
    return { fire: null, state: { ...prev, candidateId: m.card.id } };
  }
  return {
    fire: m.card,
    state: { firedIds: [...prev.firedIds, m.card.id], candidateId: null },
  };
}
