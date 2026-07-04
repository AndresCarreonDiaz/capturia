import type { PollDef } from "@/lib/vote-store";
import type { OverlaySpec } from "@/lib/types";

// A poll needs at least two choices. A surface with a SINGLE ActionButton is a
// reveal / step / next control, not a poll: treating it as one would drop a QR
// on the feed and, worse, make the operator's tap count as a vote instead of
// advancing the scene (the [ACTION] turn would never fire). Two or more
// buttons is the signal.
const MIN_POLL_OPTIONS = 2;

// The poll currently on screen, derived from overlay state: the first
// agent-authored surface that carries 2+ ActionButtons becomes the audience
// poll, its options keyed by the buttons' actionNames. The title comes from
// the surface's ChatBubble when present (the poll recipe in the system prompt
// authors one). Pure so the studio can memoize a single call and tests can
// pin the mapping.
export function derivePollFromOverlays(overlays: OverlaySpec[]): PollDef | null {
  for (const overlay of overlays) {
    if (overlay.type !== "Surface") continue;
    const nodes = overlay.props.components;
    const options = nodes
      .filter((n) => n.component === "ActionButton")
      .map((n) => ({ actionName: String(n.actionName ?? ""), label: String(n.label ?? "") }))
      .filter((opt) => opt.actionName && opt.label);
    if (options.length < MIN_POLL_OPTIONS) continue;
    const bubble = nodes.find((n) => n.component === "ChatBubble");
    const title = typeof bubble?.text === "string" ? bubble.text : "Live poll";
    return { title, options };
  }
  return null;
}
