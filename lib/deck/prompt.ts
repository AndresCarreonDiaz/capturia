import type { DeckFacts } from "./types";

// Compact catalog reference for the codegen model. Mirrors lib/catalog.ts but
// phrased for one-shot generation. The renderer builds this prompt; the Electron
// main process runs it on the user's key.
const CATALOG_REF = `Components (use ONLY these "type" values, with these props):
- MetricsPanel { title:string, metrics:[{label:string, value:string, delta?:string}] }  // 2-4 KPI rows. value is a string like "$1.8M" or "47%". delta like "+24%". Best for a slide with several numbers.
- BigCounter { value:number, label:string, prefix?:string, suffix?:string }  // ONE dramatic number (users, revenue, downloads). value is a plain number (1800000, not "1.8M"); use prefix "$" / suffix "%" or " users".
- StatRing { value:number(0-100), label:string }  // a single percentage as a donut.
- ProgressBar { progress:number(0-100), label?:string }  // completion / how far along.
- FloatingChart { data:number[], chartType:"line"|"bar", label:string }  // a trend or series of numbers.
- LowerThird { name:string, subtitle:string }  // a person's name + their role/company. Great for a title/intro slide.
- Timeline { steps:[{label:string}], currentStep:number }  // an agenda, roadmap, or ordered process.
- KeywordHighlight { keywords:string[], color:"auto" }  // a few key terms/themes. Use ONLY when a slide is genuinely just topics, not numbers or a person.
- Ticker { items:string[] }  // a scrolling band of short headlines.
- ChatBubble { text:string, author?:string }  // a quote, testimonial, or callout sentence.
- LiveBadge { label?:string }  // a tiny status pill.
- Letterbox { enabled:true }  // cinematic black bars, no position.

Positions: top-left | top-right | top-center | center-left | center-right | bottom-left | bottom-right | bottom-center | full-bottom (omit for Letterbox).`;

// Build the codegen prompt from the extracted deck. Asks for a JSON array of cue
// cards that map each meaningful slide to the BEST-fitting component, filled
// with the slide's real content.
export function buildCodegenPrompt(deck: DeckFacts): string {
  return `You are a broadcast graphics designer. A speaker will present this deck on a live call. Design a set of on-screen overlays ("cue cards") they can trigger by voice or click while talking.

${CATALOG_REF}

Rules:
- Output 6 to 12 cue cards as a JSON array, nothing else (no prose, no markdown fences).
- Each card: { "label": short human name, "aliases": 3-6 lowercase phrases the speaker might say to trigger it, "slideIndex": 0-based source slide, "type": one component type above, "position": a position, "props": props matching that component }.
- Use the slide's REAL content: exact numbers, names, and terms from the deck. Never invent figures.
- Pick the most specific component for each slide. Prefer MetricsPanel/BigCounter/StatRing/FloatingChart/Timeline/LowerThird over KeywordHighlight. Use KeywordHighlight only for slides that are genuinely just themes or topics.
- Skip pure filler slides (section dividers, thank-you slides).
- aliases should be things a speaker actually says, e.g. for a revenue slide: ["revenue","our numbers","financials","arr"].

Deck (${deck.slideCount} slides, file "${deck.fileName}"):
${JSON.stringify(deck.slides, null, 1)}

Return ONLY the JSON array.`;
}
