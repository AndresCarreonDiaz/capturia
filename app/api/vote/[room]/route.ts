import {
  publishPoll,
  castVote,
  getRoomState,
  subscribe,
  ROOM_ID_RE,
  type VoteEvent,
} from "@/lib/vote-store";

// Audience-voting endpoint. One room per studio session:
//   GET  /api/vote/:room            -> current { round, poll, counts } snapshot
//   GET  /api/vote/:room?watch=1    -> SSE stream of state/vote events
//   POST { type: "poll", hostKey, poll }      (studio publishes the live poll)
//   POST { type: "vote", viewerId, action }   (a viewer's phone votes)
// Backed by the in-memory single-process store (lib/vote-store.ts); see its
// header for the deployment posture.

// The room is mutable per-request state; never let the framework cache a GET.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ room: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { room } = await params;
  if (!ROOM_ID_RE.test(room)) {
    return Response.json({ error: "invalid room" }, { status: 422 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get("watch") !== "1") {
    return Response.json(getRoomState(room));
  }

  // SSE. The store refuses subscriptions to unknown rooms (no memory for
  // random ids), so close immediately after the snapshot in that case; the
  // viewer page polls the plain GET until the studio has published.
  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: VoteEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      send(getRoomState(room));
      const sub = subscribe(room, send);
      if (!sub.ok) {
        controller.close();
        return;
      }
      // Comment-frame keepalive so proxies and idle timeouts don't cut the
      // stream between votes.
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 25_000);
      cleanup = () => {
        clearInterval(ping);
        sub.unsubscribe();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { room } = await params;
  if (!ROOM_ID_RE.test(room)) {
    return Response.json({ error: "invalid room" }, { status: 422 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body?.type === "poll") {
    const result = publishPoll(room, String(body.hostKey ?? ""), body.poll);
    return result.ok
      ? Response.json(result.event)
      : Response.json({ error: result.error }, { status: result.status });
  }

  if (body?.type === "vote") {
    const result = castVote(room, String(body.viewerId ?? ""), String(body.action ?? ""));
    // Conflicts still return the live event so the phone can show the real
    // tally and its own locked-in choice.
    return result.ok
      ? Response.json(result.event)
      : Response.json({ error: result.error, event: result.event ?? null }, { status: result.status });
  }

  return Response.json({ error: "unknown type" }, { status: 400 });
}
