// Redis-backed vote rooms (M10, issue #9): the same contract as the
// in-memory lib/vote-store.ts, atomically enforced by two Lua scripts so a
// serverless deploy (Vercel + Upstash) keeps exactly the semantics the
// in-memory store defines: hostKey claims the room, rounds key on the
// option SET (label edits keep counts), one live vote per viewer with
// switching, per-viewer rate limit, voter cap, TTL.
//
// No SSE listeners here: serverless invocations share nothing, so the route
// bridges watch-mode by polling getRoomState (the host tally animates
// changes anyway). The command runner is injected for testability; real
// deployments build one from env via lib/upstash.ts.

import type { RedisRunner } from "./upstash";
import {
  ROOM_ID_RE,
  MAX_VOTERS,
  MIN_VOTE_INTERVAL_MS,
  type PollDef,
  type PollOption,
  type StoreResult,
  type VoteEvent,
} from "./vote-store";

const KEY_RE = /^[a-z0-9-]{8,64}$/i;
const MAX_OPTIONS = 12;
const MAX_TITLE = 120;
const MAX_LABEL = 80;
const MAX_ACTION = 60;
const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
// Same cap as the in-memory MAX_ROOMS: enough for many parallel talks,
// bounded against unauthenticated key-minting on the metered backend.
const MAX_ROOMS = 100;
const ROOMS_INDEX_KEY = "vote:rooms";

// KEYS: meta hash, counts hash, voters hash, rooms index zset
// ARGV: hostKey, pollJson, optionSetKey, ttlMs, actionsJson, roomId, nowMs, maxRooms
// Returns: {"403"} | {"503"} | {"ok", round, countsJson}
const PUBLISH_LUA = `
local meta, counts, voters, roomsIdx = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hostKey, pollJson, optKey, ttl = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
local actions = cjson.decode(ARGV[5])
local roomId, now, maxRooms = ARGV[6], tonumber(ARGV[7]), tonumber(ARGV[8])

local owner = redis.call('HGET', meta, 'hostKey')
if owner and owner ~= hostKey then
  return {'403'}
end
if not owner then
  -- Room cap, mirroring the in-memory MAX_ROOMS: purge index entries whose
  -- rooms have idled past the TTL, then refuse the creation that would
  -- exceed the cap. Without this, an unauthenticated curl loop mints
  -- unbounded keys on the metered backend.
  redis.call('ZREMRANGEBYSCORE', roomsIdx, '-inf', now - ttl)
  if redis.call('ZCARD', roomsIdx) >= maxRooms then
    return {'503'}
  end
  redis.call('HSET', meta, 'hostKey', hostKey)
  redis.call('HSET', meta, 'round', 0)
end
redis.call('ZADD', roomsIdx, now, roomId)

local prevOptKey = redis.call('HGET', meta, 'optKey')
if prevOptKey ~= optKey then
  redis.call('HINCRBY', meta, 'round', 1)
  redis.call('DEL', counts, voters)
  for i = 1, #actions do
    redis.call('HSET', counts, actions[i], 0)
  end
  redis.call('HSET', meta, 'optKey', optKey)
end
redis.call('HSET', meta, 'poll', pollJson)
redis.call('PEXPIRE', meta, ttl)
redis.call('PEXPIRE', counts, ttl)
redis.call('PEXPIRE', voters, ttl)

local round = redis.call('HGET', meta, 'round')
local raw = redis.call('HGETALL', counts)
return {'ok', round, cjson.encode(raw)}
`;

// KEYS: meta hash, counts hash, voters hash, rate-limit key, rooms index zset
// ARGV: viewerId, action, minIntervalMs, maxVoters, ttlMs, roomId, nowMs
// Returns: {status, round, pollJson|'', countsJson}
//   status: ok | 404 | 422 | 429 | 409 | 503
const VOTE_LUA = `
local meta, counts, voters, rl = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local roomsIdx = KEYS[5]
local viewerId, action = ARGV[1], ARGV[2]
local minInterval, maxVoters, ttl = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local roomId, now = ARGV[6], tonumber(ARGV[7])

local pollJson = redis.call('HGET', meta, 'poll')
if not pollJson then
  return {'404', '0', '', '{}'}
end
local round = redis.call('HGET', meta, 'round') or '0'

local function snapshot(status)
  return {status, round, pollJson, cjson.encode(redis.call('HGETALL', counts))}
end

if redis.call('HEXISTS', counts, action) == 0 then
  return snapshot('422')
end
if redis.call('EXISTS', rl) == 1 then
  return snapshot('429')
end
local previous = redis.call('HGET', voters, viewerId)
if previous == action then
  return snapshot('409')
end
if not previous and redis.call('HLEN', voters) >= maxVoters then
  return snapshot('503')
end

redis.call('SET', rl, '1', 'PX', minInterval)
if previous then
  local prev = tonumber(redis.call('HGET', counts, previous)) or 0
  if prev > 0 then
    redis.call('HINCRBY', counts, previous, -1)
  end
end
redis.call('HINCRBY', counts, action, 1)
redis.call('HSET', voters, viewerId, action)
redis.call('PEXPIRE', meta, ttl)
redis.call('PEXPIRE', counts, ttl)
redis.call('PEXPIRE', voters, ttl)
redis.call('ZADD', roomsIdx, now, roomId)
return snapshot('ok')
`;

