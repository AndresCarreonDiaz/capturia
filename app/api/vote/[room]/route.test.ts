// Route-level contract for the vote room endpoint, focused on what issue #52
// added: open CORS (the packaged desktop studio calls this route on the
// hosted deploy from a file:// page, Origin: null) and unpublish working
// through the route on every backend instead of answering 501. The store
// semantics themselves are pinned in lib/vote-store.test.ts and
// lib/vote-store-redis.test.ts; e2e/vote.spec.ts drives the same-origin
// phone flow in a real browser.

import { afterEach, describe, expect, it } from "vitest";
import { _resetVoteBackend } from "@/lib/vote-backend";
import { _resetVoteStore } from "@/lib/vote-store";
import { GET, OPTIONS, POST } from "./route";

const ROOM = "room1234abcd";
const HOST = "host-key-1234";
const POLL = {
  title: "Best option?",
  options: [
    { actionName: "opt-a", label: "A" },
    { actionName: "opt-b", label: "B" },
  ],
};

function ctx(room: string) {
  return { params: Promise.resolve({ room }) };
}

function post(room: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/vote/${room}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(room)
  );
}

function get(room: string, watch = false): Promise<Response> {
  const query = watch ? "?watch=1" : "";
  return GET(new Request(`http://localhost/api/vote/${room}${query}`), ctx(room));
}

afterEach(() => {
  _resetVoteBackend();
  _resetVoteStore();
});

describe("CORS for the desktop studio", () => {
  it("answers the preflight the cross-origin JSON POST triggers", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("marks GET snapshots readable cross-origin", async () => {
    const res = await get(ROOM);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("marks the SSE watch stream readable cross-origin", async () => {
    const res = await get(ROOM, true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    await res.body?.cancel();
  });

  it("marks POST results readable cross-origin, successes and rejections alike", async () => {
    const published = await post(ROOM, { type: "poll", hostKey: HOST, poll: POLL });
    expect(published.status).toBe(200);
    expect(published.headers.get("access-control-allow-origin")).toBe("*");

    // Rejections need the header too, or the desktop studio would see an
    // opaque network error instead of the status its notices key on.
    const stranger = await post(ROOM, { type: "poll", hostKey: "host-imposter1", poll: POLL });
    expect(stranger.status).toBe(403);
    expect(stranger.headers.get("access-control-allow-origin")).toBe("*");

    const invalid = await get("ab");
    expect(invalid.status).toBe(422);
    expect(invalid.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("unpublish through the route", () => {
  it("closes the room on every backend contract (no 501 left)", async () => {
    const published = await post(ROOM, { type: "poll", hostKey: HOST, poll: POLL });
    const firstNonce = (await published.json()).nonce as string;
    expect(firstNonce).toBeTruthy();

    const strangerClose = await post(ROOM, { type: "unpublish", hostKey: "host-imposter1" });
    expect(strangerClose.status).toBe(403);

    const closed = await post(ROOM, { type: "unpublish", hostKey: HOST });
    expect(closed.status).toBe(200);
    expect((await closed.json()).type).toBe("closed");

    // The room is gone, not just empty: votes 404 and a re-publish starts
    // over at round 1.
    const rejected = await post(ROOM, { type: "vote", viewerId: "viewer-1234", action: "opt-a" });
    expect(rejected.status).toBe(404);

    // Round 1 again, but a DIFFERENT instance nonce: the phone page keys its
    // "already voted" lock on (nonce, round), so a matching nonce here would
    // resurrect pre-unpublish vote locks into the fresh tally.
    const republished = await post(ROOM, { type: "poll", hostKey: HOST, poll: POLL });
    const reopenedBody = await republished.json();
    expect(reopenedBody.round).toBe(1);
    expect(reopenedBody.nonce).toBeTruthy();
    expect(reopenedBody.nonce).not.toBe(firstNonce);
  });

  it("stays quiet on a double toggle: closing a missing room succeeds", async () => {
    const res = await post(ROOM, { type: "unpublish", hostKey: HOST });
    expect(res.status).toBe(200);
  });
});
