// Route contract for the one-click download (app/download/route.ts): the
// landing CTAs navigate straight here, so the answer must be a plain 302 to
// the stable-named latest-release DMG on GitHub. The asset name is
// load-bearing: docs/release.md uploads Capturia-arm64.dmg with every
// release, and GitHub's /releases/latest/download/ only resolves it while
// that exact name keeps shipping.

import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /download", () => {
  it("302s to the stable latest-release DMG asset", () => {
    const res = GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/AndresCarreonDiaz/capturia/releases/latest/download/Capturia-arm64.dmg"
    );
  });
});
