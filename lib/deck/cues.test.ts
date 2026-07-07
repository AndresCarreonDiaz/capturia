import { describe, expect, it } from "vitest";
import { matchCue, matchInterimCue } from "./cues";
import type { CueCard } from "./types";

function card(id: string, aliases: string[]): CueCard {
  return { id, label: id, aliases, slideIndex: 0, specs: [], adapted: false };
}

const CARDS: CueCard[] = [
  card("cue-1", ["revenue", "the numbers", "metrics"]),
  card("cue-2", ["roadmap", "agenda", "next quarter plan"]),
];

describe("matchCue", () => {
  it("matches the longest alias contained in the phrase", () => {
    expect(matchCue(CARDS, "let me walk you through the next quarter plan")?.id).toBe("cue-2");
  });

  it("returns null when nothing specific matches", () => {
    expect(matchCue(CARDS, "so as I was saying earlier")).toBeNull();
  });
});

describe("matchInterimCue", () => {
  it("fires on the first interim that contains an alias", () => {
    const r = matchInterimCue(CARDS, "so our revenue this", null);
    expect(r.fire?.id).toBe("cue-1");
    expect(r.nextFiredId).toBe("cue-1");
  });

  it("does not refire while the same interim segment keeps growing", () => {
    const first = matchInterimCue(CARDS, "so our revenue this", null);
    const second = matchInterimCue(CARDS, "so our revenue this year grew a lot", first.nextFiredId);
    expect(second.fire).toBeNull();
    expect(second.nextFiredId).toBe("cue-1");
  });

  it("fires a different card when a revision switches the match", () => {
    const first = matchInterimCue(CARDS, "here is our revenue", null);
    const revised = matchInterimCue(CARDS, "here is our roadmap", first.nextFiredId);
    expect(revised.fire?.id).toBe("cue-2");
    expect(revised.nextFiredId).toBe("cue-2");
  });

  it("keeps the fired id on non-matching updates so it stays deduped", () => {
    const r = matchInterimCue(CARDS, "and something unrelated entirely", "cue-1");
    expect(r.fire).toBeNull();
    expect(r.nextFiredId).toBe("cue-1");
  });

  it("holds fire on a single word, even an alias", () => {
    const r = matchInterimCue(CARDS, "revenue", null);
    expect(r.fire).toBeNull();
    expect(r.nextFiredId).toBeNull();
  });

  it("ignores empty and whitespace-only interims without dropping the segment state", () => {
    const r = matchInterimCue(CARDS, "   ", "cue-1");
    expect(r.fire).toBeNull();
    expect(r.nextFiredId).toBe("cue-1");
  });

  it("can fire the same card again in a new segment once the caller resets", () => {
    const again = matchInterimCue(CARDS, "back to the revenue picture", null);
    expect(again.fire?.id).toBe("cue-1");
  });
});
