// One-click download (issue #54): the landing's Download CTAs point here so a
// click starts the DMG immediately and the domain owns the URL. GitHub keeps
// hosting the bytes: every release uploads a stable-named Capturia-arm64.dmg
// alongside the versioned DMG (docs/release.md), and GitHub's
// /releases/latest/download/<asset> resolves "latest" server-side, so this
// route is a bare 302 with no GitHub API call and no auth. Excluded from the
// Electron static export like the rest of the server surface
// (scripts/build-electron-export.mjs).

const LATEST_DMG =
  "https://github.com/AndresCarreonDiaz/capturia/releases/latest/download/Capturia-arm64.dmg";

export function GET(): Response {
  return Response.redirect(LATEST_DMG, 302);
}
