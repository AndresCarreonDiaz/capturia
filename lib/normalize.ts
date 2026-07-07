// Shared prop coercion for overlays. Agent-emitted JSON and deck-derived specs
// are both untrusted, so this runs before they hit React state. Extracted from
// app/studio/page.tsx so add_overlay/modify_overlay AND the deck validator
// (lib/deck/validate.ts) coerce identically and never drift apart.

import { ensureLegibleAccent } from "./legibility";

// Props that tint feed surfaces. Every one of them goes through the
// legibility gate: a too-dark accent gets lifted, an unparseable value falls
// back to the component's tuned default.
const ACCENT_PROPS = ["color", "accent"] as const;

export function normalizeProps(
  type: string,
  props: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...props };

  for (const key of ACCENT_PROPS) {
    if (!(key in out)) continue;
    // KeywordHighlight's "auto" is a documented palette mode, not a color.
    if (type === "KeywordHighlight" && key === "color" && out[key] === "auto") continue;
    const safe = ensureLegibleAccent(out[key]);
    if (safe !== undefined) {
      out[key] = safe;
    } else if (type === "KeywordHighlight" && key === "color") {
      // Required by the schema; the auto palette is the legible fallback.
      out[key] = "auto";
    } else {
      delete out[key];
    }
  }

  if (type === "KeywordHighlight") {
    const kws = out.keywords;
    if (typeof kws === "string") {
      out.keywords = kws.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(kws)) {
      out.keywords = kws.map((k: unknown) =>
        typeof k === "string" ? k : (k as Record<string, string>)?.text ?? String(k)
      );
    }
  }

  if (type === "FloatingChart" && Array.isArray(out.data)) {
    out.data = (out.data as unknown[])
      .map((d) => {
        if (typeof d === "number") return d;
        if (typeof d === "string") return Number(d);
        if (d && typeof d === "object") return Number((d as Record<string, unknown>).value);
        return NaN; // null / boolean / undefined: drop rather than fabricate a 0
      })
      .filter((n) => Number.isFinite(n));
  }

  if (type === "MetricsPanel") {
    const raw = out.metrics;
    out.metrics = Array.isArray(raw)
      ? (raw as unknown[])
          .map((m) => {
            if (!m || typeof m !== "object") return null;
            const r = m as Record<string, unknown>;
            if (typeof r.label !== "string") return null;
            return {
              label: r.label,
              value: typeof r.value === "string" ? r.value : String(r.value ?? ""),
              delta:
                r.delta == null
                  ? undefined
                  : typeof r.delta === "string"
                  ? r.delta
                  : String(r.delta),
            };
          })
          .filter(Boolean)
      : [];
  }

  if (type === "Timeline") {
    const raw = out.steps;
    out.steps = Array.isArray(raw)
      ? (raw as unknown[])
          .map((s) => {
            if (typeof s === "string") return { label: s };
            if (s && typeof s === "object") {
              const label = (s as Record<string, unknown>).label;
              if (typeof label === "string") return { label };
            }
            return null;
          })
          .filter(Boolean)
      : [];
    const cs = out.currentStep;
    // isFinite guards a literal NaN (typeof "number"), which would otherwise
    // pass through and fail the whole spec at the Zod gate.
    out.currentStep =
      typeof cs === "number" && Number.isFinite(cs) ? cs : Number(cs ?? 0) || 0;
  }

  if (type === "CountdownTimer") {
    // Models sometimes send seconds as a string ("300"); coerce before Zod.
    const raw = out.seconds;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isFinite(n)) out.seconds = n;
    }
  }

  if (type === "Ticker") {
    const raw = out.items;
    if (typeof raw === "string") {
      out.items = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      out.items = (raw as unknown[]).map((it) =>
        typeof it === "string" ? it : (it as Record<string, string>)?.text ?? String(it)
      );
    } else {
      out.items = [];
    }
  }

  return out;
}
