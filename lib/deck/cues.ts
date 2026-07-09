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

// A cue that fired this segment: the card stays excluded from matching, and
// the alias records WHICH evidence the fire consumed so it can be found
// again inside every revision of the hypothesis.
export interface FiredCue {
  id: string;
  alias: string;
}

const ANCHOR_MIN = 4;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

// An anchor occurrence must sit on word boundaries: "the number" INSIDE a
// sibling's fresh "the numbers" mention is not the fired mention, it is the
// sibling's own evidence, and consuming it would silence a genuinely new
// command (no card AND no agent fallback).
function atWordBoundary(p: string, idx: number, len: number): boolean {
  return !isWordChar(p[idx - 1]) && !isWordChar(p[idx + len]);
}

// Re-locate the evidence each fired cue consumed inside the CURRENT text.
// Anchoring is by the alias that actually fired, never the card's strongest
// alias anywhere in the sentence: the latter teleports consumption onto a
// disjoint later mention (un-consuming the real one) or onto a substring of
// a sibling's genuinely fresh evidence. Fires anchor in order, each claiming
// the leftmost whole-word occurrence no earlier fire claimed, so a repeated
// alias means distinct mentions and can never free one for a third card. If
// the engine rescored the mention, progressively shorter prefixes of the
// fired alias (down to a couple of characters, floor 4) still find it ("the
// numbers" rescored to "the number"), but only at word boundaries; beyond
// that the mention is gone and consumes nothing, though the fired card
// itself stays excluded regardless.
function consumedSpans(cards: CueCard[], p: string, fired: readonly FiredCue[]): Span[] {
  const spans: Span[] = [];
  for (const f of fired) {
    let span: Span | null = null;
    const minLen = Math.max(ANCHOR_MIN, f.alias.length - 2);
    for (let len = f.alias.length; len >= minLen && !span; len--) {
      const probe = f.alias.slice(0, len);
      let idx = p.indexOf(probe);
      while (
        idx !== -1 &&
        (overlapsAny(idx, idx + probe.length, spans) || !atWordBoundary(p, idx, probe.length))
      ) {
        idx = p.indexOf(probe, idx + 1);
      }
      if (idx !== -1) span = [idx, idx + probe.length];
    }
    if (!span) continue;
    // One mention often grows into a longer alias of the same card ("quarter"
    // becomes "next quarter plan"): widen across every OVERLAPPING occurrence
    // of the fired card's aliases so title words riding the same phrase
    // cannot leak to siblings. Overlap-only on purpose: a longer alias
    // somewhere else in the sentence must not move consumption off the
    // mention that fired.
    const card = cards.find((c) => c.id === f.id);
    if (card) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const alias of card.aliases) {
          let idx = p.indexOf(alias);
          while (idx !== -1) {
            const end = idx + alias.length;
            const overlapping = idx < span[1] && span[0] < end;
            if (
              overlapping &&
              (idx < span[0] || end > span[1]) &&
              atWordBoundary(p, idx, alias.length)
            ) {
              span = [Math.min(span[0], idx), Math.max(span[1], end)];
              grew = true;
            }
            idx = p.indexOf(alias, idx + 1);
          }
        }
      }
    }
    spans.push(span);
  }
  return spans;
}

function bestCueMatch(
  cards: CueCard[],
  p: string,
  opts?: { fired?: readonly FiredCue[]; minScore?: number }
): CueMatch | null {
  const fired = opts?.fired;
  // Require a reasonably specific match (>= 4 chars) so single short words
  // don't hijack normal speech.
  const minScore = opts?.minScore ?? 4;
  const spans = fired?.length ? consumedSpans(cards, p, fired) : [];
  const excluded = fired?.length ? new Set(fired.map((f) => f.id)) : null;
  let best: CueMatch | null = null;
  for (const card of cards) {
    if (excluded?.has(card.id)) continue;
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
// fired carries the segment's already-fired cues into the final match: their
// cards are excluded outright AND the evidence they consumed cannot be
// replayed, so only a cue grounded in fresh text can fire at the final.
export function matchCue(
  cards: CueCard[],
  phrase: string,
  fired?: readonly FiredCue[]
): CueCard | null {
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
// 4. Fired EVIDENCE is consumed: the alias occurrence each fire spent is
//    re-anchored inside every revision of the hypothesis (see consumedSpans)
//    and is off-limits to other cards, so one spoken "the numbers" cannot
//    chain-fire every numeric slide sharing that alias. The final path
//    applies the same rule through matchCue(cards, text, fired).
export interface InterimCueState {
  fired: FiredCue[]; // cues fired this segment, in firing order
  candidateId: string | null; // last update's winner, awaiting confirmation
}

const INTERIM_MIN_SCORE = 6;

export function matchInterimCue(
  cards: CueCard[],
  interim: string,
  state: InterimCueState | null
): { fire: CueCard | null; state: InterimCueState } {
  const prev = state ?? { fired: [], candidateId: null };
  const text = interim.trim();
  // Same guard as the final path: one lone word is not a command yet. An
  // empty or too-short update leaves the segment state untouched.
  if (!text || text.split(/\s+/).length < 2) return { fire: null, state: prev };
  const m = bestCueMatch(cards, text.toLowerCase(), {
    fired: prev.fired,
    minScore: INTERIM_MIN_SCORE,
  });
  if (!m) return { fire: null, state: { ...prev, candidateId: null } };
  if (m.card.id !== prev.candidateId) {
    return { fire: null, state: { ...prev, candidateId: m.card.id } };
  }
  return {
    fire: m.card,
    state: { fired: [...prev.fired, { id: m.card.id, alias: m.alias }], candidateId: null },
  };
}
