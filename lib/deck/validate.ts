import { catalogDefinitions, overlayPositionSchema, type CatalogKey } from "@/lib/catalog";
import { normalizeProps } from "@/lib/normalize";
import type { OverlaySpec } from "@/lib/types";

export interface RawSpec {
  id: string;
  type: string;
  position?: string;
  props: Record<string, unknown>;
}

// The single validation gate for deck-derived overlays. Reuses the SAME
// coercion (normalizeProps) and the SAME Zod schemas (catalogDefinitions) that
// the live agent path uses, so a deck spec can never render something the
// agent path couldn't. Returns a typed OverlaySpec or null on failure.
export function validateSpec(raw: RawSpec): OverlaySpec | null {
  const def = catalogDefinitions[raw.type as CatalogKey];
  if (!def) return null;

  const props = normalizeProps(raw.type, { ...raw.props });
  const parsed = def.props.safeParse(props);
  if (!parsed.success) return null;

  // Letterbox has no position; everything else needs a valid anchor, defaulting
  // to a safe corner if the proposed one is invalid.
  if (raw.type === "Letterbox") {
    return { id: raw.id, type: "Letterbox", props: parsed.data } as OverlaySpec;
  }
  const pos = overlayPositionSchema.safeParse(raw.position);
  const position = pos.success ? pos.data : "top-left";
  return {
    id: raw.id,
    type: raw.type,
    position,
    props: parsed.data,
  } as OverlaySpec;
}
