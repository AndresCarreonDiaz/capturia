import { describe, expect, it } from "vitest";
import { buildCues, matchCue, matchInterimCue, type InterimCueState } from "./cues";
import type { CueCard, DeckSlide, DeckExtract } from "./types";

function card(id: string, aliases: string[]): CueCard {
  return { id, label: id, aliases, slideIndex: 0, specs: [], adapted: false };
}

function slide(partial: Partial<DeckSlide> & { index: number; title: string }): DeckSlide {
  return { text: "", bullets: [], numbers: [], names: [], ...partial };
}

function deck(slides: DeckSlide[]): DeckExtract {
  return { fileName: "deck.pdf", source: "pdf", slideCount: slides.length, slides };
}

// Numeric slides the way real pitch decks have them: buildCues gives every
// MetricsPanel the same generic aliases ("the numbers", "metrics", ...), the
// exact shape that once let one spoken mention chain-fire several cards.
function numericCards(titles: string[] = ["Q3 Results", "Unit Economics"]): CueCard[] {
  const cards = buildCues(
    deck(
      titles.map((title, index) =>
        slide({
          index,
          title,
          numbers: [
            { label: "Revenue", value: "$1.8M" },
            { label: "Margin", value: "47%" },
          ],
        })
      )
    )
  );
  expect(cards).toHaveLength(titles.length);
  return cards;
}

// Fold a realistic interim sequence through the matcher, returning the fired
// card ids in order plus the final state, the way the studio wiring does.
function runInterims(
  cards: CueCard[],
  updates: string[],
  state: InterimCueState | null = null
): { fired: string[]; state: InterimCueState | null } {
  const fired: string[] = [];
  for (const u of updates) {
    const r = matchInterimCue(cards, u, state);
    state = r.state;
    if (r.fire) fired.push(r.fire.id);
  }
  return { fired, state };
}

// Aliases shaped like buildCues really makes them: individual title words
// shared across cards, and one alias a substring of another card's.
const NEXT_STEPS = card("cue-1", ["next steps", "next", "steps"]);
const NEXT_QUARTER = card("cue-2", ["next quarter plan", "next", "quarter", "plan"]);
const BIG_COUNTER = card("cue-3", ["revenue", "the number", "counter"]);
const METRICS = card("cue-4", ["metrics", "the numbers", "stats"]);

describe("matchCue", () => {
  it("matches the longest alias contained in the phrase", () => {
    expect(matchCue([NEXT_STEPS, NEXT_QUARTER], "walk through the next quarter plan")?.id).toBe("cue-2");
  });

  it("returns null when nothing specific matches", () => {
    expect(matchCue([NEXT_STEPS, NEXT_QUARTER], "so as I was saying earlier")).toBeNull();
  });
});

