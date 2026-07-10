import { describe, expect, it } from "vitest";
import {
  MIRROR_KEEPALIVE_MS,
  MIRROR_STALE_AFTER_MS,
  SPEAK_PING_MIN_INTERVAL_MS,
  adoptionStale,
  controlRoomSearch,
  detectMirrorRole,
  isMirrorableOverlay,
  parseMirrorMessage,
  speakPingDue,
  type MirrorSnapshot,
} from "./mirror";
import type { OverlaySpec } from "./types";

const overlay = (over: Partial<Record<string, unknown>> = {}): OverlaySpec =>
  ({
    id: "lt-1",
    type: "LowerThird",
    position: "bottom-left",
    props: { name: "Alex", subtitle: "Founder" },
    ...over,
  }) as OverlaySpec;

const snapshot = (over: Partial<MirrorSnapshot> = {}): MirrorSnapshot => ({
  overlays: [overlay()],
  surfaceMode: false,
  fxOn: true,
  listening: false,
  voteUrl: null,
  ...over,
});

describe("detectMirrorRole", () => {
  it("marks ?out=1 pages as receivers", () => {
    expect(detectMirrorRole("?out=1")).toBe("receiver");
    expect(detectMirrorRole("?fx=0&out=1")).toBe("receiver");
  });

  it("everything else is a primary, including no query at all", () => {
    expect(detectMirrorRole("")).toBe("primary");
    expect(detectMirrorRole("?vote=1")).toBe("primary");
    // The flag must be exactly "1": out=0 or a bare out are not output pages.
    expect(detectMirrorRole("?out=0")).toBe("primary");
    expect(detectMirrorRole("?out")).toBe("primary");
  });
});

describe("controlRoomSearch", () => {
  it("strips the out flag, keeping everything else", () => {
    expect(controlRoomSearch("?out=1")).toBe("");
    expect(controlRoomSearch("?out=1&fx=0")).toBe("?fx=0");
    expect(controlRoomSearch("?vote=1&out=1&surface=1")).toBe("?vote=1&surface=1");
  });

  it("is a no-op shape for a query without out", () => {
    expect(controlRoomSearch("")).toBe("");
    expect(controlRoomSearch("?fx=0")).toBe("?fx=0");
  });
});

describe("speakPingDue", () => {
  it("allows the first ping and pings past the throttle window", () => {
    expect(speakPingDue(0, SPEAK_PING_MIN_INTERVAL_MS)).toBe(true);
    expect(speakPingDue(1000, 1000 + SPEAK_PING_MIN_INTERVAL_MS)).toBe(true);
  });

  it("suppresses pings inside the throttle window", () => {
    expect(speakPingDue(1000, 1000 + SPEAK_PING_MIN_INTERVAL_MS - 1)).toBe(false);
  });
});

describe("adoptionStale", () => {
  it("stays fresh through the whole stale window", () => {
    expect(adoptionStale(1000, 1000 + MIRROR_STALE_AFTER_MS)).toBe(false);
  });

  it("goes stale past the bound", () => {
    expect(adoptionStale(1000, 1000 + MIRROR_STALE_AFTER_MS + 1)).toBe(true);
  });

  it("outlives at least two keepalive periods, so one dropped keepalive never blanks", () => {
    expect(MIRROR_STALE_AFTER_MS).toBeGreaterThan(2 * MIRROR_KEEPALIVE_MS);
  });
});

describe("isMirrorableOverlay", () => {
  it("accepts a positioned overlay and a Letterbox without one", () => {
    expect(isMirrorableOverlay(overlay())).toBe(true);
    expect(
      isMirrorableOverlay({ id: "lb", type: "Letterbox", props: { enabled: true } })
    ).toBe(true);
  });

  it("rejects structurally broken entries", () => {
    expect(isMirrorableOverlay(null)).toBe(false);
    expect(isMirrorableOverlay("LowerThird")).toBe(false);
    expect(isMirrorableOverlay(overlay({ id: "" }))).toBe(false);
    expect(isMirrorableOverlay(overlay({ type: undefined }))).toBe(false);
    expect(isMirrorableOverlay(overlay({ props: undefined }))).toBe(false);
    // Anything but Letterbox needs an anchor position.
    expect(isMirrorableOverlay(overlay({ position: undefined }))).toBe(false);
  });
});

describe("parseMirrorMessage", () => {
  it("round-trips hello, speak, and bye", () => {
    expect(parseMirrorMessage({ kind: "hello" })).toEqual({ kind: "hello" });
    expect(parseMirrorMessage({ kind: "speak", from: "abc" })).toEqual({
      kind: "speak",
      from: "abc",
    });
    expect(parseMirrorMessage({ kind: "bye", from: "abc" })).toEqual({
      kind: "bye",
      from: "abc",
    });
  });

  it("rejects a speak ping or bye without a sender", () => {
    expect(parseMirrorMessage({ kind: "speak" })).toBeNull();
    expect(parseMirrorMessage({ kind: "speak", from: "" })).toBeNull();
    expect(parseMirrorMessage({ kind: "bye" })).toBeNull();
    expect(parseMirrorMessage({ kind: "bye", from: "" })).toBeNull();
  });

  it("round-trips a full state message", () => {
    const snap = snapshot({
      surfaceMode: true,
      listening: true,
      voteUrl: "http://192.168.1.20:3000/vote/abc123",
    });
    expect(parseMirrorMessage({ kind: "state", from: "p1", snapshot: snap })).toEqual({
      kind: "state",
      from: "p1",
      snapshot: snap,
    });
  });

  it("filters broken overlays out of a state message instead of dropping it", () => {
    const good = overlay();
    const msg = parseMirrorMessage({
      kind: "state",
      from: "p1",
      snapshot: snapshot({ overlays: [good, { id: "bad" }, null] as never }),
    });
    expect(msg?.kind).toBe("state");
    expect(msg?.kind === "state" && msg.snapshot.overlays).toEqual([good]);
  });

  it("coerces flag fields defensively (version-skewed senders)", () => {
    const msg = parseMirrorMessage({
      kind: "state",
      from: "p1",
      snapshot: {
        overlays: [],
        surfaceMode: "yes",
        fxOn: 1,
        listening: undefined,
        voteUrl: "",
      },
    });
    expect(msg?.kind === "state" && msg.snapshot).toEqual({
      overlays: [],
      surfaceMode: false,
      fxOn: false,
      listening: false,
      voteUrl: null,
    });
  });

  it("rejects junk wholesale", () => {
    expect(parseMirrorMessage(null)).toBeNull();
    expect(parseMirrorMessage("hello")).toBeNull();
    expect(parseMirrorMessage({ kind: "nope" })).toBeNull();
    expect(parseMirrorMessage({ kind: "state", from: "p1" })).toBeNull();
    expect(parseMirrorMessage({ kind: "state", from: "p1", snapshot: {} })).toBeNull();
    expect(parseMirrorMessage({ kind: "state", from: "", snapshot: snapshot() })).toBeNull();
  });
});
