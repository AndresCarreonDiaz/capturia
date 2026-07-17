import { test, expect, type Page } from "@playwright/test";

// Studio smoke tests, the mirror-channel flow (Control Room -> ?out=1 output
// pages), plus one key-gated live-agent run. The mic/voice paths can't run
// headless (Web Speech needs a real Chrome + mic); those live in
// docs/e2e-checklist.md as a manual checklist.

// Drive overlay state through the dev-only window.capturiaDrive hook (the
// real agent path is key-gated, see the live-agent test below). The hook only
// exists on dev builds, which is exactly what the Playwright web server runs.
async function driveOverlays(page: Page, specs: unknown[]) {
  await page.waitForFunction(
    () => Boolean((window as { capturiaDrive?: unknown }).capturiaDrive)
  );
  await page.evaluate((s) => {
    (
      window as unknown as { capturiaDrive: { setOverlays: (v: unknown[]) => void } }
    ).capturiaDrive.setOverlays(s);
  }, specs);
}

const LOWER_THIRD = [
  {
    id: "lt-mirror",
    type: "LowerThird",
    position: "bottom-left",
    props: { name: "Mirror Check", subtitle: "Live from the Control Room" },
  },
];

test("the studio loads: webcam layer, command bar, quick actions", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.locator("video").first()).toBeVisible();
  await expect(page.getByPlaceholder(/Add a lower third/)).toBeVisible();
  // Quick-action chips show on an empty stage.
  await expect(page.getByText("Progress 73%")).toBeVisible();
});

test("the stage video carries real frames, not just a lit LED", async ({ page }) => {
  // Pins the stream ATTACH, not just element presence: a stream parked in a
  // ref with no re-render leaves a black stage while the camera runs (the
  // 0.1.1 packaged-app bug; WebcamFeed.tsx documents the render fence). The
  // fake device from playwright.config supplies the frames here.
  await page.goto("/studio");
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return !!v && v.videoWidth > 0 && !v.paused;
  });
});

test("program output (?out=1) is chrome-free: webcam only, no operator UI", async ({
  page,
}) => {
  await page.goto("/studio?out=1");
  await expect(page.locator("video").first()).toBeVisible();
  await expect(page.getByPlaceholder(/Add a lower third/)).toHaveCount(0);
  await expect(page.getByText("Progress 73%")).toHaveCount(0);
});

// The mirror channel: the visible studio (primary) publishes its overlay
// state over a BroadcastChannel and a ?out=1 page in the same browser adopts
// it. This is what feeds the native Capturia camera (the offscreen Electron
// window loads ?out=1) and, on web, a second same-browser tab that OBS
// captures via window/tab capture (an OBS Browser Source is its own isolated
// browser and receives no mirror).
test("an out page mirrors the control room's overlays, live and on removal", async ({
  page,
  context,
}) => {
  await page.goto("/studio");
  const outPage = await context.newPage();
  await outPage.goto("/studio?out=1");

  // Live update: created AFTER both pages are up, so this rides the
  // state-change republish, not the hello snapshot.
  await driveOverlays(page, LOWER_THIRD);
  await expect(page.getByText("Mirror Check")).toBeVisible();
  await expect(outPage.getByText("Mirror Check")).toBeVisible();

  // Removal mirrors too (the out page must not hold stale overlays).
  await driveOverlays(page, []);
  await expect(outPage.getByText("Mirror Check")).toHaveCount(0);
  await outPage.close();
});

test("a late-joining out page receives the current snapshot (hello handshake)", async ({
  page,
  context,
}) => {
  await page.goto("/studio");
  await driveOverlays(page, LOWER_THIRD);
  await expect(page.getByText("Mirror Check")).toBeVisible();

  // Opened AFTER the state already exists: only the hello/snapshot handshake
  // can deliver this overlay.
  const outPage = await context.newPage();
  await outPage.goto("/studio?out=1");
  await expect(outPage.getByText("Mirror Check")).toBeVisible();
  await outPage.close();
});

test("mirroring is one-directional: an out page's local state never renders or leaks", async ({
  page,
  context,
}) => {
  await page.goto("/studio");
  const outPage = await context.newPage();
  await outPage.goto("/studio?out=1");

  // Drive state INTO the receiver. It renders the adopted snapshot only, so
  // this must show up nowhere: not on the out page, not on the primary.
  await driveOverlays(outPage, [
    {
      id: "rogue-1",
      type: "LowerThird",
      position: "bottom-left",
      props: { name: "Rogue Receiver", subtitle: "should never render" },
    },
  ]);
  await outPage.waitForTimeout(500);
  await expect(outPage.getByText("Rogue Receiver")).toHaveCount(0);
  await expect(page.getByText("Rogue Receiver")).toHaveCount(0);
  await outPage.close();
});

