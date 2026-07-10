import type { OverlaySpec } from "@/lib/types";

// Pure model for studio state mirroring: the visible Control Room (the
// PRIMARY studio instance) broadcasts its live state over a BroadcastChannel,
// and every Program Output page loaded with ?out=1 (a RECEIVER: the desktop
// app's offscreen camera window, or a second tab of the SAME browser) adopts
// it. That is what puts the operator's overlays on the published camera feed:
// the offscreen window is a separate studio instance with its own React
// state, and it deliberately has no preload (a security decision, see
// electron/camera-feed.js), so a plain same-origin web channel is the bridge.
// The channel's reach is one browser profile (or one Electron session): a
// second tab of your browser mirrors, but an OBS Browser Source is OBS's own
// embedded browser and will NOT receive the mirror; capture the ?out=1 tab
// with a window/tab capture instead (docs/virtual-camera.md).
//
// One direction only: primaries publish, receivers adopt, and a receiver
// never posts anything except the initial "hello" that requests a snapshot
// (late-join: an out page opened after state exists must not wait for the
// next change). Receivers also never run speech, never publish a vote room,
// and never open agent runs; the studio page gates those on the role.
//
// Liveness: a primary reannounces its snapshot every MIRROR_KEEPALIVE_MS and
// posts a "bye" on pagehide, so a receiver never renders a dead Control
// Room's overlays (and vote QR) forever: it blanks on the bye, or after
// MIRROR_STALE_AFTER_MS without any message from its adopted sender when the
// primary died without one (crash, killed tab).
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

// Primary keepalive cadence: the full snapshot is small (bounded upstream by
// lib/limits.ts) and reannouncing it doubles as self-healing for any missed
// message, so a plain low-rate republish beats a separate ping type.
export const MIRROR_KEEPALIVE_MS = 5_000;

// A receiver considers its adopted sender dead after this long without ANY
// message from it. More than two keepalive periods, so one delayed or
// dropped keepalive (a busy main thread mid-agent-turn) never blanks a
// healthy feed.
export const MIRROR_STALE_AFTER_MS = 12_000;

// How often a receiver checks the staleness bound. Coarse on purpose: the
// exact blanking moment does not matter, only that it is bounded.
export const MIRROR_STALE_CHECK_MS = 1_000;

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
  // Primary -> receivers: the full current state. Sent on every state change,
  // on the keepalive cadence, and in reply to hello; `from` identifies the
  // sender for adoption.
  | { kind: "state"; from: string; snapshot: MirrorSnapshot }
  // Primary -> receivers: a speech result just landed (energy heartbeat).
  | { kind: "speak"; from: string }
  // Primary -> receivers: this sender is going away (pagehide). Receivers
  // adopted to it blank immediately instead of waiting out the stale bound.
  | { kind: "bye"; from: string };

// The mirror role is fixed by how the page was LOADED: ?out=1 marks the
// dedicated output surfaces (the offscreen camera window, a captured tab).
// Deliberately not tied to the outputMode React state: the operator toggling
// Program Output inside the Control Room (Cmd+Shift+O) is still the primary,
// just chrome-free, and must keep publishing.
export function detectMirrorRole(search: string): MirrorRole {
  return new URLSearchParams(search).get("out") === "1" ? "receiver" : "primary";
}

// The same URL minus the ?out flag: where a receiver page navigates when the
// operator asks it to become a Control Room. A receiver must NEVER just flip
// outputMode off in place: its local state is inert by design (the feed
// renders the adopted snapshot), so revealing the operator chrome without a
// reload would present controls whose effects can never render, and voice or
// typed commands would burn real agent turns invisibly. A full navigation
// re-runs role detection and boots a genuine primary.
export function controlRoomSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("out");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

// Throttle gate for speak pings (see SPEAK_PING_MIN_INTERVAL_MS).
export function speakPingDue(lastSentAt: number, now: number): boolean {
  return now - lastSentAt >= SPEAK_PING_MIN_INTERVAL_MS;
}

// Staleness bound for an adopted sender (see MIRROR_STALE_AFTER_MS).
export function adoptionStale(lastHeardAt: number, now: number): boolean {
  return now - lastHeardAt > MIRROR_STALE_AFTER_MS;
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
  if (m.kind === "speak" || m.kind === "bye") {
    return typeof m.from === "string" && m.from !== "" ? { kind: m.kind, from: m.from } : null;
  }
  if (m.kind === "state") {
    if (typeof m.from !== "string" || m.from === "") return null;
    const snapshot = sanitizeSnapshot(m.snapshot);
    return snapshot ? { kind: "state", from: m.from, snapshot } : null;
  }
  return null;
}
