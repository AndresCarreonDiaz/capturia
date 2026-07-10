import { describe, expect, it } from "vitest";
import { advanceCuePointer, nextCueIndex } from "./pointer";

describe("advanceCuePointer", () => {
  it("advances past the card at the pointer", () => {
    expect(advanceCuePointer(0, 0)).toBe(1);
    expect(advanceCuePointer(3, 3)).toBe(4);
  });

  it("jumps past a card fired ahead of the pointer (voice or digit jump)", () => {
    // Presenter at the top of the rail fires card 4 by voice: the next
    // prepared card is 5, not a re-walk of 1..3.
    expect(advanceCuePointer(0, 3)).toBe(4);
  });

  it("never rewinds when a card behind the pointer fires again", () => {
    expect(advanceCuePointer(4, 1)).toBe(4);
    expect(advanceCuePointer(4, 3)).toBe(4);
  });

  it("ignores indexes that cannot be rail positions", () => {
    expect(advanceCuePointer(2, -1)).toBe(2);
    expect(advanceCuePointer(2, 1.5)).toBe(2);
    expect(advanceCuePointer(2, Number.NaN)).toBe(2);
  });
});

describe("nextCueIndex", () => {
  it("names the pointer position while it is inside the deck", () => {
    expect(nextCueIndex(0, 3)).toBe(0);
    expect(nextCueIndex(2, 3)).toBe(2);
  });

  it("goes quiet past the end instead of wrapping", () => {
    expect(nextCueIndex(3, 3)).toBeNull();
    expect(nextCueIndex(7, 3)).toBeNull();
  });

  it("is null on an empty deck and on corrupt pointers", () => {
    expect(nextCueIndex(0, 0)).toBeNull();
    expect(nextCueIndex(-1, 3)).toBeNull();
    expect(nextCueIndex(1.5, 3)).toBeNull();
  });
});

describe("the full silent walk", () => {
  it("next-next-next fires every card once and stops", () => {
    const fired: number[] = [];
    let pointer = 0;
    for (let presses = 0; presses < 5; presses++) {
      const index = nextCueIndex(pointer, 3);
      if (index === null) continue;
      fired.push(index);
      pointer = advanceCuePointer(pointer, index);
    }
    expect(fired).toEqual([0, 1, 2]);
    expect(nextCueIndex(pointer, 3)).toBeNull();
  });

  it("a mid-walk voice fire moves the walk forward, an old card does not", () => {
    let pointer = 0;
    pointer = advanceCuePointer(pointer, 0); // next hotkey fired card 1
    pointer = advanceCuePointer(pointer, 2); // voice fired card 3
    expect(nextCueIndex(pointer, 4)).toBe(3);
    pointer = advanceCuePointer(pointer, 0); // rail click on old card 1
    expect(nextCueIndex(pointer, 4)).toBe(3);
  });
});
