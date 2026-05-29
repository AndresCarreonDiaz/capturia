import type { DeckExtract, DeckSlide, DeckNumber } from "./types";

// Conservative "label: value" / "label - value" detector. Requires a real digit
// in the value so we don't turn prose into fake metrics. Handles $, %, K/M/B.
const NUMBER_RE = /([A-Za-z][A-Za-z &/'+-]{1,28}?)\s*[:–-]\s*(\$?\d[\d.,]*\s*[KMBkmb]?%?)/g;

const MAX_PAGES = 40;

function detectNumbers(text: string): DeckNumber[] {
  const out: DeckNumber[] = [];
  const seen = new Set<string>();
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(text)) && out.length < 6) {
    const label = m[1].trim();
    const value = m[2].replace(/\s+/g, "");
    const key = label.toLowerCase();
    if (label.length < 2 || seen.has(key) || !/\d/.test(value)) continue;
    seen.add(key);
    out.push({ label, value });
  }
  return out;
}

function detectNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const line of lines.slice(0, 8)) {
    const t = line.trim();
    // 1-3 capitalized words, not ALL CAPS, reasonable length: looks like a name.
    if (/^([A-Z][a-z]+)(\s+[A-Z][a-z]+){0,2}$/.test(t) && t.length <= 40) {
      names.push(t);
    }
  }
  return [...new Set(names)].slice(0, 4);
}

interface TextItemish {
  str?: string;
  transform?: number[];
  height?: number;
}

// Extract a deck's structure entirely in the browser (works on web and desktop
// alike, no server, no hosted parsing). The worker is served from /public.
export async function extractPdf(file: File): Promise<DeckExtract> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const slides: DeckSlide[] = [];
  const pageCount = Math.min(doc.numPages, MAX_PAGES);

  for (let i = 1; i <= pageCount; i++) {
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();

      const items = (content.items as TextItemish[])
        .filter((it) => typeof it.str === "string" && it.str.trim())
        .map((it) => ({
          str: it.str as string,
          x: it.transform?.[4] ?? 0,
          y: Math.round(it.transform?.[5] ?? 0),
          size: Math.abs(it.transform?.[3] ?? it.height ?? 0),
        }));

      // Group items into lines by their y position, top of page first.
      const byY = new Map<number, typeof items>();
      for (const it of items) {
        const arr = byY.get(it.y);
        if (arr) arr.push(it);
        else byY.set(it.y, [it]);
      }
      const lines = [...byY.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([, its]) => ({
          size: Math.max(...its.map((t) => t.size)),
          text: its
            .sort((a, b) => a.x - b.x)
            .map((t) => t.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        }))
        .filter((l) => l.text);

      const text = lines.map((l) => l.text).join("\n");
      // Title: the largest-font line in the top half, else the first line.
      const topHalf = lines.slice(0, Math.max(1, Math.ceil(lines.length / 2)));
      const title = (
        [...topHalf].sort((a, b) => b.size - a.size)[0]?.text ||
        lines[0]?.text ||
        ""
      ).slice(0, 80);
      const bullets = lines
        .map((l) => l.text)
        .filter((t) => t !== title && t.length >= 2 && t.length <= 120)
        .slice(0, 8);

      slides.push({
        index: i - 1,
        title,
        text,
        bullets,
        numbers: detectNumbers(text),
        names: i === 1 ? detectNames(lines.map((l) => l.text)) : [],
      });
    } catch {
      // Skip unreadable pages rather than failing the whole import.
    }
  }

  return { fileName: file.name, source: "pdf", slideCount: slides.length, slides };
}