describe("matchInterimCue", () => {
  it("fires only after the same card wins two consecutive updates", () => {
    const { fired } = runInterims([BIG_COUNTER], ["so our revenue", "so our revenue this year"]);
    expect(fired).toEqual(["cue-3"]);
  });

  it("holds fire on a single win", () => {
    const { fired, state } = runInterims([BIG_COUNTER], ["so our revenue"]);
    expect(fired).toEqual([]);
    expect(state?.candidateId).toBe("cue-3");
  });

  it("short title-word aliases never fire mid-sentence, even when they persist", () => {
    // "plan" (4 chars) heads a sentence that ends up about next steps; the
    // interim floor keeps it from firing the quarter-plan card while the
    // hypothesis is still resolving. Proven failing on an earlier design.
    const { fired } = runInterims(
      [NEXT_STEPS, NEXT_QUARTER],
      [
        "let's plan",
        "let's plan out",
        "let's plan out the",
        "let's plan out the next",
        "let's plan out the next steps",
        "let's plan out the next steps together",
      ]
    );
    expect(fired).toEqual(["cue-1"]);
  });

  it("word-by-word growth through a shared shorter alias fires only the intended card", () => {
    const { fired } = runInterims(
      [NEXT_STEPS, NEXT_QUARTER],
      ["so the next", "so the next quarter", "so the next quarter plan", "so the next quarter plan is"]
    );
    expect(fired).toEqual(["cue-2"]);
  });

  it("a snapshot revision flipping a substring pair fires only the revised winner", () => {
    const { fired } = runInterims(
      [BIG_COUNTER, METRICS],
      ["show the number here", "show the numbers here we", "show the numbers here we can"]
    );
    expect(fired).toEqual(["cue-4"]);
  });

  it("an oscillating hypothesis never fires anything", () => {
    const { fired } = runInterims(
      [BIG_COUNTER, METRICS],
      ["look at the number", "look at the numbers", "look at the number", "look at the numbers"]
    );
    expect(fired).toEqual([]);
  });

  it("fires at most once per segment, however long the sentence grows", () => {
    // Real buildCues siblings share the generic "the numbers" alias; one
    // mention must fire exactly one card. Earlier multi-fire designs
    // chain-fired the sibling here; the single-fire rule closes the whole
    // class by construction.
    const cards = numericCards(["Q3 Results", "Unit Economics", "Growth Funnel"]);
    const { fired } = runInterims(cards, [
      "let's look at the numbers",
      "let's look at the numbers for",
      "let's look at the numbers for this",
      "the numbers here and again the numbers over there",
      "the numbers here and again the numbers over there okay",
    ]);
    expect(fired).toEqual([cards[0].id]);
  });

  it("stays fired across arbitrary revisions of the hypothesis", () => {
    // Pluralizing rescores, insertions, and full rewrites after the fire
    // must never produce a second card within the segment.
    const { fired } = runInterims(
      [BIG_COUNTER, METRICS],
      [
        "look at the number",
        "look at the number here",
        "look at all the numbers here we",
        "a number of signups doubled and show the numbers",
        "something entirely different with metrics and stats galore",
      ]
    );
    expect(fired).toEqual(["cue-3"]);
  });

  it("a second spoken cue fires in the NEXT segment after a pause", () => {
    // The documented model: one cue per breath. The pause closes the
    // segment (state resets to null) and the matcher re-arms.
    const first = runInterims([BIG_COUNTER, METRICS], ["so the revenue", "so the revenue this"]);
    expect(first.fired).toEqual(["cue-3"]);
    const second = runInterims([BIG_COUNTER, METRICS], ["now the metrics", "now the metrics too"]);
    expect(second.fired).toEqual(["cue-4"]);
  });

  it("empty and whitespace updates leave the segment state untouched", () => {
    const s: InterimCueState = { firedId: "cue-3", candidateId: null };
    const r = matchInterimCue([BIG_COUNTER, METRICS], "   ", s);
    expect(r.fire).toBeNull();
    expect(r.state).toEqual(s);
  });

  it("holds fire on a lone word, even a perfect alias", () => {
    const { fired, state } = runInterims([BIG_COUNTER], ["revenue", "revenue"]);
    expect(fired).toEqual([]);
    expect(state?.candidateId).toBeNull();
  });

  it("a non-matching update clears the pending candidate", () => {
    const { fired } = runInterims(
      [BIG_COUNTER],
      ["so our revenue", "and something else entirely", "so our revenue again"]
    );
    expect(fired).toEqual([]);
  });

  it("a new segment (state reset to null) can fire the same card again", () => {
    const first = runInterims([BIG_COUNTER], ["our revenue is", "our revenue is up"]);
    expect(first.fired).toEqual(["cue-3"]);
    const second = runInterims([BIG_COUNTER], ["that revenue again", "that revenue again please"]);
    expect(second.fired).toEqual(["cue-3"]);
  });

  it("behaves the same over real buildCues alias sets for steps slides", () => {
    const cards = buildCues(
      deck([
        slide({
          index: 0,
          title: "Next Steps",
          bullets: ["Ship the beta", "Collect feedback", "Iterate fast"],
        }),
        slide({
          index: 1,
          title: "Next Quarter Plan",
          bullets: ["Grow the team", "Launch pricing", "Expand to teams"],
        }),
      ])
    );
    expect(cards).toHaveLength(2);
    const { fired } = runInterims(cards, [
      "so the next",
      "so the next quarter",
      "so the next quarter plan",
      "so the next quarter plan is",
    ]);
    expect(fired).toEqual([cards[1].id]);
  });
});
