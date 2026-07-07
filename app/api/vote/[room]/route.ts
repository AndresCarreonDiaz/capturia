import { ROOM_ID_RE, type VoteEvent } from "@/lib/vote-store";
import { getVoteBackend } from "@/lib/vote-backend";

// Audience-voting endpoint. One room per studio session:
//   GET  /api/vote/:room            -> current { round, poll, counts } snapshot
//   GET  /api/vote/:room?watch=1    -> SSE stream of state/vote events
//   POST { type: "poll", hostKey, poll }      (studio publishes the live poll)
//   POST { type: "vote", viewerId, action }   (a viewer's phone votes)
//
// Backend is picked by env (lib/vote-backend.ts): in-memory single-process by
// default (operator's machine / self-host; see lib/vote-store.ts header), or
// Upstash Redis when its env vars exist (hosted serverless deploys). With
// Redis there is no in-process push, so watch-mode becomes a short-lived
// polling bridge: snapshot every POLL_MS, emit on change, close before the
// function's time budget; EventSource's native reconnect resumes seamlessly
// and the clients never know the difference.

// The room is mutable per-request state; never let the framework cache a GET.
export const dynamic = "force-dynamic";

const BRIDGE_POLL_MS = 1500;
const BRIDGE_MAX_MS = 25_000;

type Params = { params: Promise<{ room: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { room } = await params;
  if (!ROOM_ID_RE.test(room)) {
    return Response.json({ error: "invalid room" }, { status: 422 });
  }
  const backend = getVoteBackend();

  const url = new URL(request.url);
  if (url.searchParams.get("watch") !== "1") {
    return Response.json(await backend.getRoomState(room));
  }

  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};

  if (backend.subscribe) {
    // In-process store: true push. The store refuses subscriptions to
    // unknown rooms (no memory for random ids), so close immediately after
    // the snapshot in that case; the viewer page polls the plain GET until
    // the studio has published.
    const subscribe = backend.subscribe;
    const snapshot = await backend.getRoomState(room);
    const stream = new ReadableStream({
      start(controller) {
        const send = (e: VoteEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        };
        send(snapshot);
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
    return sseResponse(stream);
  }

  // Shared store without push: poll it server-side and emit only changes.
  // The stream deliberately ends after BRIDGE_MAX_MS (serverless functions
  // have time budgets); EventSource reconnects and resumes. cleanup is
  // installed BEFORE the first await: ReadableStream delivers cancel() even
  // while start() is still pending, and a viewer who scans the QR and
  // closes the tab within the first round trip must not leave the interval
  // polling the store for the full deadline.
  const stream = new ReadableStream({
    async start(controller) {
      let lastPayload = "";
      let closed = false;
      let interval: ReturnType<typeof setInterval> | null = null;
      let deadline: ReturnType<typeof setTimeout> | null = null;
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        if (deadline) clearTimeout(deadline);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      const send = (e: VoteEvent) => {
        const payload = JSON.stringify(e);
        if (payload === lastPayload) return;
        lastPayload = payload;
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          // Enqueue onto a closed stream means the client is gone.
          cleanup();
        }
      };
      // Overlap guard: a store round trip slower than the poll period must
      // not stack ticks or emit stale snapshots out of order.
      let inFlight = false;
      const tick = async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          const state = await backend.getRoomState(room);
          if (!closed) send(state);
        } catch {
          // Transient store error: keep the stream; next tick retries.
        } finally {
          inFlight = false;
        }
      };
      await tick();
      if (closed) return;
      interval = setInterval(tick, BRIDGE_POLL_MS);
      deadline = setTimeout(() => cleanup(), BRIDGE_MAX_MS);
    },
    cancel() {
      cleanup();
    },
  });
  return sseResponse(stream);
}

function sseResponse(stream: ReadableStream): Response {
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
  const backend = getVoteBackend();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body?.type === "poll") {
    const result = await backend.publishPoll(room, String(body.hostKey ?? ""), body.poll);
    return result.ok
      ? Response.json(result.event)
      : Response.json({ error: result.error }, { status: result.status });
  }

  if (body?.type === "vote") {
    const result = await backend.castVote(
      room,
      String(body.viewerId ?? ""),
      String(body.action ?? "")
    );
    // Conflicts still return the live event so the phone can show the real
    // tally and its own locked-in choice.
    return result.ok
      ? Response.json(result.event)
      : Response.json({ error: result.error, event: result.event ?? null }, { status: result.status });
  }

  return Response.json({ error: "unknown type" }, { status: 400 });
}
