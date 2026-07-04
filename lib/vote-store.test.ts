import { describe, it, expect, beforeEach } from "vitest";
import {
  publishPoll,
  castVote,
  getRoomState,
  subscribe,
  _resetVoteStore,
  MAX_VOTERS,
  MIN_VOTE_INTERVAL_MS,
  type VoteEvent,
} from "@/lib/vote-store";

// The vote store is the trust boundary for AUDIENCE input: every viewer on the
// QR link can hit it, so dedupe, rate limiting, host auth, and round resets
// must hold exactly. Time is injected, so all timing behavior is pinned.

const ROOM = "abc123def";
const HOST = "host-key-1234";
const POLL = {
  title: "Ship it?",
  options: [
    { actionName: "poll-yes", label: "Yes" },
    { actionName: "poll-no", label: "No" },
  ],
};
let t = 1_000_000;

beforeEach(() => {
  _resetVoteStore();
  t = 1_000_000;
});

describe("publishPoll", () => {
  it("first publisher claims the room; wrong hostKey is rejected after that", () => {
    expect(publishPoll(ROOM, HOST, POLL, t).ok).toBe(true);
    const stolen = publishPoll(ROOM, "evil-key-9999", POLL, t);
    expect(stolen.ok).toBe(false);
    expect(stolen.ok === false && stolen.status).toBe(403);
  });

  it("rejects malformed rooms, keys, and polls", () => {
    expect(publishPoll("nope!", HOST, POLL, t).ok).toBe(false);
    expect(publishPoll(ROOM, "x", POLL, t).ok).toBe(false);
    expect(publishPoll(ROOM, HOST, { title: "t", options: [] }, t).ok).toBe(false);
    expect(
      publishPoll(ROOM, HOST, { title: "t", options: [{ actionName: "", label: "Yes" }] }, t).ok
    ).toBe(false);
    expect(
      publishPoll(
        ROOM,
        HOST,
        {
          title: "t",
          options: [
            { actionName: "a", label: "A" },
            { actionName: "a", label: "A again" },
          ],
        },
        t
      ).ok
    ).toBe(false);
  });

  it("same option set keeps counts; a new option set resets counts and bumps round", () => {
    publishPoll(ROOM, HOST, POLL, t);
    castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    // Cosmetic re-publish (same options, new title): counts survive.
    publishPoll(ROOM, HOST, { ...POLL, title: "Still shipping?" }, (t += 1000));
    let state = getRoomState(ROOM, t);
    expect(state.counts["poll-yes"]).toBe(1);
    expect(state.round).toBe(1);
    // Different options: fresh round, zeroed counts, voters may vote again.
    publishPoll(
      ROOM,
      HOST,
      { title: "Pick a color", options: [{ actionName: "c-red", label: "Red" }] },
      (t += 1000)
    );
    state = getRoomState(ROOM, t);
    expect(state.round).toBe(2);
    expect(state.counts).toEqual({ "c-red": 0 });
    expect(castVote(ROOM, "viewer-aaa-111", "c-red", (t += 1000)).ok).toBe(true);
  });

  it("keeps counts when only a LABEL changes (round identity is actionNames)", () => {
    publishPoll(ROOM, HOST, POLL, t);
    castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    // The agent restyles a button label ("Yes" -> "Yes!") but the actionNames
    // (the vote currency) are identical, so this must NOT reset the tally.
    const relabeled = {
      title: POLL.title,
      options: [
        { actionName: "poll-yes", label: "Yes!" },
        { actionName: "poll-no", label: "Nope" },
      ],
    };
    publishPoll(ROOM, HOST, relabeled, (t += 1000));
    const state = getRoomState(ROOM, t);
    expect(state.round).toBe(1);
    expect(state.counts["poll-yes"]).toBe(1);
    expect(state.poll?.options[0].label).toBe("Yes!"); // new label is stored
  });

  it("stores only whitelisted poll fields, never the raw client object", () => {
    const seen: VoteEvent[] = [];
    // A claimer smuggles a huge extra key on the poll and an option; it must
    // not survive into stored state or the fan-out to listeners.
    const bloated = {
      title: "Ship it?",
      extra: "x".repeat(5000),
      options: [
        { actionName: "poll-yes", label: "Yes", junk: "y".repeat(5000) },
        { actionName: "poll-no", label: "No" },
      ],
    };
    expect(publishPoll(ROOM, HOST, bloated, t).ok).toBe(true);
    subscribe(ROOM, (e) => seen.push(e), t);
    castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    const stored = getRoomState(ROOM, t).poll as unknown as Record<string, unknown>;
    expect(stored.extra).toBeUndefined();
    expect(Object.keys(stored)).toEqual(["title", "options"]);
    expect(Object.keys((stored.options as Record<string, unknown>[])[0]).sort()).toEqual([
      "actionName",
      "label",
    ]);
    // The un-whitelisted keys are not re-broadcast to SSE listeners either.
    expect(JSON.stringify(seen)).not.toContain("junk");
  });
});

