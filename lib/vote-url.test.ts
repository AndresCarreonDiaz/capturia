import { describe, expect, it } from "vitest";
import { voteOriginUsable, voteUrlLocalhostOnly } from "./vote-url";

describe("voteOriginUsable", () => {
  it("accepts http and https origins", () => {
    expect(voteOriginUsable("http://localhost:3000")).toBe(true);
    expect(voteOriginUsable("https://capturia.example")).toBe(true);
    expect(voteOriginUsable("HTTPS://capturia.example")).toBe(true);
    expect(voteOriginUsable("http://192.168.1.20:3000")).toBe(true);
  });

  it("rejects the packaged app's file origin in both browser spellings", () => {
    expect(voteOriginUsable("file://")).toBe(false);
    expect(voteOriginUsable("null")).toBe(false);
  });

  it("rejects empty and missing origins (prerender)", () => {
    expect(voteOriginUsable("")).toBe(false);
    expect(voteOriginUsable(null)).toBe(false);
    expect(voteOriginUsable(undefined)).toBe(false);
  });

  it("rejects other non-http schemes", () => {
    expect(voteOriginUsable("chrome-extension://abc")).toBe(false);
    expect(voteOriginUsable("httpsish://nope")).toBe(false);
  });
});

describe("voteUrlLocalhostOnly", () => {
  it("flags localhost and loopback vote urls", () => {
    expect(voteUrlLocalhostOnly("http://localhost:3000/vote/abc")).toBe(true);
    expect(voteUrlLocalhostOnly("http://127.0.0.1:3000/vote/abc")).toBe(true);
    expect(voteUrlLocalhostOnly("https://localhost/vote/abc")).toBe(true);
  });

  it("does not flag LAN or public vote urls", () => {
    expect(voteUrlLocalhostOnly("http://192.168.1.20:3000/vote/abc")).toBe(false);
    expect(voteUrlLocalhostOnly("https://capturia.example/vote/abc")).toBe(false);
    // a path that merely contains the word localhost is not a loopback host
    expect(voteUrlLocalhostOnly("https://capturia.example/vote/localhost")).toBe(false);
  });
});
