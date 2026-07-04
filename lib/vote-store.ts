// In-memory vote rooms for audience voting. One studio session = one room:
// the studio publishes the current poll (hostKey-authenticated, so only the
// room's creator can change it), viewers vote from their phones, and both
// sides subscribe to live counts (SSE in the route).
//
// Deliberately in-memory and single-process: the supported deployments are
// the operator's own machine (in-room audiences on the same WiFi reach it via
// the LAN IP) and small self-hosts (`next start`, Docker). On a serverless
// host rooms would not survive across invocations; the README says so rather
// than adding a hosted store, per the free-demo cost discipline.
//
// All functions take an optional `now` so TTL / rate-limit behavior is
// unit-testable without clock mocking.

export interface PollOption {
  actionName: string;
  label: string;
}
export interface PollDef {
  title: string;
  options: PollOption[];
}
// Sent to every subscriber on state changes and votes, and returned by the
// plain GET. `round` increments whenever the option set changes (a new poll),
// so clients know to clear their local "already voted" state.
export interface VoteEvent {
  type: "state" | "vote";
  round: number;
  poll: PollDef | null;
  counts: Record<string, number>;
}

interface Room {
  hostKey: string;
  poll: PollDef | null;
  round: number;
  counts: Map<string, number>; // actionName -> votes
  voters: Map<string, string>; // viewerId -> actionName last voted (switch allowed)
  lastVoteAt: Map<string, number>; // viewerId -> ts (rate limit)
  listeners: Set<(e: VoteEvent) => void>;
  touchedAt: number;
}

export const ROOM_ID_RE = /^[a-z0-9]{8,32}$/i;
const KEY_RE = /^[a-z0-9-]{8,64}$/i;
const MAX_ROOMS = 100;
const MAX_OPTIONS = 12;
const MAX_TITLE = 120;
const MAX_LABEL = 80;
const MAX_ACTION = 60;
const MAX_LISTENERS = 300;
// Per-room voter cap: the per-viewer rate limit is keyed on a CLIENT-chosen
// viewerId, so minting fresh ids would both stuff ballots and grow the
// voters/lastVoteAt maps without bound. The cap turns that into a bounded
// nuisance; 2000 is far above any realistic audience for a single feed.
export const MAX_VOTERS = 2000;
const ROOM_TTL_MS = 4 * 60 * 60 * 1000; // longer than any talk
export const MIN_VOTE_INTERVAL_MS = 750;

// Survive Next dev hot-reload re-evaluating this module: rooms live on
// globalThis, keyed privately. Production builds evaluate once anyway.
const g = globalThis as unknown as { __capturiaVoteRooms?: Map<string, Room> };
const rooms: Map<string, Room> = (g.__capturiaVoteRooms ??= new Map());

function sweep(now: number) {
  for (const [id, room] of rooms) {
    if (now - room.touchedAt > ROOM_TTL_MS) {
      room.listeners.clear();
      rooms.delete(id);
    }
  }
}

function toCounts(room: Room): Record<string, number> {
  return Object.fromEntries(room.counts);
}

function emit(room: Room, type: VoteEvent["type"]) {
  const event: VoteEvent = {
    type,
    round: room.round,
    poll: room.poll,
    counts: toCounts(room),
  };
  for (const fn of room.listeners) {
    try {
      fn(event);
    } catch {
      room.listeners.delete(fn); // dead SSE controller: drop it
    }
  }
}

// Round identity keys on the SET of actionNames only, not labels: a cosmetic
// label edit (typo fix, restyle, localization) to a live poll must keep the
// accumulated votes, so it must not change this key. actionNames are the vote
// currency and are unique per validPoll.
function optionSetKey(options: PollOption[]): string {
  return JSON.stringify(options.map((o) => o.actionName).sort());
}

function validPoll(poll: unknown): poll is PollDef {
  if (!poll || typeof poll !== "object") return false;
  const p = poll as PollDef;
  if (typeof p.title !== "string" || p.title.length > MAX_TITLE) return false;
  if (!Array.isArray(p.options) || p.options.length === 0 || p.options.length > MAX_OPTIONS)
    return false;
  const seen = new Set<string>();
  for (const o of p.options) {
    if (!o || typeof o !== "object") return false;
    if (typeof o.actionName !== "string" || !o.actionName || o.actionName.length > MAX_ACTION)
      return false;
    if (typeof o.label !== "string" || !o.label || o.label.length > MAX_LABEL) return false;
    if (seen.has(o.actionName)) return false;
    seen.add(o.actionName);
  }
  return true;
}

export type StoreResult =
  | { ok: true; event: VoteEvent }
  | { ok: false; status: number; error: string; event?: VoteEvent };

/**
 * Create-or-update the room's poll. The first publisher claims the room with
 * its hostKey (room ids are crypto-random client slugs, so claiming requires
 * the studio's own id). Re-publishing the same option set keeps the counts
 * (the agent may re-author the surface cosmetically); a different option set
 * starts a fresh round.
 */
