// Pins the desktop runtime server's decision logic (electron/runtime-server.js
// consumes the compiled form of lib/desktop-runtime.ts). The model/key routing
// must stay in lockstep with the web route's agents factory; these tests mirror
// the route semantics the same way lib/server-keys.test.ts pins the guard.

import { describe, expect, it } from "vitest";
import {
  resolveDesktopAgentSpec,
  desktopKeyError,
  isAllowedRuntimeOrigin,
  HOSTED_PROVIDER,
} from "./desktop-runtime";

const NO_ENV = {} as Record<string, string | undefined>;

describe("resolveDesktopAgentSpec", () => {
  it("uses the stored key and the provider's default model (BYOK)", () => {
    const spec = resolveDesktopAgentSpec({ provider: "gemini", storedKey: "user-key", env: NO_ENV });
    expect(spec).toEqual({ model: "google/gemini-2.5-flash-lite", apiKey: "user-key" });
  });

  it("honors CAPTURIA_MODEL when it stays on the user's provider", () => {
    const spec = resolveDesktopAgentSpec({
      provider: "gemini",
      storedKey: "user-key",
      env: { CAPTURIA_MODEL: "gemini/gemini-2.5-flash" },
    });
    // Alias spelling ("gemini/", not "google/") must still count as the same
    // provider, exactly like the route (canonicalProvider).
    expect(spec.model).toBe("gemini/gemini-2.5-flash");
    expect(spec.apiKey).toBe("user-key");
  });

  it("ignores a cross-provider CAPTURIA_MODEL so the user's key never leaves their provider", () => {
    const spec = resolveDesktopAgentSpec({
      provider: "claude",
      storedKey: "user-key",
      env: { CAPTURIA_MODEL: "google/gemini-2.5-pro" },
    });
    expect(spec.model).toBe("anthropic/claude-sonnet-4-6");
    expect(spec.apiKey).toBe("user-key");
  });

  it("is prototype-safe for a hostile provider header", () => {
    const spec = resolveDesktopAgentSpec({ provider: "constructor", storedKey: "k", env: NO_ENV });
    expect(spec.model).toBe("google/gemini-2.5-flash-lite");
  });

  it("falls back to the env spec when there is no stored key", () => {
    const spec = resolveDesktopAgentSpec({
      provider: "gemini",
      storedKey: null,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "env-key" },
    });
    expect(spec).toEqual({ model: "google/gemini-2.5-flash-lite", apiKey: "env-key" });
  });

  it("resolves the env key from the PASSED env for every mapped provider, never process.env", () => {
    // Electron main does not load .env files, so resolveModel's process.env
    // fallback sees nothing; the spec must carry the key explicitly or the
    // keycheck would pass while every run fails.
    expect(
      resolveDesktopAgentSpec({
        provider: null,
        storedKey: null,
        env: { CAPTURIA_PROVIDER: "claude", ANTHROPIC_API_KEY: "claude-env-key" },
      })
    ).toEqual({ model: "anthropic/claude-sonnet-4-6", apiKey: "claude-env-key" });
    expect(
      resolveDesktopAgentSpec({
        provider: null,
        storedKey: null,
        env: { GOOGLE_API_KEY: "aistudio-key" },
      })
    ).toEqual({ model: "google/gemini-2.5-flash-lite", apiKey: "aistudio-key" });
  });

  it("prefers GOOGLE_GENERATIVE_AI_API_KEY over GOOGLE_API_KEY, matching the web route", () => {
    const spec = resolveDesktopAgentSpec({
      provider: null,
      storedKey: null,
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "genai-key", GOOGLE_API_KEY: "aistudio-key" },
    });
    expect(spec.apiKey).toBe("genai-key");
  });

  it("leaves unmapped specs keyless for resolveModel to handle", () => {
    const spec = resolveDesktopAgentSpec({
      provider: null,
      storedKey: null,
      env: { CAPTURIA_MODEL: "vertex/gemini-2.5-pro", GOOGLE_API_KEY: "aistudio-key" },
    });
    expect(spec.model).toBe("vertex/gemini-2.5-pro");
    expect(spec.apiKey).toBeUndefined();
  });

  it("routes the hosted provider at Capturia's proxy with the vault token in the key slot", () => {
    const spec = resolveDesktopAgentSpec({
      provider: HOSTED_PROVIDER,
      storedKey: "capturia-jwt",
      env: NO_ENV,
    });
    expect(spec.model).toBe("google/gemini-2.5-flash-lite");
    expect(spec.apiKey).toBe("capturia-jwt");
    expect(spec.hosted).toEqual({
      baseUrl: "https://www.capturia.dev/api/hosted/v1beta",
      modelId: "gemini-2.5-flash-lite",
    });
  });

  it("honors the CAPTURIA_HOSTED_URL and CAPTURIA_HOSTED_MODEL env overrides", () => {
    // The env override is the slice-1 test hook for hosted wiring: point the
    // desktop runtime at a local dev proxy without touching the default.
    const spec = resolveDesktopAgentSpec({
      provider: HOSTED_PROVIDER,
      storedKey: "capturia-jwt",
      env: {
        CAPTURIA_HOSTED_URL: "http://localhost:3000/api/hosted/",
        CAPTURIA_HOSTED_MODEL: "gemini-2.5-flash",
      },
    });
    expect(spec.hosted).toEqual({
      baseUrl: "http://localhost:3000/api/hosted/v1beta",
      modelId: "gemini-2.5-flash",
    });
    expect(spec.model).toBe("google/gemini-2.5-flash");
  });

  it("falls back to the env spec when the hosted slot has no token", () => {
    const spec = resolveDesktopAgentSpec({
      provider: HOSTED_PROVIDER,
      storedKey: null,
      env: { GOOGLE_API_KEY: "aistudio-key" },
    });
    expect(spec.hosted).toBeUndefined();
    expect(spec.apiKey).toBe("aistudio-key");
  });
});

