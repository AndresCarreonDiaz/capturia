import { afterEach, describe, expect, it } from "vitest";
import { getVoteBackend, _resetVoteBackend } from "./vote-backend";
import { _resetVoteStore } from "./vote-store";

const ROOM = "room1234abcd";
const HOST = "host-key-1234";
const POLL = {
  title: "Best option?",
  options: [
    { actionName: "opt-a", label: "A" },
    { actionName: "opt-b", label: "B" },
  ],
};

afterEach(() => {
  _resetVoteBackend();
  _resetVoteStore();
});

describe("getVoteBackend selection", () => {
  it("uses the in-memory store when no Upstash env exists", () => {
    const backend = getVoteBackend({});
    expect(backend.mode).toBe("memory");
    expect(typeof backend.subscribe).toBe("function");
  });

  it("uses Redis when the Upstash integration env vars exist", () => {
    const backend = getVoteBackend({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(backend.mode).toBe("redis");
    expect(backend.subscribe).toBeUndefined();
  });

  it("accepts the Vercel KV env flavor", () => {
    const backend = getVoteBackend({
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "tok",
    });
    expect(backend.mode).toBe("redis");
  });

  it("memoizes until reset", () => {
    const first = getVoteBackend({});
    const second = getVoteBackend({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(second).toBe(first);
    _resetVoteBackend();
    const third = getVoteBackend({
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "tok",
    });
    expect(third.mode).toBe("redis");
  });
});

describe("memory backend delegation", () => {
  it("round-trips publish, vote, and state through the async facade", async () => {
    const backend = getVoteBackend({});
    const published = await backend.publishPoll(ROOM, HOST, POLL);
    expect(published.ok).toBe(true);

    const vote = await backend.castVote(ROOM, "viewer-1234", "opt-a");
    expect(vote.ok).toBe(true);

    const state = await backend.getRoomState(ROOM);
    expect(state.counts["opt-a"]).toBe(1);
    expect(state.poll?.title).toBe("Best option?");
  });
});
