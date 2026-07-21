import { describe, expect, it } from "vitest";
import {
  UPDATE_DOWNLOAD_URL,
  UPDATE_FEED_URL,
  decideUpdate,
  latestVersionFromRelease,
} from "./update-check";

const release = (tag_name: unknown) => ({ tag_name });

describe("latestVersionFromRelease", () => {
  it("reads tag_name and strips the v prefix", () => {
    expect(latestVersionFromRelease(release("v0.1.4"))).toBe("0.1.4");
  });

  it("accepts a bare numeric triple tag", () => {
    expect(latestVersionFromRelease(release("1.2.3"))).toBe("1.2.3");
  });

  it("tolerates surrounding whitespace", () => {
    expect(latestVersionFromRelease(release(" v0.1.4 "))).toBe("0.1.4");
  });

  it("answers null for anything that is not a version triple", () => {
    expect(latestVersionFromRelease(release("v1.2"))).toBeNull();
    expect(latestVersionFromRelease(release("1.2.3.4"))).toBeNull();
    expect(latestVersionFromRelease(release("v1.2.3-beta"))).toBeNull();
    expect(latestVersionFromRelease(release("latest"))).toBeNull();
    expect(latestVersionFromRelease(release(123))).toBeNull();
    expect(latestVersionFromRelease(release(undefined))).toBeNull();
  });

  it("answers null for a body that is not a release object", () => {
    expect(latestVersionFromRelease(null)).toBeNull();
    expect(latestVersionFromRelease("v0.1.4")).toBeNull();
    expect(latestVersionFromRelease([])).toBeNull();
  });
});

describe("decideUpdate", () => {
  it("flags a strictly newer release", () => {
    expect(decideUpdate("0.1.3", release("v0.1.4"))).toEqual({
      newer: true,
      latestVersion: "0.1.4",
    });
  });

  it("treats the running version as current when they match", () => {
    expect(decideUpdate("0.1.3", release("v0.1.3"))).toEqual({
      newer: false,
      latestVersion: "0.1.3",
    });
  });

  it("never flags an older release: a rollback is not an update", () => {
    expect(decideUpdate("0.2.0", release("v0.1.9")).newer).toBe(false);
  });

  it("compares numerically, not lexicographically", () => {
    expect(decideUpdate("0.1.9", release("v0.1.10")).newer).toBe(true);
    expect(decideUpdate("0.9.0", release("v0.10.0")).newer).toBe(true);
    expect(decideUpdate("0.10.0", release("v0.9.9")).newer).toBe(false);
  });

  it("lets a major or minor bump beat a higher patch", () => {
    expect(decideUpdate("0.1.9", release("v0.2.0")).newer).toBe(true);
    expect(decideUpdate("1.9.9", release("v2.0.0")).newer).toBe(true);
  });

  it("treats a malformed release tag as not-newer", () => {
    expect(decideUpdate("0.1.3", release("nightly"))).toEqual({
      newer: false,
      latestVersion: null,
    });
    expect(decideUpdate("0.1.3", null)).toEqual({ newer: false, latestVersion: null });
  });

  it("treats a malformed running version as not-newer but still names the release", () => {
    // A dev shell reporting something odd must not be nagged; the manual
    // check can still show what the latest release is.
    expect(decideUpdate("dev", release("v9.9.9"))).toEqual({
      newer: false,
      latestVersion: "9.9.9",
    });
  });
});

describe("endpoints", () => {
  it("pins both URLs to https: the download goes straight to shell.openExternal", () => {
    expect(UPDATE_FEED_URL.startsWith("https://api.github.com/")).toBe(true);
    expect(UPDATE_DOWNLOAD_URL).toBe("https://www.capturia.dev/download");
  });
});
