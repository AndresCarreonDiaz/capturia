// Where the audience vote QR may point. The QR renders on the LIVE camera
// feed and gets scanned by phones (often watching through Zoom), so the
// decision of whether a URL is advertisable at all, and whether it deserves
// an operator warning, is worth keeping pure and tested.

// Advertisable means plain http(s). The packaged desktop studio runs on a
// file:// origin ("file://" in Chromium, "null" in some engines): a vote URL
// derived from that would put a DEAD QR on the live feed, so callers must
// suppress the URL entirely and surface the origin-config notice instead.
export function voteOriginUsable(origin: string | null | undefined): boolean {
  return typeof origin === "string" && /^https?:\/\//i.test(origin);
}

// True when the URL exists but phones almost certainly cannot reach it.
// localhost stays ADVERTISED but warned about (unlike file://): the operator
// may be demoing on this very machine, and the banner explains the LAN and
// tunnel options either way.
export function voteUrlLocalhostOnly(voteUrl: string): boolean {
  return /\/\/(localhost|127\.0\.0\.1)[:/]/.test(voteUrl);
}