// KEYS: meta hash, counts hash, voters hash, rooms index zset
// ARGV: ttlMs, roomId, nowMs
// One atomic snapshot (no torn read between meta and counts) that also
// refreshes the TTL, mirroring the in-memory touchedAt-on-read semantics so
// a watched-but-quiet room (tally left on screen for hours) never expires
// mid-display.
const STATE_LUA = `
local meta, counts, voters, roomsIdx = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local ttl, roomId, now = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3])
local pollJson = redis.call('HGET', meta, 'poll')
if not pollJson then
  return {'0', '', '{}'}
end
local round = redis.call('HGET', meta, 'round') or '0'
redis.call('PEXPIRE', meta, ttl)
redis.call('PEXPIRE', counts, ttl)
redis.call('PEXPIRE', voters, ttl)
redis.call('ZADD', roomsIdx, now, roomId)
return {round, pollJson, cjson.encode(redis.call('HGETALL', counts))}
`;

function keys(roomId: string) {
  return {
    meta: `vote:${roomId}:meta`,
    counts: `vote:${roomId}:counts`,
    voters: `vote:${roomId}:voters`,
  };
}

// Redis HGETALL over REST arrives as a flat [field, value, ...] array.
function countsFromFlat(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    out[String(raw[i])] = Number(raw[i + 1]) || 0;
  }
  return out;
}

function countsFromJson(json: unknown): Record<string, number> {
  try {
    return countsFromFlat(JSON.parse(String(json)));
  } catch {
    return {};
  }
}

// Same whitelist validation as the in-memory store; duplicated deliberately
// (the in-memory validPoll is module-private) and pinned by shared tests.
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

function optionSetKey(options: PollOption[]): string {
  return JSON.stringify(options.map((o) => o.actionName).sort());
}

export interface RedisVoteStore {
  publishPoll(roomId: string, hostKey: string, poll: unknown): Promise<StoreResult>;
  castVote(roomId: string, viewerId: string, action: string): Promise<StoreResult>;
  getRoomState(roomId: string): Promise<VoteEvent>;
}

export function createRedisVoteStore(run: RedisRunner): RedisVoteStore {
  return {
    async publishPoll(roomId, hostKey, poll) {
      if (!ROOM_ID_RE.test(roomId) || !KEY_RE.test(hostKey)) {
        return { ok: false, status: 422, error: "invalid room or key" };
      }
      if (!validPoll(poll)) return { ok: false, status: 422, error: "invalid poll" };
      const cleanPoll: PollDef = {
        title: poll.title,
        options: poll.options.map((o) => ({ actionName: o.actionName, label: o.label })),
      };
      const k = keys(roomId);
      const res = (await run([
        "EVAL",
        PUBLISH_LUA,
        4,
        k.meta,
        k.counts,
        k.voters,
        ROOMS_INDEX_KEY,
        hostKey,
        JSON.stringify(cleanPoll),
        optionSetKey(cleanPoll.options),
        ROOM_TTL_MS,
        JSON.stringify(cleanPoll.options.map((o) => o.actionName)),
        roomId,
        Date.now(),
        MAX_ROOMS,
      ])) as unknown[];
      if (!Array.isArray(res)) {
        return { ok: false, status: 500, error: "bad store reply" };
      }
      if (res[0] === "403") return { ok: false, status: 403, error: "not the host" };
      if (res[0] === "503") return { ok: false, status: 503, error: "room limit reached" };
      const event: VoteEvent = {
        type: "state",
        round: Number(res[1]) || 0,
        poll: cleanPoll,
        counts: countsFromJson(res[2]),
      };
      return { ok: true, event };
    },

    async castVote(roomId, viewerId, action) {
      if (!KEY_RE.test(viewerId)) {
        return { ok: false, status: 422, error: "invalid viewer id" };
      }
      const k = keys(roomId);
      const res = (await run([
        "EVAL",
        VOTE_LUA,
        5,
        k.meta,
        k.counts,
        k.voters,
        `vote:${roomId}:rl:${viewerId}`,
        ROOMS_INDEX_KEY,
        viewerId,
        action,
        MIN_VOTE_INTERVAL_MS,
        MAX_VOTERS,
        ROOM_TTL_MS,
        roomId,
        Date.now(),
      ])) as unknown[];
      if (!Array.isArray(res)) {
        return { ok: false, status: 500, error: "bad store reply" };
      }
      const [status, round, pollJson, countsJson] = res;
      if (status === "404") return { ok: false, status: 404, error: "no active poll" };

      let poll: PollDef | null = null;
      try {
        poll = pollJson ? (JSON.parse(String(pollJson)) as PollDef) : null;
      } catch {
        poll = null;
      }
      const event: VoteEvent = {
        type: "vote",
        round: Number(round) || 0,
        poll,
        counts: countsFromJson(countsJson),
      };
      if (status === "ok") return { ok: true, event };
      const map: Record<string, { status: number; error: string }> = {
        "422": { status: 422, error: "unknown option" },
        "429": { status: 429, error: "too fast" },
        "409": { status: 409, error: "already voted" },
        "503": { status: 503, error: "room full" },
      };
      const mapped = map[String(status)] ?? { status: 500, error: "bad store reply" };
      return { ok: false, ...mapped, event };
    },

    async getRoomState(roomId) {
      const k = keys(roomId);
      const res = (await run([
        "EVAL",
        STATE_LUA,
        4,
        k.meta,
        k.counts,
        k.voters,
        ROOMS_INDEX_KEY,
        ROOM_TTL_MS,
        roomId,
        Date.now(),
      ])) as unknown[];
      if (!Array.isArray(res)) {
        return { type: "state", round: 0, poll: null, counts: {} };
      }
      const [round, pollJson, countsJson] = res;
      let poll: PollDef | null = null;
      try {
        poll = pollJson ? (JSON.parse(String(pollJson)) as PollDef) : null;
      } catch {
        poll = null;
      }
      return {
        type: "state",
        round: Number(round) || 0,
        poll,
        counts: countsFromJson(countsJson),
      };
    },
  };
}
