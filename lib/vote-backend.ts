// Picks the vote-room backend once per process: Upstash Redis when its env
// vars exist (the Vercel integration sets them on click), else the in-memory
// single-process store. Local dev, tests, and the free self-host path stay
// dependency-free and cost-free; the hosted pro deploy gets rooms that
// survive serverless invocations. Same result shapes either way, so the
// route treats them identically; only live push (subscribe) is
// memory-exclusive, and the route bridges watch-mode by polling when absent.

import {
  publishPoll as memPublishPoll,
  unpublishPoll as memUnpublishPoll,
  castVote as memCastVote,
  getRoomState as memGetRoomState,
  subscribe as memSubscribe,
  type StoreResult,
  type VoteEvent,
} from "./vote-store";
import { createRedisVoteStore } from "./vote-store-redis";
import { createRedisRunner, upstashFromEnv } from "./upstash";

export interface VoteBackend {
  mode: "memory" | "redis";
  publishPoll(roomId: string, hostKey: string, poll: unknown): Promise<StoreResult>;
  castVote(roomId: string, viewerId: string, action: string): Promise<StoreResult>;
  getRoomState(roomId: string): Promise<VoteEvent>;
  // Host teardown on the studio's voting toggle-off. Memory-only for now:
  // Redis rooms just idle out on their TTL until the Durable Objects backend
  // owns the room lifecycle (issue #12); the route answers 501 without it.
  unpublishPoll?(roomId: string, hostKey: string): Promise<StoreResult>;
  // In-process push, only when the store lives in this process.
  subscribe?: typeof memSubscribe;
}

let cached: VoteBackend | null = null;

// env is a plain string map (see upstashFromEnv) so tests can pass literal
// subsets without casting around Next's required NODE_ENV augmentation.
export function getVoteBackend(env: Record<string, string | undefined> = process.env): VoteBackend {
  if (cached) return cached;
  const upstash = upstashFromEnv(env);
  if (upstash) {
    const store = createRedisVoteStore(createRedisRunner(upstash));
    cached = {
      mode: "redis",
      publishPoll: store.publishPoll,
      castVote: store.castVote,
      getRoomState: store.getRoomState,
    };
  } else {
    cached = {
      mode: "memory",
      publishPoll: async (roomId, hostKey, poll) => memPublishPoll(roomId, hostKey, poll),
      unpublishPoll: async (roomId, hostKey) => memUnpublishPoll(roomId, hostKey),
      castVote: async (roomId, viewerId, action) => memCastVote(roomId, viewerId, action),
      getRoomState: async (roomId) => memGetRoomState(roomId),
      subscribe: memSubscribe,
    };
  }
  return cached;
}

// Test hook: force re-selection (e.g. after mutating env in a test).
export function _resetVoteBackend() {
  cached = null;
}
