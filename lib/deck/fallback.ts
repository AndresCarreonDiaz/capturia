import { validateSpec, type RawSpec } from "./validate";
import type { OverlaySpec } from "@/lib/types";

// Always-valid last resort. ChatBubble only requires { text }, so it validates
// unconditionally, guaranteeing a cue card never ends up empty.
export function safeChatBubble(
  id: string,
  text: string,
  position = "top-left"
): OverlaySpec {
  const clean = (text || "Slide").trim().slice(0, 140);
  return validateSpec({
    id,
    type: "ChatBubble",
    position,
    props: { text: clean },
  })!;
}

// Validate a candidate spec; if it fails the catalog gate, fall back to a
// ChatBubble carrying the slide title. Returns [spec, adapted] where adapted
// means the original intent was downgraded.
export function validateOrFallback(
  raw: RawSpec,
  fallbackText: string
): [OverlaySpec, boolean] {
  const ok = validateSpec(raw);
  if (ok) return [ok, false];
  return [safeChatBubble(raw.id, fallbackText, raw.position), true];
}