describe("castVote", () => {
  beforeEach(() => {
    publishPoll(ROOM, HOST, POLL, t);
  });

  it("counts a first vote and reports it in the event", () => {
    const r = castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    expect(r.ok).toBe(true);
    expect(r.ok && r.event.counts).toEqual({ "poll-yes": 1, "poll-no": 0 });
  });

  it("re-voting the same option is a 409 no-op; switching moves the vote", () => {
    castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    const dup = castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.status).toBe(409);
    const switched = castVote(ROOM, "viewer-aaa-111", "poll-no", (t += 1000));
    expect(switched.ok).toBe(true);
    expect(switched.ok && switched.event.counts).toEqual({ "poll-yes": 0, "poll-no": 1 });
  });

  it("rate limits per viewer but not across viewers", () => {
    castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    const fast = castVote(ROOM, "viewer-aaa-111", "poll-no", t + MIN_VOTE_INTERVAL_MS - 1);
    expect(fast.ok === false && fast.status).toBe(429);
    expect(castVote(ROOM, "viewer-bbb-222", "poll-no", t + 1).ok).toBe(true);
    expect(castVote(ROOM, "viewer-aaa-111", "poll-no", t + MIN_VOTE_INTERVAL_MS).ok).toBe(true);
  });

  it("rejects unknown options, unknown rooms, and bad viewer ids", () => {
    expect(castVote(ROOM, "viewer-aaa-111", "poll-maybe", (t += 1000)).ok).toBe(false);
    expect(castVote("missingroom1", "viewer-aaa-111", "poll-yes", t).ok).toBe(false);
    expect(castVote(ROOM, "!", "poll-yes", (t += 1000)).ok).toBe(false);
  });

  it("caps voters per room (minting fresh viewerIds is bounded), existing voters can still switch", () => {
    t += 1000;
    for (let i = 0; i < MAX_VOTERS; i++) {
      expect(castVote(ROOM, `viewer-flood-${i}`, "poll-yes", t).ok).toBe(true);
    }
    const overflow = castVote(ROOM, "viewer-late-comer", "poll-no", t);
    expect(overflow.ok).toBe(false);
    expect(overflow.ok === false && overflow.status).toBe(503);
    // A counted voter is unaffected by the cap and can still switch.
    expect(castVote(ROOM, "viewer-flood-0", "poll-no", t + MIN_VOTE_INTERVAL_MS).ok).toBe(true);
  });
});

describe("subscribe + events", () => {
  it("fans votes out to listeners and supports unsubscribe", () => {
    publishPoll(ROOM, HOST, POLL, t);
    const seen: VoteEvent[] = [];
    const sub = subscribe(ROOM, (e) => seen.push(e), t);
    expect(sub.ok).toBe(true);
    castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000));
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("vote");
    expect(seen[0].counts["poll-yes"]).toBe(1);
    sub.unsubscribe();
    castVote(ROOM, "viewer-bbb-222", "poll-yes", (t += 1000));
    expect(seen).toHaveLength(1);
  });

  it("never lets unknown room ids allocate memory (subscribe + state)", () => {
    expect(subscribe("unknownroom1", () => {}, t).ok).toBe(false);
    const state = getRoomState("unknownroom1", t);
    expect(state.poll).toBeNull();
    // Still unknown afterwards: subscribing again still refuses.
    expect(subscribe("unknownroom1", () => {}, t).ok).toBe(false);
  });

  it("a throwing listener is dropped, not fatal", () => {
    publishPoll(ROOM, HOST, POLL, t);
    const seen: VoteEvent[] = [];
    subscribe(ROOM, () => {
      throw new Error("dead controller");
    }, t);
    subscribe(ROOM, (e) => seen.push(e), t);
    expect(castVote(ROOM, "viewer-aaa-111", "poll-yes", (t += 1000)).ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe("TTL", () => {
  it("expires idle rooms after the TTL window", () => {
    publishPoll(ROOM, HOST, POLL, t);
    const fourHoursAndChange = t + 4 * 60 * 60 * 1000 + 60_000;
    const state = getRoomState(ROOM, fourHoursAndChange);
    expect(state.poll).toBeNull();
    // The room is really gone: a new host can claim the id.
    expect(publishPoll(ROOM, "new-host-key-99", POLL, fourHoursAndChange).ok).toBe(true);
  });
});