describe("desktopKeyError", () => {
  it("is null when a stored key covers the request", () => {
    expect(desktopKeyError({ provider: "gemini", storedKey: "k", env: NO_ENV })).toBeNull();
  });

  it("points a keyless desktop at Settings, not at .env.local", () => {
    // The shared web copy names env vars and .env.local; neither exists for
    // a packaged-app user, so the desktop rewrite must route through
    // Settings and the free-key path instead.
    const err = desktopKeyError({ provider: "gemini", storedKey: null, env: NO_ENV });
    expect(err).toMatch(/Settings/);
    expect(err).toMatch(/aistudio\.google\.com/);
    expect(err).not.toMatch(/env\.local/);
  });

  it("is null when the env fallback has a usable key", () => {
    expect(
      desktopKeyError({ provider: null, storedKey: null, env: { GOOGLE_API_KEY: "k" } })
    ).toBeNull();
  });

  it("is null when the hosted slot holds a token", () => {
    expect(desktopKeyError({ provider: HOSTED_PROVIDER, storedKey: "jwt", env: NO_ENV })).toBeNull();
  });

  it("stays null for hosted-without-token when the env fallback would run anyway", () => {
    // Mirrors the agents factory: no token means the request falls through to
    // the env spec, so a usable env key must not trip the fail-fast.
    expect(
      desktopKeyError({ provider: HOSTED_PROVIDER, storedKey: null, env: { GOOGLE_API_KEY: "k" } })
    ).toBeNull();
  });

  it("names the missing Capturia token instead of suggesting env API keys", () => {
    const err = desktopKeyError({ provider: HOSTED_PROVIDER, storedKey: null, env: NO_ENV });
    expect(err).toMatch(/Capturia Pro/);
    expect(err).not.toMatch(/GOOGLE_API_KEY/);
  });
});

describe("isAllowedRuntimeOrigin", () => {
  it('allows the file:// renderer ("null" origin) in both modes', () => {
    expect(isAllowedRuntimeOrigin("null", true)).toBe(true);
    expect(isAllowedRuntimeOrigin("null", false)).toBe(true);
  });

  it("allows the local Next server only in dev", () => {
    expect(isAllowedRuntimeOrigin("http://localhost:3000", true)).toBe(true);
    expect(isAllowedRuntimeOrigin("http://127.0.0.1:3999", true)).toBe(true);
    expect(isAllowedRuntimeOrigin("http://localhost:3000", false)).toBe(false);
  });

  it("rejects everything else", () => {
    expect(isAllowedRuntimeOrigin("https://evil.example", true)).toBe(false);
    expect(isAllowedRuntimeOrigin("http://localhost.evil.example", true)).toBe(false);
    expect(isAllowedRuntimeOrigin("not a url", true)).toBe(false);
    expect(isAllowedRuntimeOrigin("", true)).toBe(false);
  });
});
