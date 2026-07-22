// Pure decision logic for the minimum-viable update check (issue #50):
// whether the latest GitHub release is newer than the running app. The
// fetching, the timer, and the dialogs live in electron/update-check.js;
// keeping the parse-and-compare here makes the decision unit-testable and
// shared through the electron/gen build like the other main-process libs.
// The full electron-updater path (signed zip + latest-mac.yml) stays open in
// the issue; this module deliberately knows nothing about installing.

// GitHub's releases/latest endpoint never includes drafts or prereleases,
// which is exactly the "what should users run" question the check asks.
export const UPDATE_FEED_URL =
  "https://api.github.com/repos/AndresCarreonDiaz/capturia/releases/latest";
// The landing's one-click download route: it 302s to the stable-named DMG on
// the latest release (docs/release.md), so it always serves the artifact the
// feed above announced. Pinned https here, straight to shell.openExternal.
export const UPDATE_DOWNLOAD_URL = "https://www.capturia.dev/download";

export interface UpdateDecision {
  /** True only when BOTH versions parse and the release is strictly ahead. */
  newer: boolean;
  /** The release's version, v prefix stripped; null when unparseable. */
  latestVersion: string | null;
}

// Release tags are v-prefixed numeric triples (v0.1.3); the bare triple is
// tolerated. Anything else (a renamed tag, a prerelease suffix, a missing
// field) parses to null and the decision treats it as not-newer: a wrong
// "update available" nag is worse than a missed one.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parseTriple(raw: unknown): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const match = VERSION_RE.exec(raw.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// The version a releases/latest response announces. Only tag_name matters;
// the rest of the (large) response body is ignored.
export function latestVersionFromRelease(body: unknown): string | null {
  const tag = (body as { tag_name?: unknown } | null)?.tag_name;
  const triple = parseTriple(tag);
  return triple ? triple.join(".") : null;
}

// Numeric triple compare, never lexicographic (0.1.10 beats 0.1.9). Equal
// and older both answer newer:false: a rollback release is not an update.
export function decideUpdate(currentVersion: unknown, releaseBody: unknown): UpdateDecision {
  const latestVersion = latestVersionFromRelease(releaseBody);
  const latest = parseTriple(latestVersion);
  const current = parseTriple(currentVersion);
  if (!latest || !current) return { newer: false, latestVersion };
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) {
      return { newer: latest[i] > current[i], latestVersion };
    }
  }
  return { newer: false, latestVersion };
}
