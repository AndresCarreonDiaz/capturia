import { describe, expect, it } from "vitest";
import { buildCues, matchCue, matchInterimCue, type InterimCueState } from "./cues";
import type { CueCard, DeckExtract, DeckSlide } from "./types";

function card(id: string, aliases: string[]): CueCard {
  return { id, label: id, aliases, slideIndex: 0, specs: [], adapted: false };
}

function slide(partial: Partial<DeckSlide> & { index: number; title: string }): DeckSlide {
  return { text: "", bullets: [], numbers: [], names: [], ...partial };
}

function deck(slides: DeckSlide[]): DeckExtract {
  return { fileName: "deck.pdf", source: "pdf", slideCount: slides.length, slides };
}

// Two numeric slides the way real pitch decks have them: buildCues gives both
// MetricsPanels the same generic aliases ("the numbers", "metrics", ...), the
// exact shape that makes one spoken mention able to chain-fire both cards.
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

  it("excludes fired cards so one cannot shadow a second cue at the final", () => {
    expect(matchCue([BIG_COUNTER, METRICS], "revenue and then the metrics", [{ id: "cue-3", alias: "revenue" }])?.id).toBe("cue-4");
  });

  it("does not replay consumed evidence into a sibling card sharing the alias", () => {
    // The interim path fired cards[0] off "the numbers"; the sentence final
    // still contains that same mention and nothing else. The sibling numeric
    // card must not ride it. Proven failing on the previous design.
    const cards = numericCards();
    expect(matchCue(cards, "let's look at the numbers for this quarter", [{ id: cards[0].id, alias: "the numbers" }])).toBeNull();
  });

  it("consumption widens to the fired card's longest alias present in the final", () => {
    // The interim path fired the quarter card off "quarter" alone; by the
    // final the sentence grew the stronger "next quarter plan", and the
    // steps card must not ride the leftover "plan" and "next" title words.
    expect(matchCue([NEXT_STEPS, NEXT_QUARTER], "the next quarter plan is simple", [{ id: "cue-2", alias: "quarter" }])).toBeNull();
  });

  it("a second cue grounded in fresh text still fires at the final", () => {
    expect(
      matchCue([BIG_COUNTER, METRICS], "show the numbers here and the revenue counter", [{ id: "cue-4", alias: "the numbers" }])?.id
    ).toBe("cue-3");
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
    // hypothesis is still resolving. Proven failing on the previous design.
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

  it("consumed evidence cannot chain-fire another card sharing the alias", () => {
    // One mention of "the numbers" must fire exactly one card no matter how
    // long the sentence keeps growing. Proven failing on the previous
    // design (both MetricsPanels fired and stacked).
    const cards = numericCards();
    const { fired } = runInterims(cards, [
      "let's look at the numbers",
      "let's look at the numbers for",
      "let's look at the numbers for this",
      "let's look at the numbers for this quarter",
    ]);
    expect(fired).toEqual([cards[0].id]);
  });

  it("a one-character rescore around consumed evidence cannot double-fire a sibling", () => {
    // apple-speech and Web Speech both revise earlier words; here the engine
    // inserts an apostrophe after the fire. An offset-based consumption
    // design shifted the consumed mention past its stored boundary and fired
    // the second MetricsPanel; re-anchoring by alias text must not.
    const cards = numericCards();
    const { fired } = runInterims(cards, [
      "lets look at the numbers",
      "lets look at the numbers for",
      "let's look at the numbers for",
      "let's look at the numbers for this",
    ]);
    expect(fired).toEqual([cards[0].id]);
  });

  it("a revision inserting words before consumed evidence cannot double-fire a sibling", () => {
    const cards = numericCards();
    const { fired } = runInterims(cards, [
      "look at the numbers",
      "look at the numbers for",
      "well look at the numbers for this quarter",
      "well look at the numbers for this quarter and",
    ]);
    expect(fired).toEqual([cards[0].id]);
  });

  it("a genuinely repeated mention is fresh evidence and can fire the sibling card", () => {
    // Saying the shared alias a second time is a real second cue: the first
    // occurrence stays consumed, the new one drives the next numeric card.
    const cards = numericCards();
    const { fired } = runInterims(cards, [
      "the numbers here",
      "the numbers here and",
      "the numbers here and again the numbers",
      "the numbers here and again the numbers over there",
    ]);
    expect(fired).toEqual([cards[0].id, cards[1].id]);
  });

  it("the final transcript cannot chain-fire a sibling from evidence the interim path consumed", () => {
    // End to end the way the studio wires it: interims fire cards[0], then
    // the sentence final goes through matchCue with the segment's fired ids.
    const cards = numericCards();
    const { fired, state } = runInterims(cards, [
      "let's look at the numbers",
      "let's look at the numbers for",
    ]);
    expect(fired).toEqual([cards[0].id]);
    expect(matchCue(cards, "let's look at the numbers for this quarter", state?.fired)).toBeNull();
  });

  it("with three cards sharing the alias, two mentions fire exactly two cards", () => {
    // Fired cues claim DISTINCT occurrences in firing order; a design that
    // anchored every fired card to the first occurrence left the second
    // mention unconsumed and chain-fired a third MetricsPanel.
    const cards = numericCards(["Q3 Results", "Unit Economics", "Growth Funnel"]);
    const text = "the numbers here and again the numbers over there okay";
    const { fired, state } = runInterims(cards, [
      "the numbers here",
      "the numbers here and",
      "the numbers here and again the numbers",
      "the numbers here and again the numbers over",
      "the numbers here and again the numbers over there",
      text,
    ]);
    expect(fired).toEqual([cards[0].id, cards[1].id]);
    expect(matchCue(cards, text, state?.fired)).toBeNull();
  });

  it("a longer alias of the fired card elsewhere cannot teleport consumption off the real mention", () => {
    // The fired card's slide title appearing later in the sentence must not
    // re-anchor consumption there and free "the numbers" for the sibling.
    const cards = numericCards(["Quarterly Financial Results", "Unit Economics"]);
    const { fired } = runInterims(cards, [
      "let's look at the numbers",
      "let's look at the numbers in",
      "let's look at the numbers in our quarterly financial results",
      "let's look at the numbers in our quarterly financial results now",
    ]);
    expect(fired).toEqual([cards[0].id]);
  });

  it("a rescore that destroys the fired alias still consumes the mention for substring siblings", () => {
    // "the numbers" fired, then the engine drops the plural: the surviving
    // "the number" is the same spoken evidence and must not fire the
    // BigCounter, mid-sentence or at the final.
    const { fired, state } = runInterims(
      [BIG_COUNTER, METRICS],
      [
        "show the numbers here",
        "show the numbers here we",
        "show the number here we can",
        "show the number here we can see",
      ]
    );
    expect(fired).toEqual(["cue-4"]);
    expect(matchCue([BIG_COUNTER, METRICS], "show the number here we can see", state?.fired)).toBeNull();
  });

  it("consumption stays on the fired evidence and cannot steal a sibling's fresh mention", () => {
    // The BigCounter fired off "revenue"; its "the number" alias also lives
    // INSIDE the sibling's fresh "the numbers" mention. Anchoring by the
    // fired alias keeps that mention free so the second cue still fires,
    // mid-sentence and at the final.
    const { fired } = runInterims(
      [BIG_COUNTER, METRICS],
      [
        "so the revenue",
        "so the revenue this",
        "so the revenue this now look at the numbers",
        "so the revenue this now look at the numbers everyone",
      ]
    );
    expect(fired).toEqual(["cue-3", "cue-4"]);
    expect(
      matchCue([BIG_COUNTER, METRICS], "so the revenue this now look at the numbers", [
        { id: "cue-3", alias: "revenue" },
      ])?.id
    ).toBe("cue-4");
  });

  it("a second cue spoken later in the sentence still fires once", () => {
    const { fired } = runInterims(
      [BIG_COUNTER, METRICS],
      [
        "first the revenue picture",
        "first the revenue picture shows",
        "first the revenue picture shows growth and then the metrics",
        "first the revenue picture shows growth and then the metrics for the team",
      ]
    );
    expect(fired).toEqual(["cue-3", "cue-4"]);
  });

  it("holds fire on a lone word, even a perfect alias", () => {
    const { fired, state } = runInterims([BIG_COUNTER], ["revenue"]);
    expect(fired).toEqual([]);
    expect(state?.candidateId).toBeNull();
  });

  it("empty and whitespace updates leave the segment state untouched", () => {
    const s: InterimCueState = { fired: [{ id: "cue-3", alias: "revenue" }], candidateId: "cue-4" };
    const r = matchInterimCue([BIG_COUNTER, METRICS], "   ", s);
    expect(r.fire).toBeNull();
    expect(r.state).toEqual(s);
  });

  it("a non-matching update clears the pending candidate", () => {
    const first = matchInterimCue([BIG_COUNTER], "so our revenue", null);
    const second = matchInterimCue([BIG_COUNTER], "and something unrelated entirely", first.state);
    expect(second.state.candidateId).toBeNull();
    const third = matchInterimCue([BIG_COUNTER], "back to our revenue picture", second.state);
    expect(third.fire).toBeNull(); // needs its two consecutive wins again
  });

  it("a new segment (state reset to null) can fire the same card again", () => {
    const { fired } = runInterims(
      [BIG_COUNTER],
      ["back to the revenue picture", "back to the revenue picture from before"],
      null
    );
    expect(fired).toEqual(["cue-3"]);
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
      "so the next quarter plan is simple",
    ]);
    expect(fired).toEqual([cards[1].id]);
  });
});