export function publishPoll(
  roomId: string,
  hostKey: string,
  poll: unknown,
  now = Date.now()
): StoreResult {
  sweep(now);
  if (!ROOM_ID_RE.test(roomId) || !KEY_RE.test(hostKey)) {
    return { ok: false, status: 422, error: "invalid room or key" };
  }
  if (!validPoll(poll)) return { ok: false, status: 422, error: "invalid poll" };

  // Store a whitelisted copy, never the raw client object: validPoll only
  // checks the fields it knows about, so unknown keys of any size would ride
  // along in room.poll and get re-broadcast to every SSE listener on every
  // vote. Rebuilding from known fields bounds memory and fan-out.
  const cleanPoll: PollDef = {
    title: poll.title,
    options: poll.options.map((o) => ({ actionName: o.actionName, label: o.label })),
  };

  let room = rooms.get(roomId);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return { ok: false, status: 503, error: "room limit reached" };
    room = {
      hostKey,
      poll: null,
      round: 0,
      counts: new Map(),
      voters: new Map(),
      lastVoteAt: new Map(),
      listeners: new Set(),
      touchedAt: now,
    };
    rooms.set(roomId, room);
  }
  if (room.hostKey !== hostKey) return { ok: false, status: 403, error: "not the host" };

  const changed =
    !room.poll || optionSetKey(room.poll.options) !== optionSetKey(cleanPoll.options);
  room.poll = cleanPoll;
  room.touchedAt = now;
  if (changed) {
    room.round += 1;
    room.counts = new Map(cleanPoll.options.map((o) => [o.actionName, 0]));
    room.voters.clear();
  }
  emit(room, "state");
  return { ok: true, event: { type: "state", round: room.round, poll: room.poll, counts: toCounts(room) } };
}

/**
 * One live vote per viewer, switching allowed: voting a different option moves
 * the viewer's vote (decrement old, increment new); re-voting the same option
 * is a no-op conflict. Rate-limited per viewer.
 */
export function castVote(
  roomId: string,
  viewerId: string,
  action: string,
  now = Date.now()
): StoreResult {
  sweep(now);
  const room = rooms.get(roomId);
  if (!room || !room.poll) return { ok: false, status: 404, error: "no active poll" };
  if (!KEY_RE.test(viewerId)) return { ok: false, status: 422, error: "invalid viewer id" };
  if (!room.poll.options.some((o) => o.actionName === action)) {
    return { ok: false, status: 422, error: "unknown option" };
  }

  const event = (): VoteEvent => ({
    type: "vote",
    round: room.round,
    poll: room.poll,
    counts: toCounts(room),
  });

  const last = room.lastVoteAt.get(viewerId) ?? 0;
  if (now - last < MIN_VOTE_INTERVAL_MS) {
    return { ok: false, status: 429, error: "too fast", event: event() };
  }
  if (!room.voters.has(viewerId) && room.voters.size >= MAX_VOTERS) {
    return { ok: false, status: 503, error: "room full", event: event() };
  }
  const previous = room.voters.get(viewerId);
  if (previous === action) {
    return { ok: false, status: 409, error: "already voted", event: event() };
  }

  room.lastVoteAt.set(viewerId, now);
  if (previous) room.counts.set(previous, Math.max(0, (room.counts.get(previous) ?? 0) - 1));
  room.counts.set(action, (room.counts.get(action) ?? 0) + 1);
  room.voters.set(viewerId, action);
  room.touchedAt = now;
  emit(room, "vote");
  return { ok: true, event: event() };
}

/** Current state for the plain GET; never creates a room. */
export function getRoomState(roomId: string, now = Date.now()): VoteEvent {
  sweep(now);
  const room = rooms.get(roomId);
  if (!room) return { type: "state", round: 0, poll: null, counts: {} };
  room.touchedAt = now;
  return { type: "state", round: room.round, poll: room.poll, counts: toCounts(room) };
}

/**
 * Subscribe to a room's events. Requires the room to exist (viewers arrive via
 * the QR after the studio published) so unknown ids cannot allocate memory;
 * the viewer page falls back to polling until the poll appears.
 */
export function subscribe(
  roomId: string,
  fn: (e: VoteEvent) => void,
  now = Date.now()
): { ok: boolean; unsubscribe: () => void } {
  sweep(now);
  const room = rooms.get(roomId);
  if (!room || room.listeners.size >= MAX_LISTENERS) {
    return { ok: false, unsubscribe: () => {} };
  }
  room.listeners.add(fn);
  room.touchedAt = now;
  return { ok: true, unsubscribe: () => room.listeners.delete(fn) };
}

/** Test hook: wipe all rooms. */
export function _resetVoteStore() {
  rooms.clear();
}
