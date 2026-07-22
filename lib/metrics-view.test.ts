import { describe, expect, it } from "vitest";
import type { BeaconSummary } from "./beacon";
import {
  compareVersionsDesc,
  fetchedAtLabel,
  parseReleases,
  parseSummary,
  publishedLabel,
  totalDownloads,
  versionRows,
} from "./metrics-view";

function summaryBody(overrides: Partial<BeaconSummary> = {}): Record<string, unknown> {
  return {
    backend: "redis",
    day: "20260722",
    month: "202607",
    dau: 12,
    wau: 40,
    mau: 90,
    activations: 33,
    events: { launch: 500, "camera-installed": 34, "update-check": 0 },
    versions: { "0.1.0": 400, "0.2.0": 100 },
    versionsOverflow: 0,
    ...overrides,
  };
}

describe("parseSummary", () => {
  it("accepts the endpoint's shape and carries every rendered field through", () => {
    const s = parseSummary(summaryBody());
    expect(s).not.toBeNull();
    expect(s!.backend).toBe("redis");
    expect(s!.mau).toBe(90);
    expect(s!.events["camera-installed"]).toBe(34);
    expect(s!.versions).toEqual({ "0.1.0": 400, "0.2.0": 100 });
    expect(s!.versionsOverflow).toBe(0);
  });

  it("refuses non-objects and unknown backends", () => {
    expect(parseSummary(null)).toBeNull();
    expect(parseSummary("<!doctype html>")).toBeNull();
    expect(parseSummary([])).toBeNull();
    expect(parseSummary(summaryBody({ backend: "postgres" as never }))).toBeNull();
  });

  it("refuses non-count headline numbers and missing event counters", () => {
    expect(parseSummary(summaryBody({ mau: -1 }))).toBeNull();
    expect(parseSummary(summaryBody({ dau: "12" as never }))).toBeNull();
    expect(parseSummary(summaryBody({ events: { launch: 500 } as never }))).toBeNull();
  });

  it("drops non-numeric version tallies instead of rendering NaN", () => {
    const s = parseSummary(summaryBody({ versions: { "0.1.0": 400, junk: "x" } as never }));
    expect(s!.versions).toEqual({ "0.1.0": 400 });
  });
});

describe("version ordering", () => {
  it("sorts semver descending, numerically (0.1.10 beats 0.1.9)", () => {
    const rows = versionRows({ "0.1.9": 1, "0.1.10": 2, "0.2.0": 3, "1.0.0": 4 });
    expect(rows.map((r) => r.version)).toEqual(["1.0.0", "0.2.0", "0.1.10", "0.1.9"]);
  });

  it("ranks a release above its own prerelease and junk below everything", () => {
    const rows = versionRows({ "0.2.0-beta.1": 1, "0.2.0": 2, garbage: 3, "0.1.0": 4 });
    expect(rows.map((r) => r.version)).toEqual(["0.2.0", "0.2.0-beta.1", "0.1.0", "garbage"]);
  });

  it("is deterministic for equal and unparseable pairs", () => {
    expect(compareVersionsDesc("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersionsDesc("zzz", "aaa")).toBeGreaterThan(0);
    expect(compareVersionsDesc("aaa", "zzz")).toBeLessThan(0);
  });
});

describe("parseReleases", () => {
  const feed = [
    {
      tag_name: "v0.2.0",
      published_at: "2026-07-18T10:00:00Z",
      assets: [
        { name: "Capturia-0.2.0-arm64.dmg", download_count: 120 },
        { name: "Capturia-latest-arm64.dmg", download_count: 30 },
      ],
    },
    {
      tag_name: "v0.1.0",
      published_at: "2026-07-09T10:00:00Z",
      assets: [{ name: "Capturia-0.1.0-arm64.dmg", download_count: 50 }],
    },
  ];

  it("keeps GitHub's order and sums per-release and grand totals", () => {
    const rows = parseReleases(feed)!;
    expect(rows.map((r) => r.tag)).toEqual(["v0.2.0", "v0.1.0"]);
    expect(rows[0].downloads).toBe(150);
    expect(rows[0].assets[0]).toEqual({ name: "Capturia-0.2.0-arm64.dmg", downloads: 120 });
    expect(totalDownloads(rows)).toBe(200);
  });

  it("refuses a non-array body (GitHub's error objects are not releases)", () => {
    expect(parseReleases({ message: "API rate limit exceeded" })).toBeNull();
    expect(parseReleases(null)).toBeNull();
  });

  it("drops tagless entries and treats bad asset counts as zero", () => {
    const rows = parseReleases([
      { published_at: "2026-07-18T10:00:00Z", assets: [] },
      { tag_name: "v0.3.0", assets: [{ name: "a.dmg", download_count: "many" }] },
    ])!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      tag: "v0.3.0",
      publishedAt: null,
      assets: [{ name: "a.dmg", downloads: 0 }],
      downloads: 0,
    });
  });
});

describe("publishedLabel", () => {
  it("formats a publish date and never invents one", () => {
    expect(publishedLabel("2026-07-18T10:00:00Z")).toBe("Jul 18, 2026");
    expect(publishedLabel(null)).toBe("unpublished");
    expect(publishedLabel("not a date")).toBe("unpublished");
  });
});

describe("fetchedAtLabel", () => {
  const now = Date.UTC(2026, 6, 22, 12, 0, 0);

  it("reads just now under ten seconds, then seconds, minutes, hours", () => {
    expect(fetchedAtLabel(now, now)).toBe("just now");
    expect(fetchedAtLabel(now - 9_000, now)).toBe("just now");
    expect(fetchedAtLabel(now - 42_000, now)).toBe("42s ago");
    expect(fetchedAtLabel(now - 3 * 60_000, now)).toBe("3m ago");
    expect(fetchedAtLabel(now - 2 * 3_600_000, now)).toBe("2h ago");
  });

  it("treats clock skew as fresh, not negative", () => {
    expect(fetchedAtLabel(now + 30_000, now)).toBe("just now");
  });
});
