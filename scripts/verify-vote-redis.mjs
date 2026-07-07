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

const fast = await api("POST", { type: "vote", viewerId: "viewer-aaaa0001", action: "no" });
check("instant re-vote is rate limited", fast.status === 429, JSON.stringify(fast));

await new Promise((r) => setTimeout(r, 900));
const dup = await api("POST", { type: "vote", viewerId: "viewer-aaaa0001", action: "yes" });
check("same-option re-vote conflicts", dup.status === 409, JSON.stringify(dup));

await new Promise((r) => setTimeout(r, 900));
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
