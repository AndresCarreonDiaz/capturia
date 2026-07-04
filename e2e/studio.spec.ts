import { test, expect } from "@playwright/test";

// Studio smoke tests plus one key-gated live-agent run. The mic/voice paths
// can't run headless (Web Speech needs a real Chrome + mic); those live in
// docs/e2e-checklist.md as a manual checklist.

test("the studio loads: webcam layer, command bar, quick actions", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.locator("video").first()).toBeVisible();
  await expect(page.getByPlaceholder(/Add a lower third/)).toBeVisible();
  // Quick-action chips show on an empty stage.
  await expect(page.getByText("Progress 73%")).toBeVisible();
});

test("program output (?out=1) is chrome-free: webcam only, no operator UI", async ({
  page,
}) => {
  await page.goto("/studio?out=1");
  await expect(page.locator("video").first()).toBeVisible();
  await expect(page.getByPlaceholder(/Add a lower third/)).toHaveCount(0);
  await expect(page.getByText("Progress 73%")).toHaveCount(0);
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
