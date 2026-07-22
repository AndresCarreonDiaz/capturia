// Tokens -> presentation hours, the ONLY translation customers ever see
// (issue #49: customer-facing copy always says hours, never tokens). Pure so
// vitest pins the rounding and the Settings meter, the exhaustion notices,
// and any future surface all agree on what "an hour" is.
//
// The conversion is the pricing decision itself: $19/mo buys 20 presentation
// hours = 5,500,000 tokens, so one hour is 275,000 tokens. If the budgets
// ever change, this constant and the gate defaults (lib/hosted/gate.ts) must
// move together.

export const TOKENS_PER_PRESENTATION_HOUR = 275_000;

// Rounding rules for a displayed hour count: one decimal under an hour (the
// meter must move during a first session, not sit at a dead 0), whole hours
// otherwise (false precision reads as billing anxiety), never negative.
export function formatHours(tokens: number): string {
  const hours = Math.max(0, tokens) / TOKENS_PER_PRESENTATION_HOUR;
  if (hours < 1) return (Math.round(hours * 10) / 10).toFixed(1);
  return String(Math.round(hours));
}

// The meter line: "X of 20 hours used". Used hours are capped at the budget
// so a settlement race can never display "21 of 20"; the budget renders
// through the same rounding so an env-tuned deployment stays honest.
export function hoursMeterLabel(usedTokens: number, budgetTokens: number): string {
  const budget = Math.max(0, budgetTokens);
  const used = Math.min(Math.max(0, usedTokens), budget);
  return `${formatHours(used)} of ${formatHours(budget)} hours used`;
}

// Meter fill for a progress bar, clamped to [0, 1].
export function hoursMeterFraction(usedTokens: number, budgetTokens: number): number {
  if (!(budgetTokens > 0)) return 0;
  return Math.min(1, Math.max(0, usedTokens) / budgetTokens);
}
