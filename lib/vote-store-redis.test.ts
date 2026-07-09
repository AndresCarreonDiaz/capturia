import { describe, expect, it } from "vitest";
import { createRedisVoteStore } from "./vote-store-redis";
import type { StoreResult } from "./vote-store";

// Glue-level tests: the fake runner plays the Redis side, returning what the
// Lua scripts return, so these pin argument marshaling, status mapping, and
// reply parsing. The Lua semantics themselves are exercised for real by
// scripts/verify-vote-redis.mjs against live credentials.

const ROOM = "room1234abcd";
const HOST = "host-key-1234";
const POLL = {
  title: "Best option?",
  options: [
    { actionName: "opt-a", label: "A" },
    { actionName: "opt-b", label: "B" },
  ],
};

function runnerReturning(result: unknown) {
  const calls: (string | number)[][] = [];
  const run = async (command: (string | number)[]) => {
    calls.push(command);
    return result;
  };
  return { run, calls };
}

// StoreResult is a discriminated union and only the rejection arm carries a
// status, so narrow on ok before reading it; null marks an unexpected success.
function rejectionStatus(res: StoreResult): number | null {
  return res.ok ? null : res.status;
}

describe("publishPoll (redis)", () => {
  it("rejects invalid input before touching Redis", async () => {
    const { run, calls } = runnerReturning(["ok", "1", "[]"]);
    const store = createRedisVoteStore(run);
    expect(rejectionStatus(await store.publishPoll("bad room!", HOST, POLL))).toBe(422);
    expect(rejectionStatus(await store.publishPoll(ROOM, "x", POLL))).toBe(422);
    expect(rejectionStatus(await store.publishPoll(ROOM, HOST, { title: "t", options: [] }))).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("maps the 403 wrong-host reply", async () => {
    const { run } = runnerReturning(["403"]);
    const store = createRedisVoteStore(run);
    const res = await store.publishPoll(ROOM, HOST, POLL);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("maps the 503 room-cap reply", async () => {
    const { run } = runnerReturning(["503"]);
    const store = createRedisVoteStore(run);
    const res = await store.publishPoll(ROOM, HOST, POLL);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.error).toBe("room limit reached");
    }
  });

  it("builds the state event from the script reply and strips unknown poll keys", async () => {
    const { run, calls } = runnerReturning([
      "ok",
      "2",
      JSON.stringify(["opt-a", "3", "opt-b", "1"]),
    ]);
    const store = createRedisVoteStore(run);
    const res = await store.publishPoll(ROOM, HOST, { ...POLL, sneaky: "x" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.event.round).toBe(2);
      expect(res.event.counts).toEqual({ "opt-a": 3, "opt-b": 1 });
      expect((res.event.poll as unknown as Record<string, unknown>).sneaky).toBeUndefined();
    }
    // EVAL with 4 keys (room hashes + rooms index), hostKey among ARGV.
    expect(calls[0][0]).toBe("EVAL");
    expect(calls[0][2]).toBe(4);
    expect(calls[0]).toContain(HOST);
    expect(calls[0]).toContain("vote:rooms");
  });
});

describe("castVote (redis)", () => {
  const reply = (status: string) => [
    status,
    "1",
    JSON.stringify(POLL),
    JSON.stringify(["opt-a", "1", "opt-b", "0"]),
  ];

  it("rejects an invalid viewer id before touching Redis", async () => {
    const { run, calls } = runnerReturning(reply("ok"));
    const store = createRedisVoteStore(run);
    expect(rejectionStatus(await store.castVote(ROOM, "!!", "opt-a"))).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("maps every script status to the store contract", async () => {
    for (const [status, expected] of [
      ["404", 404],
      ["422", 422],
      ["429", 429],
      ["409", 409],
      ["503", 503],
    ] as const) {
      const { run } = runnerReturning(
        status === "404" ? ["404", "0", "", "{}"] : reply(status)
      );
      const store = createRedisVoteStore(run);
      const res = await store.castVote(ROOM, "viewer-1234", "opt-a");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(expected);
    }
  });

  it("conflict replies still carry the live event for the phone UI", async () => {
    const { run } = runnerReturning(reply("409"));
    const store = createRedisVoteStore(run);
    const res = await store.castVote(ROOM, "viewer-1234", "opt-a");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.event?.counts).toEqual({ "opt-a": 1, "opt-b": 0 });
      expect(res.event?.poll?.title).toBe("Best option?");
    }
  });

  it("a successful vote returns the tally event", async () => {
    const { run } = runnerReturning(reply("ok"));
    const store = createRedisVoteStore(run);
    const res = await store.castVote(ROOM, "viewer-1234", "opt-b");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event.round).toBe(1);
  });
});

describe("getRoomState (redis)", () => {
  it("assembles state from the atomic snapshot script", async () => {
    const calls: (string | number)[][] = [];
    const store = createRedisVoteStore(async (command) => {
      calls.push(command);
      return ["3", JSON.stringify(POLL), JSON.stringify(["opt-a", "5", "opt-b", "2"])];
    });
    const state = await store.getRoomState(ROOM);
    expect(state.round).toBe(3);
    expect(state.poll?.options).toHaveLength(2);
    expect(state.counts).toEqual({ "opt-a": 5, "opt-b": 2 });
    // One EVAL, no torn two-command read.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("EVAL");
  });

  it("an unknown room reads as the empty state", async () => {
    const store = createRedisVoteStore(async () => ["0", "", "{}"]);
    const state = await store.getRoomState(ROOM);
    expect(state).toEqual({ type: "state", round: 0, poll: null, counts: {} });
  });
});
