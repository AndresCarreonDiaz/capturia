import { describe, it, expect } from "vitest";
import { derivePollFromOverlays } from "@/lib/derive-poll";
import type { OverlaySpec } from "@/lib/types";

// derivePollFromOverlays decides what the AUDIENCE gets to vote on, so the
// mapping from authored surface to poll must be exact.

function surface(id: string, components: Record<string, unknown>[]): OverlaySpec {
  return { id, type: "Surface", position: "bottom-center", props: { components } } as OverlaySpec;
}

const POLL_SURFACE = surface("poll", [
  { id: "root", component: "Column", children: ["q", "row"] },
  { id: "q", component: "ChatBubble", text: "Ship it?" },
  { id: "row", component: "Row", children: ["yes", "no"] },
  { id: "yes", component: "ActionButton", label: "Yes", actionName: "poll-yes" },
  { id: "no", component: "ActionButton", label: "No", actionName: "poll-no" },
]);

describe("derivePollFromOverlays", () => {
  it("maps the first ActionButton surface to a poll, title from its ChatBubble", () => {
    const poll = derivePollFromOverlays([
      { id: "badge", type: "LiveBadge", position: "top-left", props: {} } as OverlaySpec,
      POLL_SURFACE,
    ]);
    expect(poll).toEqual({
      title: "Ship it?",
      options: [
        { actionName: "poll-yes", label: "Yes" },
        { actionName: "poll-no", label: "No" },
      ],
    });
  });

  it("returns null when no surface carries buttons", () => {
    expect(derivePollFromOverlays([])).toBeNull();
    expect(
      derivePollFromOverlays([
        surface("s", [
          { id: "root", component: "Column", children: ["a"] },
          { id: "a", component: "LiveBadge" },
        ]),
      ])
    ).toBeNull();
  });

  it("falls back to a generic title without a ChatBubble and skips button-less surfaces", () => {
    const poll = derivePollFromOverlays([
      surface("decor", [
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "StatRing", value: 1, label: "x" },
      ]),
      surface("vote", [
        { id: "root", component: "Row", children: ["go", "stop"] },
        { id: "go", component: "ActionButton", label: "Go", actionName: "go" },
        { id: "stop", component: "ActionButton", label: "Stop", actionName: "stop" },
      ]),
    ]);
    expect(poll).toEqual({
      title: "Live poll",
      options: [
        { actionName: "go", label: "Go" },
        { actionName: "stop", label: "Stop" },
      ],
    });
  });

  it("does NOT treat a single-button surface as a poll (it is a reveal/step control)", () => {
    // A lone ActionButton is a "Reveal results" / "Next" control. Deriving a
    // poll from it would drop a QR on the feed and make the operator's tap
    // count as a vote instead of firing the [ACTION] turn that advances it.
    const poll = derivePollFromOverlays([
      surface("reveal", [
        { id: "root", component: "Row", children: ["go"] },
        { id: "go", component: "ActionButton", label: "Reveal results", actionName: "show-results" },
      ]),
    ]);
    expect(poll).toBeNull();
  });
});
