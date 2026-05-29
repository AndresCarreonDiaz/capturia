// Shared prop coercion for overlays. Agent-emitted JSON and deck-derived specs
// are both untrusted, so this runs before they hit React state. Extracted from
// app/studio/page.tsx so add_overlay/modify_overlay AND the deck validator
// (lib/deck/validate.ts) coerce identically and never drift apart.

export function normalizeProps(
  type: string,
  props: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...props };

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
      .map((d) => (typeof d === "number" ? d : Number((d as Record<string, unknown>)?.value ?? d)))
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
    out.currentStep = typeof cs === "number" ? cs : Number(cs ?? 0) || 0;
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
