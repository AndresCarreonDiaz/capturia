import { test, expect, type Page } from "@playwright/test";

// End-to-end coverage for the checkout success overlay: Stripe redirects a
// paid checkout to /?checkout=success&session_id=...&pickup=..., and the
// landing overlay polls /api/billing/activation-code for the one-time code
// (lib/checkout-success.ts: 12 attempts, 5s apart). The endpoint is stubbed
// per-test so these specs pin the client behavior: webhook-lag tolerance,
// the already-collected dead end, and dismiss cancelling the poll. Clipboard
// writes stay untested on purpose (headless permission grants are flaky);
// the Copy button's presence is the contract asserted here.

const RETURN_URL =
  "/?checkout=success&session_id=cs_test_1234567890&pickup=pickupnonce0123456789";
const CODE = "CAPTURIA-AAAA-BBBB-CCCC-DDDD";

type StubStep = { status: number; body: unknown };

// Script the pickup endpoint: each request consumes the next step, and the
// last step repeats forever (a permanent 404 models a webhook that never
// lands). Returns a live counter so tests can assert exactly how many
// attempts the client spent.
async function stubPickup(page: Page, script: StubStep[]) {
  const counter = { requests: 0 };
  await page.route("**/api/billing/activation-code*", async (route) => {
    const step = script[Math.min(counter.requests, script.length - 1)];
    counter.requests += 1;
    await route.fulfill({
      status: step.status,
      contentType: "application/json",
      body: JSON.stringify(step.body),
    });
  });
  return counter;
}

const mintingHeading = (page: Page) =>
  page.getByRole("heading", { name: /Minting your activation code/ });

test("webhook lag: the overlay polls through 404s and lands the code", async ({
  page,
}) => {
  const counter = await stubPickup(page, [
    { status: 404, body: { error: "not minted yet" } },
    { status: 404, body: { error: "not minted yet" } },
    { status: 200, body: { code: CODE } },
  ]);

  await page.goto(RETURN_URL);

  // The minting state shows first, while the early attempts miss.
  await expect(mintingHeading(page)).toBeVisible({ timeout: 15_000 });

  // Two misses cost two 5s poll intervals (~10s wall time), then the third
  // attempt hands the code out with its Copy affordance.
  await expect(page.getByText(CODE)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("heading", { name: /Here is your activation code/ })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeVisible();

  // A 2xx short-circuits the loop: exactly the three scripted requests fired.
  expect(counter.requests).toBe(3);
});

test("already collected: a 410 stops the poll after one request and points at support", async ({
  page,
}) => {
  const counter = await stubPickup(page, [
    { status: 410, body: { error: "activation code already collected" } },
  ]);

  await page.goto(RETURN_URL);

  await expect(
    page.getByRole("heading", { name: /no longer available/ })
  ).toBeVisible({ timeout: 15_000 });
  const support = page.getByRole("link", { name: "support@capturia.dev" });
  await expect(support).toBeVisible();
  await expect(support).toHaveAttribute("href", "mailto:support@capturia.dev");

  // 410 is terminal (the code was handed out or expired): no retries.
  expect(counter.requests).toBe(1);
});

test("dismiss stops the poll: Close drops the overlay and no further requests fire", async ({
  page,
}) => {
  // A webhook that never lands: every attempt 404s, so only the dismiss can
  // end the polling.
  const counter = await stubPickup(page, [
    { status: 404, body: { error: "not minted yet" } },
  ]);

  await page.goto(RETURN_URL);
  await expect(mintingHeading(page)).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => counter.requests).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Close" }).click();

  // Dismiss strips the checkout params and unmounts the overlay, leaving the
  // plain landing behind it.
  await expect(page).toHaveURL("/");
  await expect(mintingHeading(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);
  await expect(
    page.locator("header").getByRole("link", { name: "Capturia home" })
  ).toBeVisible();

  // The AbortController must have killed the loop: the next attempt would
  // fire 5s after the last one, so a 7s window catches any zombie polling.
  const atDismiss = counter.requests;
  await page.waitForTimeout(7_000);
  expect(counter.requests).toBe(atDismiss);
});
