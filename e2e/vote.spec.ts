import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "node:crypto";

// End-to-end audience voting: the studio publishes a poll to its room (here
// simulated with direct API calls, which is exactly what useVoteRoom sends)
// and phones interact with /vote/<room> in a real browser over live SSE.

function roomSlug(): string {
  // 16 lowercase hex chars, matches ROOM_ID_RE (^[a-z0-9]{8,32}$).
  return crypto.randomBytes(8).toString("hex");
}

function key(): string {
  // UUIDs match KEY_RE (^[a-z0-9-]{8,64}$), same shape useVoteRoom mints.
  return crypto.randomUUID();
}

const POLL = {
  title: "Which demo next?",
  options: [
    { actionName: "vote_apis", label: "APIs" },
    { actionName: "vote_pricing", label: "Pricing" },
  ],
};

async function publish(
  api: APIRequestContext,
  room: string,
  hostKey: string,
  poll: unknown
) {
  return api.post(`/api/vote/${room}`, {
    data: { type: "poll", hostKey, poll },
  });
}

function optionButton(page: Page, label: string) {
  return page.getByRole("button", { name: new RegExp(label) });
}

test("a phone sees the poll, votes, and watches the live tally move", async ({
  page,
  browser,
  request,
}) => {
  const room = roomSlug();
  const res = await publish(request, room, key(), POLL);
  expect(res.ok()).toBe(true);
  expect((await res.json()).round).toBe(1);

  await page.goto(`/vote/${room}`);
  await expect(page.getByText("Which demo next?")).toBeVisible();
  await expect(optionButton(page, "APIs")).toBeVisible();

  // Counts are hidden until this phone votes.
  await expect(page.getByText("Tap an option to vote.", { exact: false })).toBeVisible();
  await optionButton(page, "APIs").click();
  await expect(page.getByText("Vote counted.", { exact: false })).toBeVisible();
  await expect(optionButton(page, "APIs")).toContainText("1 · 100%");

  // A second phone (fresh browser context = fresh viewerId) votes the other
  // way; both phones converge on 50/50, the first one purely via SSE push.
  const phone2 = await browser.newContext();
  const page2 = await phone2.newPage();
  await page2.goto(`/vote/${room}`);
  await optionButton(page2, "Pricing").click();
  await expect(optionButton(page2, "Pricing")).toContainText("1 · 50%");
  await expect(optionButton(page, "APIs")).toContainText("1 · 50%", { timeout: 10_000 });
  await phone2.close();
});

test("switching moves the vote instead of double counting", async ({ page, request }) => {
  const room = roomSlug();
  await publish(request, room, key(), POLL);

  await page.goto(`/vote/${room}`);
  await optionButton(page, "APIs").click();
  await expect(optionButton(page, "APIs")).toContainText("1 · 100%");

  // The store rate-limits vote changes to one per 750ms per viewer.
  await page.waitForTimeout(900);
  await optionButton(page, "Pricing").click();
  await expect(optionButton(page, "Pricing")).toContainText("1 · 100%", { timeout: 10_000 });
  await expect(optionButton(page, "APIs")).toContainText("0 · 0%");
});

test("a new poll resets the phone's vote lock over SSE, without reload", async ({
  page,
  request,
}) => {
  const room = roomSlug();
  const hostKey = key();
  await publish(request, room, hostKey, POLL);

  await page.goto(`/vote/${room}`);
  await optionButton(page, "APIs").click();
  await expect(page.getByText("Vote counted.", { exact: false })).toBeVisible();

  const nextPoll = {
    title: "How deep should we go?",
    options: [
      { actionName: "vote_overview", label: "Overview" },
      { actionName: "vote_deep_dive", label: "Deep dive" },
    ],
  };
  const res = await publish(request, room, hostKey, nextPoll);
  expect(res.ok()).toBe(true);
  expect((await res.json()).round).toBe(2);

  await expect(page.getByText("How deep should we go?")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Tap an option to vote.", { exact: false })).toBeVisible();
  await expect(optionButton(page, "Deep dive")).toBeVisible();
});

test("the waiting room turns into the poll once the host goes live", async ({
  page,
  request,
}) => {
  const room = roomSlug();

  await page.goto(`/vote/${room}`);
  await expect(
    page.getByText("Waiting for the host to start a poll.", { exact: false })
  ).toBeVisible();

  await publish(request, room, key(), POLL);
  // The server closes SSE streams for unknown rooms, so the page relies on
  // EventSource auto-reconnect (~3s cadence) to pick the poll up.
  await expect(page.getByText("Which demo next?")).toBeVisible({ timeout: 15_000 });
});

test("API guards: host auth, room shape, option validity, rate limit, repeats", async ({
  request,
}) => {
  const room = roomSlug();
  const hostKey = key();

  // Unknown rooms answer with an empty snapshot and never allocate memory.
  const empty = await request.get(`/api/vote/${room}`);
  expect(await empty.json()).toEqual({ type: "state", round: 0, poll: null, counts: {} });

  expect((await request.get(`/api/vote/ab`)).status()).toBe(422);

  await publish(request, room, hostKey, POLL);

  // Only the claiming hostKey may re-publish.
  const stranger = await publish(request, room, key(), POLL);
  expect(stranger.status()).toBe(403);

  // Malformed polls are rejected.
  const badPoll = await publish(request, room, hostKey, { title: "x", options: [] });
  expect(badPoll.status()).toBe(422);

  const viewerId = key();
  const vote = (action: string) =>
    request.post(`/api/vote/${room}`, {
      data: { type: "vote", viewerId, action },
    });

  expect((await vote("vote_nope")).status()).toBe(422);

  expect((await vote("vote_apis")).ok()).toBe(true);
  // Immediate switch trips the 750ms per-viewer rate limit and still returns
  // the live event so the phone can render the real tally.
  const tooFast = await vote("vote_pricing");
  expect(tooFast.status()).toBe(429);
  expect((await tooFast.json()).event?.counts).toEqual({ vote_apis: 1, vote_pricing: 0 });

  await new Promise((r) => setTimeout(r, 900));
  // Re-voting the same option is a conflict, not a second ballot.
  const repeat = await vote("vote_apis");
  expect(repeat.status()).toBe(409);
  expect((await repeat.json()).event?.counts).toEqual({ vote_apis: 1, vote_pricing: 0 });
});
