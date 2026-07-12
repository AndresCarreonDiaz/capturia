import { describe, expect, it } from "vitest";
import {
  BEACON_EVENTS,
  beaconKeys,
  lastNDayStamps,
  parseBeaconPayload,
  utcDayStamp,
  utcMonthStamp,
} from "./beacon";

const VALID = {
  installId: "9b2f8c1e-4a3d-4f6b-8a1c-2d3e4f5a6b7c",
  event: "launch",
  appVersion: "0.1.0",
  macosVersion: "26.0",
};

describe("parseBeaconPayload", () => {
  it("accepts the exact four-field payload for every event", () => {
    for (const event of BEACON_EVENTS) {
      const res = parseBeaconPayload({ ...VALID, event });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.payload.event).toBe(event);
    }
  });

  it("normalizes the installId to lowercase", () => {
    const res = parseBeaconPayload({ ...VALID, installId: VALID.installId.toUpperCase() });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload.installId).toBe(VALID.installId);
  });

  it("rejects extra fields outright instead of stripping them", () => {
    const res = parseBeaconPayload({ ...VALID, ip: "1.2.3.4" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("unknown field");
  });

  it("rejects missing fields", () => {
    for (const key of Object.keys(VALID)) {
      const body: Record<string, unknown> = { ...VALID };
      delete body[key];
      expect(parseBeaconPayload(body).ok).toBe(false);
    }
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, undefined, 42, "launch", [VALID], true]) {
      expect(parseBeaconPayload(body).ok).toBe(false);
    }
  });

  it("rejects a malformed installId", () => {
    for (const installId of ["not-a-uuid", "9b2f8c1e4a3d4f6b8a1c2d3e4f5a6b7c", "", 42]) {
      expect(parseBeaconPayload({ ...VALID, installId }).ok).toBe(false);
    }
  });

  it("rejects unknown events", () => {
    for (const event of ["quit", "LAUNCH", "", 1]) {
      expect(parseBeaconPayload({ ...VALID, event }).ok).toBe(false);
    }
  });

  it("rejects oversized or exotic version strings", () => {
    expect(parseBeaconPayload({ ...VALID, appVersion: "1".repeat(64) }).ok).toBe(false);
    expect(parseBeaconPayload({ ...VALID, appVersion: "1.0; DROP" }).ok).toBe(false);
    expect(parseBeaconPayload({ ...VALID, macosVersion: "" }).ok).toBe(false);
    expect(parseBeaconPayload({ ...VALID, macosVersion: 26 }).ok).toBe(false);
  });

  it("pins appVersion to the app's semver shape, not any short string", () => {
    for (const v of ["0.1.0", "1.2.0-beta.1", "26.0.1"]) {
      expect(parseBeaconPayload({ ...VALID, appVersion: v }).ok).toBe(true);
    }
    // Two-part, alphabetic, and decorated strings are junk for the versions
    // hash even though they would be harmless as plain text.
    for (const v of ["15.5", "abc", "v0.1.0", "0.1.0.9999", "1.2.0-" + "x".repeat(30)]) {
      expect(parseBeaconPayload({ ...VALID, appVersion: v }).ok).toBe(false);
    }
  });

  it("accepts two- and three-part macOS versions only", () => {
    for (const v of ["15.5", "26.0", "26.0.1"]) {
      expect(parseBeaconPayload({ ...VALID, macosVersion: v }).ok).toBe(true);
    }
    for (const v of ["26", "26.0.1.2", "sequoia"]) {
      expect(parseBeaconPayload({ ...VALID, macosVersion: v }).ok).toBe(false);
    }
  });
});

describe("UTC stamps and keys", () => {
  // 2026-07-10T01:30:00Z
  const NOW = Date.UTC(2026, 6, 10, 1, 30);

  it("buckets by UTC day and month", () => {
    expect(utcDayStamp(NOW)).toBe("20260710");
    expect(utcMonthStamp(NOW)).toBe("202607");
  });

  it("walks the trailing week across month boundaries", () => {
    const firstOfMonth = Date.UTC(2026, 6, 2, 12);
    expect(lastNDayStamps(firstOfMonth, 7)).toEqual([
      "20260702",
      "20260701",
      "20260630",
      "20260629",
      "20260628",
      "20260627",
      "20260626",
    ]);
  });

  it("derives every key from the same stamps", () => {
    expect(beaconKeys.day(NOW)).toBe("beacon:ids:d:20260710");
    expect(beaconKeys.month(NOW)).toBe("beacon:ids:m:202607");
    expect(beaconKeys.week(NOW)).toHaveLength(7);
    expect(beaconKeys.week(NOW)[0]).toBe("beacon:ids:d:20260710");
    expect(beaconKeys.count("launch")).toBe("beacon:count:launch");
    expect(beaconKeys.versionsOverflow).toBe("beacon:versions-overflow");
    expect(beaconKeys.rateLimit("abc")).toBe("beacon:rl:abc");
  });
});
