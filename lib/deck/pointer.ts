// The silent-hotkey walk over the deck rail (issue #15, silent triggers).
// The pointer is the rail index the "next card" hotkey (Cmd/Ctrl+Alt+Right)
// fires; it is per session and per deck (the studio resets it to 0 whenever
// the deck changes). Any fired card advances the pointer past itself no
// matter what fired it (rail click, voice match, digit hotkey, the next
// hotkey), so "next" always means "the first card after the one the
// presenter most recently landed", which is what a presentation-clicker
// user expects. Firing a card BEHIND the pointer never rewinds the walk,
// and the walk never wraps: past the last card, "next" goes quiet instead
// of surprising a live feed with the deck's first overlay again.

// New pointer after the card at firedIndex landed on the feed. Indexes that
// cannot be rail positions leave the walk untouched.
export function advanceCuePointer(pointer: number, firedIndex: number): number {
  if (!Number.isInteger(firedIndex) || firedIndex < 0) return pointer;
  return firedIndex >= pointer ? firedIndex + 1 : pointer;
}

// The rail index the next-card hotkey would fire right now, or null when
// the walk is past the end of the deck (never wraps).
export function nextCueIndex(pointer: number, cardCount: number): number | null {
  if (!Number.isInteger(pointer) || pointer < 0) return null;
  return pointer < cardCount ? pointer : null;
}
