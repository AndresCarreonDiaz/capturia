import { test, expect, type Page } from "@playwright/test";

// Web fallback for the silent cue triggers: with a deck loaded, in-page
// Ctrl/Cmd+Alt+1..9 fires the rail card at that position and Ctrl/Cmd+Alt+
// Right fires the card at the next-unfired pointer. The desktop global
// (works-while-unfocused) half of the feature is covered by
// scripts/e2e-desktop-hotkeys.mjs; these specs prove the shared renderer
// wiring, the focus rules, and the unbind on deck clear. Control+Alt is
// used throughout because the handler accepts either modifier and Control
// keeps the pressed combo deterministic across host platforms.

// CueCard fixtures shaped like buildCues emits them, driven through the
// dev-only capturiaDrive hook (the real deck path needs a PDF plus a key).
const CARDS = [1, 2, 3].map((n) => ({
  id: `cue-hk-${n}`,
  label: `Hotkey Card ${n}`,
  aliases: [`hotkey card ${n}`],
  slideIndex: n - 1,
  specs: [
    {
      id: `hk-overlay-${n}`,
      type: "LowerThird",
      position: "bottom-left",
      props: { name: `Hotkey Overlay ${n}`, subtitle: "silent trigger" },
    },
  ],
  adapted: false,
}));

async function driveCues(page: Page, cards: unknown[]) {
  await page.waitForFunction(
    () => Boolean((window as { capturiaDrive?: unknown }).capturiaDrive)
  );
  await page.evaluate((c) => {
    (
      window as unknown as { capturiaDrive: { setCues: (v: unknown[]) => void } }
    ).capturiaDrive.setCues(c);
  }, cards);
}

test("typing in the command bar never fires a card; the combo fires once the field blurs", async ({
  page,
}) => {
  await page.goto("/studio");
  await driveCues(page, CARDS);
  await expect(page.getByText("Hotkey Card 1")).toBeVisible();

  // A plain digit in the (autofocused) CommandBar is typing, not a trigger.
  const input = page.getByPlaceholder(/Add a lower third/);
  await input.click();
  await page.keyboard.type("1");
  await expect(input).toHaveValue("1");
  await expect(page.getByText("Hotkey Overlay 1")).toHaveCount(0);

  // Even the full combo must not steal from a focused text field.
  await page.keyboard.press("Control+Alt+Digit1");
  await expect(page.getByText("Hotkey Overlay 1")).toHaveCount(0);

  // Blurred: the same combo lands card 1 on the feed, leaving the draft alone.
  await input.blur();
  await page.keyboard.press("Control+Alt+Digit1");
  await expect(page.getByText("Hotkey Overlay 1")).toBeVisible();
  await expect(input).toHaveValue("1");
});

test("the next-card combo walks the deck in order and never wraps", async ({ page }) => {
  await page.goto("/studio");
  await driveCues(page, CARDS);
  const input = page.getByPlaceholder(/Add a lower third/);
  await input.blur();

  // Fresh deck: the pointer badge sits on card 1.
  await expect(page.locator("[data-cue-next]")).toHaveText(/Hotkey Card 1/);

  // A digit fire advances the pointer past the fired card.
  await page.keyboard.press("Control+Alt+Digit1");
  await expect(page.getByText("Hotkey Overlay 1")).toBeVisible();
  await expect(page.locator("[data-cue-next]")).toHaveText(/Hotkey Card 2/);

  // Next fires card 2, then card 3, in rail order.
  await page.keyboard.press("Control+Alt+ArrowRight");
  await expect(page.getByText("Hotkey Overlay 2")).toBeVisible();
  await page.keyboard.press("Control+Alt+ArrowRight");
  await expect(page.getByText("Hotkey Overlay 3")).toBeVisible();

  // Past the end the walk goes quiet: no badge, and another press changes
  // nothing (a wrap would move the badge back to card 1).
  await expect(page.locator("[data-cue-next]")).toHaveCount(0);
  await page.keyboard.press("Control+Alt+ArrowRight");
  await expect(page.locator("[data-cue-next]")).toHaveCount(0);
});

test("a rail click advances the silent walk like any other fire", async ({ page }) => {
  await page.goto("/studio");
  await driveCues(page, CARDS);

  // Clicking card 2 fires it and moves the pointer to card 3; the skipped
  // card 1 stays behind the pointer (the walk never rewinds).
  await page.getByRole("button", { name: /Hotkey Card 2/ }).click();
  await expect(page.getByText("Hotkey Overlay 2")).toBeVisible();
  await expect(page.locator("[data-cue-next]")).toHaveText(/Hotkey Card 3/);

  await page.getByPlaceholder(/Add a lower third/).blur();
  await page.keyboard.press("Control+Alt+ArrowRight");
  await expect(page.getByText("Hotkey Overlay 3")).toBeVisible();
});

// Dispatch a synthetic, cancelable combo keydown and report whether anything
// consumed it. defaultPrevented is the probe: the cue listener is the only
// thing that preventDefaults these combos, so TRUE means the binding is live
// and FALSE means nobody is listening (not merely that no card matched).
function dispatchCombo(page: Page, code: string, repeat = false) {
  return page.evaluate(
    ({ code, repeat }) => {
      const e = new KeyboardEvent("keydown", {
        code,
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
        repeat,
      });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    },
    { code, repeat }
  );
}

test("clearing the deck unbinds the in-page combos, not just the cards", async ({ page }) => {
  await page.goto("/studio");
  await driveCues(page, CARDS);
  await expect(page.getByText("Hotkey Card 1")).toBeVisible();

  // Deck loaded: the probe must read BOUND (and fire), proving the probe
  // itself detects the binding before the clear is asserted with it.
  expect(await dispatchCombo(page, "Digit1")).toBe(true);
  await expect(page.getByText("Hotkey Overlay 1")).toBeVisible();

  await page.getByLabel("Clear deck").click();
  await expect(page.getByText("Hotkey Card 1")).toHaveCount(0);

  // Deck cleared: nobody consumes the combo anymore. Without the unbind the
  // listener would still preventDefault (an empty rail just fires nothing),
  // so this catches the zombie-listener case an overlay check cannot.
  expect(await dispatchCombo(page, "Digit1")).toBe(false);
  expect(await dispatchCombo(page, "ArrowRight")).toBe(false);
});

test("held-key auto-repeats never machine-gun the deck", async ({ page }) => {
  await page.goto("/studio");
  await driveCues(page, CARDS);
  await expect(page.getByText("Hotkey Card 1")).toBeVisible();

  // A held combo is one real keydown followed by a stream of repeat=true
  // events. Only the first may fire; every repeat must fall through
  // unconsumed, or one held next-combo walks the whole deck onto the feed.
  expect(await dispatchCombo(page, "ArrowRight")).toBe(true);
  await expect(page.getByText("Hotkey Overlay 1")).toBeVisible();
  for (let i = 0; i < 5; i++) {
    expect(await dispatchCombo(page, "ArrowRight", true)).toBe(false);
  }
  await expect(page.getByText("Hotkey Overlay 2")).toHaveCount(0);

  // Release and press again: the next real keydown still fires.
  expect(await dispatchCombo(page, "ArrowRight")).toBe(true);
  await expect(page.getByText("Hotkey Overlay 2")).toBeVisible();
});
