// Live-contract verification for the Redis vote store. The unit tests pin
// the JS glue with a fake runner; THIS script proves the Lua semantics
// against a real Upstash database. Run it once after enabling the Upstash
// integration (or locally with the env vars exported):
//
//   CAPTURIA_BASE_URL=https://your-deploy.vercel.app node scripts/verify-vote-redis.mjs
//
// It uses a throwaway room id; keys expire with the room TTL.

import { randomUUID } from "node:crypto";

// The store is TS, so the script drives the HTTP route contract instead of
// importing modules: point it at any running deploy (or next dev). It
// verifies whichever backend that deploy selected, which is exactly what
// matters; run it against the Vercel deploy after enabling Upstash to prove
// the Redis path.
const base = process.env.CAPTURIA_BASE_URL;

const room = randomUUID().replace(/-/g, "").slice(0, 16);
const hostKey = `host-${randomUUID().slice(0, 8)}`;
const poll = {
  title: "Verify?",
  options: [
    { actionName: "yes", label: "Yes" },
    { actionName: "no", label: "No" },
  ],
};

let failures = 0;
function check(name, cond, extra = "") {
  const ok = Boolean(cond);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${extra}`}`);
  if (!ok) failures += 1;
}

async function api(method, body) {
  const res = await fetch(`${base}/api/vote/${room}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

if (!base) {
  console.error(
    "verify-vote-redis: set CAPTURIA_BASE_URL to the deployed origin (e.g. https://capturia.vercel.app) so the script can exercise the live route."
  );
  process.exit(2);
}

const publish = await api("POST", { type: "poll", hostKey, poll });
check("publish creates the room", publish.status === 200 && publish.body?.round === 1, JSON.stringify(publish));

const wrongHost = await api("POST", { type: "poll", hostKey: "host-imposter1", poll });
check("second host is rejected", wrongHost.status === 403, JSON.stringify(wrongHost));

const vote1 = await api("POST", { type: "vote", viewerId: "viewer-aaaa0001", action: "yes" });
check("first vote lands", vote1.status === 200 && vote1.body?.counts?.yes === 1, JSON.stringify(vote1));

// Wall-clock aware: against a remote deploy, a slow round trip can outlast
// the 750ms window, making a 200 legitimate. Only judge when the second
// request landed inside the window.
const fastStart = Date.now();
const fast = await api("POST", { type: "vote", viewerId: "viewer-aaaa0001", action: "no" });
if (Date.now() - fastStart < 700) {
  check("instant re-vote is rate limited", fast.status === 429, JSON.stringify(fast));
} else {
  console.log("SKIP  instant re-vote is rate limited (round trip exceeded the window)");
}

await new Promise((r) => setTimeout(r, 1500));
const dup = await api("POST", { type: "vote", viewerId: "viewer-aaaa0001", action: "yes" });
check("same-option re-vote conflicts", dup.status === 409, JSON.stringify(dup));

await new Promise((r) => setTimeout(r, 1500));
const sw = await api("POST", { type: "vote", viewerId: "viewer-aaaa0001", action: "no" });
check(
  "switching moves the vote",
  sw.status === 200 && sw.body?.counts?.yes === 0 && sw.body?.counts?.no === 1,
  JSON.stringify(sw)
);

const relabel = await api("POST", {
  type: "poll",
  hostKey,
  poll: { ...poll, options: poll.options.map((o) => ({ ...o, label: o.label + "!" })) },
});
check(
  "label edits keep counts and round",
  relabel.status === 200 && relabel.body?.round === 1 && relabel.body?.counts?.no === 1,
  JSON.stringify(relabel)
);

const newRound = await api("POST", {
  type: "poll",
  hostKey,
  poll: { title: "Round 2", options: [{ actionName: "alpha", label: "Alpha" }] },
});
check(
  "a new option set starts a fresh round",
  newRound.status === 200 && newRound.body?.round === 2 && newRound.body?.counts?.alpha === 0,
  JSON.stringify(newRound)
);

const state = await api("GET");
check("GET snapshot matches", state.status === 200 && state.body?.round === 2, JSON.stringify(state));

// Watch mode: both backends serve SSE (in-process push, or the Redis polling
// bridge); the first data: frame must be the current snapshot.
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const res = await fetch(`${base}/api/vote/${room}?watch=1`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let snapshot = null;
  while (snapshot === null) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(/data: (.+)\n\n/);
    if (match) snapshot = JSON.parse(match[1]);
  }
  clearTimeout(timer);
  controller.abort();
  check(
    "watch stream sends the live snapshot",
    res.headers.get("content-type")?.includes("text/event-stream") && snapshot?.round === 2,
    JSON.stringify(snapshot)
  );
} catch (err) {
  check("watch stream sends the live snapshot", false, String(err));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
