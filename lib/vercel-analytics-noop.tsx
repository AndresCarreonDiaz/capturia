// Build-time stand-in for @vercel/analytics in the Electron static export.
// next.config.ts aliases the package here when CAPTURIA_ELECTRON_BUILD=1, so
// the desktop bundle carries zero analytics code: nothing to inject on
// file://, nothing for the out/ grep in scripts/build-electron-export.mjs to
// find. The web build never sees this module. Signatures are the loose
// shapes the app actually uses (an <Analytics /> mount and track(name,
// props)); anything richer would just be dead code here.

export function Analytics(): null {
  return null;
}

// Callers pass (name, properties); a JS function ignores arguments it does
// not declare, and declaring them here would only trip no-unused-vars.
export function track(): void {
  // Desktop build: analytics is deliberately absent.
}