test("the out page shows the PRIMARY's vote QR and never touches the vote API itself", async ({
  page,
  context,
}) => {
  // ?vote=1 pins voting on; the poll derives from a surface with 2+
  // ActionButtons (lib/derive-poll.ts), driven here without a model turn.
  await page.goto("/studio?vote=1");
  await driveOverlays(page, [
    {
      id: "surface-poll",
      type: "Surface",
      position: "center-right",
      props: {
        components: [
          { id: "root", component: "Column", children: ["q", "a", "b"] },
          { id: "q", component: "ChatBubble", text: "Which demo next?" },
          { id: "a", component: "ActionButton", label: "APIs", actionName: "vote_apis" },
          { id: "b", component: "ActionButton", label: "Pricing", actionName: "vote_pricing" },
        ],
      },
    },
  ]);
  // The badge prints the vote URL (host + /vote/<room>) under the QR canvas.
  const primaryUrlText = await page
    .locator("span", { hasText: /\/vote\// })
    .first()
    .innerText();

  // The out page ALSO carries ?vote=1 (the desktop offscreen URL inherits the
  // Control Room's query string), which is exactly the case the receiver
  // vote-room guard exists for: without it, this page would open an SSE watch
  // on (and could publish to) a second tab-scoped room nobody's phones are in.
  const outPage = await context.newPage();
  const voteApiCalls: string[] = [];
  outPage.on("request", (req) => {
    if (req.url().includes("/api/vote/")) voteApiCalls.push(`${req.method()} ${req.url()}`);
  });
  await outPage.goto("/studio?out=1&vote=1");
  await expect(outPage.getByText("Which demo next?")).toBeVisible();
  // Same room slug as the primary: the receiver mirrors the URL verbatim
  // instead of minting its own tab-scoped room.
  await expect(outPage.locator("span", { hasText: /\/vote\// }).first()).toHaveText(
    primaryUrlText
  );
  // Past the poll mirror + the publisher's 300ms debounce: still zero
  // requests. Deleting the receiver guard on useVoteRoom fails this.
  await outPage.waitForTimeout(800);
  expect(voteApiCalls).toEqual([]);
  await outPage.close();
});

test("exiting Program Output on an out page navigates to a real Control Room", async ({
  context,
}) => {
  // A receiver's local state is inert (the feed renders the adopted
  // snapshot), so revealing operator chrome IN PLACE would be a zombie
  // Control Room: commands would burn agent turns yet render nothing. The
  // exit affordances must therefore NAVIGATE, re-running role detection.
  const outPage = await context.newPage();
  await outPage.goto("/studio?out=1&fx=0");
  await expect(outPage.getByPlaceholder(/Add a lower third/)).toHaveCount(0);

  await outPage.keyboard.press("Control+Shift+KeyO");
  // The reload drops ?out=1 but keeps the other params.
  await outPage.waitForURL((url) => {
    return url.pathname === "/studio" && url.searchParams.get("out") === null;
  });
  expect(new URL(outPage.url()).searchParams.get("fx")).toBe("0");
  // Now a genuine primary: operator chrome is live.
  await expect(outPage.getByPlaceholder(/Add a lower third/)).toBeVisible();
  await outPage.close();
});

test("closing the Control Room clears the mirrored feed (bye handshake)", async ({
  page,
  context,
}) => {
  await page.goto("/studio");
  const outPage = await context.newPage();
  await outPage.goto("/studio?out=1");

  await driveOverlays(page, LOWER_THIRD);
  await expect(outPage.getByText("Mirror Check")).toBeVisible();

  // pagehide on the primary posts a bye; the receiver blanks immediately
  // (well under the 12s staleness fallback that covers silent crashes).
  await page.close();
  await expect(outPage.getByText("Mirror Check")).toHaveCount(0, { timeout: 5_000 });
  await outPage.close();
});

// The core product loop: a command drives the agent to render an overlay. This
// was broken for a long time (v1 client hooks driving the v2 runtime, so the
// tool-call message went to the legacy store the v2 tool loop never reads and
// no handler ran) and is now fixed by migrating the client to the
// @copilotkit/react-core/v2 hooks. See docs/known-issues.md for the history.
test(
  "a typed command drives the real agent loop into a rendered overlay",
  async ({ page }) => {
    test.skip(
      !process.env.CAPTURIA_E2E_HAS_KEY,
      "needs GOOGLE_GENERATIVE_AI_API_KEY (env or .env.local) to run a live model turn"
    );
    test.setTimeout(120_000);

    await page.goto("/studio");
    // The chip sends a fixed prompt ("Add a progress bar at 73% with label Demo
    // Loading"), so the expected overlay is deterministic even on a live model.
    await page.getByText("Progress 73%").click();
    await expect(page.getByText("Demo Loading")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("73%")).toBeVisible();

    // Surface Mode: the same overlay rendered through the real A2UI runtime
    // (A2UIProvider + A2UIRenderer + the registered catalog) instead of the
    // direct React renderer. Verifies the A2UI path coexists with the v2
    // CopilotKit provider.
    await page.getByRole("button", { name: "A2UI" }).click();
    await expect(page.getByText("Demo Loading")).toBeVisible({ timeout: 10_000 });

    // Second turn on the same thread: proves multi-turn context and a second
    // tool (remove_overlay) work through the v2 run path, not just one shot.
    const input = page.getByPlaceholder(/Add a lower third/);
    await input.fill("Remove all overlays");
    await input.press("Enter");
    await expect(page.getByText("Demo Loading")).toHaveCount(0, { timeout: 90_000 });
  }
);
