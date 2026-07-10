import type { OverlaySpec } from "@/lib/types";

// Pure model for studio state mirroring: the visible Control Room (the
// PRIMARY studio instance) broadcasts its live state over a BroadcastChannel,
// and every Program Output page loaded with ?out=1 (a RECEIVER: the desktop
// app's offscreen camera window, or an OBS browser-source tab on web) adopts
// it. That is what puts the operator's overlays on the published camera feed:
// the offscreen window is a separate studio instance with its own React
// state, and it deliberately has no preload (a security decision, see
// electron/camera-feed.js), so a plain same-origin web channel is the bridge.
//
// One direction only: primaries publish, receivers adopt, and a receiver
// never posts anything except the initial "hello" that requests a snapshot
// (late-join: an out page opened after state exists must not wait for the
// next change). Receivers also never run speech, never publish a vote room,
// and never open agent runs; the studio page gates those on the role.
//
// Two primaries (say, a second /studio tab on web) is handled by the simplest
// correct rule: EVERY non-out instance publishes, and receivers adopt the
// most recent sender's state wholesale (speak pings are only honored from
// that same sender, so a silent tab cannot pulse the feed). Two open control
// rooms will therefore fight for the camera page and the last writer wins;
// that limitation is accepted and documented here rather than papered over
// with an election protocol.
//
// Everything mirrored is JSON-safe plain data (the overlays array is already
// sanitized/normalized before it reaches state), so it survives the channel's
// structured clone as-is.

// Same-origin channel shared by every studio instance in this browser
// profile / Electron session.
export const MIRROR_CHANNEL_NAME = "capturia:studio-mirror";

// Speak pings ride the primary's speech RESULT events (which arrive every
// 300-600ms during continuous speech), throttled so a bursty recognizer can
// never flood the channel. Must stay comfortably under SPEAK_WINDOW_MS
// (lib/energy.ts) or the receiver's envelope would decay between pings.
export const SPEAK_PING_MIN_INTERVAL_MS = 150;

export type MirrorRole = "primary" | "receiver";

// The slice of studio state a Program Output page needs to render the same
// broadcast picture as the Control Room.
export interface MirrorSnapshot {
  // The full overlay state (leaf overlays and authored surfaces alike).
  overlays: OverlaySpec[];
  // Render leaf overlays through the A2UI runtime instead of direct React.
  surfaceMode: boolean;
  // Audio-reactive FX master switch (vignette + overlay breathing).
  fxOn: boolean;
  // True while the primary's mic is live AND its FX are on: the receiver has
  // no speech engine, so this plus the speak pings drive its own --mic-energy
  // envelope (hooks/useSpeechEnergy.ts runs identically on both sides).
  listening: boolean;
  // The primary's vote-room URL while audience voting is on, else null. The
  // room id is minted per tab (hooks/useVoteRoom.ts), so the receiver must
  // show the PRIMARY's QR verbatim; deriving its own would strand voters in
  // an empty room nobody tallies.
  voteUrl: string | null;
}

export type MirrorMessage =
  // Receiver -> primaries: "I just loaded, publish your current snapshot."
  | { kind: "hello" }
  // Primary -> receivers: the full current state. Sent on every state change
  // and in reply to hello; `from` identifies the sender for adoption.
  | { kind: "state"; from: string; snapshot: MirrorSnapshot }
  // Primary -> receivers: a speech result just landed (energy heartbeat).
  | { kind: "speak"; from: string };

// The mirror role is fixed by how the page was LOADED: ?out=1 marks the
// dedicated output surfaces (offscreen camera window, OBS browser source).
// Deliberately not tied to the outputMode React state: the operator toggling
// Program Output inside the Control Room (Cmd+Shift+O) is still the primary,
// just chrome-free, and must keep publishing.
export function detectMirrorRole(search: string): MirrorRole {
  return new URLSearchParams(search).get("out") === "1" ? "receiver" : "primary";
}

// Throttle gate for speak pings (see SPEAK_PING_MIN_INTERVAL_MS).
export function speakPingDue(lastSentAt: number, now: number): boolean {
  return now - lastSentAt >= SPEAK_PING_MIN_INTERVAL_MS;
}

// Minimal structural check so one malformed overlay cannot crash the render
// of the published feed. NOT a re-run of the studio's deep validation: state
// only reaches a primary through normalizeProps / sanitizeSurfaceTree, so by
// the time it is broadcast it is already vetted. This guards the receiver
// against version-skewed senders (an old tab left open across a deploy).
export function isMirrorableOverlay(raw: unknown): raw is OverlaySpec {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return false;
  if (typeof o.type !== "string" || o.type === "") return false;
  if (!o.props || typeof o.props !== "object") return false;
  // Letterbox is the one overlay without an anchor position.
  if (o.type !== "Letterbox" && typeof o.position !== "string") return false;
  return true;
}

function sanitizeSnapshot(raw: unknown): MirrorSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.overlays)) return null;
  return {
    overlays: s.overlays.filter(isMirrorableOverlay),
    surfaceMode: s.surfaceMode === true,
    fxOn: s.fxOn === true,
    listening: s.listening === true,
    voteUrl: typeof s.voteUrl === "string" && s.voteUrl !== "" ? s.voteUrl : null,
  };
}

// Parse + validate an incoming channel message. Returns null for anything
// that is not a well-formed mirror message so the receiver can ignore it
// silently (the channel name is public within the origin; being defensive
// here is cheaper than trusting every future sender forever).
export function parseMirrorMessage(data: unknown): MirrorMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.kind === "hello") return { kind: "hello" };
  if (m.kind === "speak") {
    return typeof m.from === "string" && m.from !== "" ? { kind: "speak", from: m.from } : null;
  }
  if (m.kind === "state") {
    if (typeof m.from !== "string" || m.from === "") return null;
    const snapshot = sanitizeSnapshot(m.snapshot);
    return snapshot ? { kind: "state", from: m.from, snapshot } : null;
  }
  return null;
}
