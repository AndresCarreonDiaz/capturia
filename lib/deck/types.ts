import type { OverlaySpec } from "@/lib/types";

// A single detected "label: value" pair from a slide (e.g. Revenue / $1.8M).
export interface DeckNumber {
  label: string;
  value: string;
}

export interface DeckSlide {
  index: number; // 0-indexed
  title: string;
  text: string; // full slide text, joined
  bullets: string[];
  numbers: DeckNumber[];
  names: string[]; // capitalized phrases that look like people/brands
}

export interface DeckExtract {
  fileName: string;
  source: "pdf";
  slideCount: number;
  slides: DeckSlide[];
}

// A pre-built, validated overlay (or set of overlays) the speaker can trigger
// by clicking or by saying one of its aliases. specs are already validated
// against the catalog Zod schemas; adapted=true means at least one spec fell
// back to the nearest catalog component.
export interface CueCard {
  id: string;
  label: string;
  aliases: string[]; // lowercase phrases for voice/click matching
  slideIndex: number;
  specs: OverlaySpec[];
  adapted: boolean;
}

// Compact, agent-readable view of the deck so live speech is answered with the
// speaker's real values instead of invented ones.
export interface DeckFacts {
  fileName: string;
  slideCount: number;
  slides: {
    index: number;
    title: string;
    bullets: string[];
    numbers: DeckNumber[];
    names: string[];
  }[];
}
