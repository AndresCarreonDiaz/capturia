import { describe, expect, it } from "vitest";
import { buildCues, matchCue, matchInterimCue, type InterimCueState } from "./cues";
import type { CueCard, DeckExtract } from "./types";

function card(id: string, aliases: string[]): CueCard {
  return { id, label: id, aliases, slideIndex: 0, specs: [], adapted: false };
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

  it("word-by-word growth through a shared shorter alias fires only the intended card", () => {
    // "next" would match the Next Steps card one word early; the
    // confirmation rule must let the hypothesis resolve first.
    const { fired } = runInterims(
      [NEXT_STEPS, NEXT_QUARTER],
      ["so the next", "so the next quarter", "so the next quarter plan", "so the next quarter plan is"]
    );
    expect(fired).toEqual(["cue-2"]);
  });

  it("a snapshot revision flipping a substring pair fires only the revised winner", () => {
    // apple-speech style: 1s snapshots where "the number" is rescored to
    // "the numbers" (BigCounter alias is a substring of the MetricsPanel one).
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

  it("never re-fires a card within the segment, but a second card can still fire once", () => {
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
    const s: InterimCueState = { firedIds: ["cue-3"], candidateId: "cue-4" };
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

  it("behaves the same over real buildCues alias sets", () => {
    const extract: DeckExtract = {
      fileName: "deck.pdf",
      source: "pdf",
      slideCount: 2,
      slides: [
        {
          index: 0,
          title: "Next Steps",
          text: "",
          bullets: ["Ship the beta", "Collect feedback", "Iterate fast"],
          numbers: [],
          names: [],
        },
        {
          index: 1,
          title: "Next Quarter Plan",
          text: "",
          bullets: ["Grow the team", "Launch pricing", "Expand to teams"],
          numbers: [],
          names: [],
        },
      ],
    };
    const cards = buildCues(extract);
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
