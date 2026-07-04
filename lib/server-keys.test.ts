import { describe, it, expect } from "vitest";
import {
  PROVIDER_MODELS,
  providerModelSpec,
  effectiveModelSpec,
  missingModelKeyError,
  modelSpecProvider,
  canonicalProvider,
  isNoThinkingModel,
} from "@/lib/server-keys";

// The fail-fast guard in the copilotkit route is only as good as this
// predicate: a false positive blocks a working deployment, a false negative
// reproduces the cryptic mid-stream auth error it exists to prevent. The cases
// mirror the env fallbacks of CopilotKit's resolveModel.

describe("modelSpecProvider", () => {
  it("extracts the prefix from slash and colon specs", () => {
    expect(modelSpecProvider("google/gemini-2.5-flash-lite")).toBe("google");
    expect(modelSpecProvider("anthropic:claude-sonnet-4-6")).toBe("anthropic");
    expect(modelSpecProvider("OpenAI/gpt-4o")).toBe("openai");
  });
});

describe("canonicalProvider", () => {
  it("folds the google aliases resolveModel accepts into one provider", () => {
    expect(canonicalProvider("google/gemini-2.5-flash")).toBe("google");
    expect(canonicalProvider("gemini/gemini-2.5-pro")).toBe("google");
    expect(canonicalProvider("google-gemini:gemini-2.5-flash")).toBe("google");
    expect(canonicalProvider("GOOGLE/gemini-2.5-flash")).toBe("google");
    expect(canonicalProvider("anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(canonicalProvider("vertex/gemini-2.5-flash")).toBe("vertex");
  });
});

describe("isNoThinkingModel", () => {
  it("matches every valid spelling of the flash models, not just the exact string", () => {
    // A self-hoster writing any of these valid specs must still get
    // thinkingBudget 0, or the empty-response bug silently returns.
    expect(isNoThinkingModel("google/gemini-2.5-flash")).toBe(true);
    expect(isNoThinkingModel("gemini/gemini-2.5-flash")).toBe(true);
    expect(isNoThinkingModel("google:gemini-2.5-flash-lite")).toBe(true);
    expect(isNoThinkingModel("google-gemini/GEMINI-2.5-FLASH")).toBe(true);
  });

  it("never disables thinking for models that reject or require it", () => {
    expect(isNoThinkingModel("google/gemini-2.5-pro")).toBe(false); // rejects budget 0
    expect(isNoThinkingModel("google/gemini-3-flash")).toBe(false); // requires thinking
    expect(isNoThinkingModel("anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isNoThinkingModel("vertex/gemini-2.5-flash")).toBe(false); // different key path
  });
});

describe("providerModelSpec", () => {
  it("maps known providers and defaults unknown ones to gemini", () => {
    expect(providerModelSpec("claude")).toBe(PROVIDER_MODELS.claude);
    expect(providerModelSpec("openai")).toBe(PROVIDER_MODELS.openai);
    expect(providerModelSpec("nonsense")).toBe(PROVIDER_MODELS.gemini);
    expect(providerModelSpec(null)).toBe(PROVIDER_MODELS.gemini);
    expect(providerModelSpec(undefined)).toBe(PROVIDER_MODELS.gemini);
  });

  it("does not resolve prototype-chain names to a Function (BYOK header is client-controlled)", () => {
    // A bracket index would return Object.prototype.constructor etc.; the guard
    // must fall through to the gemini default and stay a valid spec string.
    for (const evil of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const spec = providerModelSpec(evil);
      expect(typeof spec).toBe("string");
      expect(spec).toBe(PROVIDER_MODELS.gemini);
      // Sanity: the returned spec parses like a real model spec, not a Function.
      expect(modelSpecProvider(spec)).toBe("google");
    }
  });
});

describe("effectiveModelSpec", () => {
  it("defaults to the gemini web-demo model", () => {
    expect(effectiveModelSpec({})).toBe(PROVIDER_MODELS.gemini);
  });

  it("CAPTURIA_PROVIDER picks a provider default; CAPTURIA_MODEL pins exactly", () => {
    expect(effectiveModelSpec({ CAPTURIA_PROVIDER: "claude" })).toBe(PROVIDER_MODELS.claude);
    expect(
      effectiveModelSpec({ CAPTURIA_PROVIDER: "gemini", CAPTURIA_MODEL: "google/gemini-2.5-pro" })
    ).toBe("google/gemini-2.5-pro");
  });

  it("falls back to gemini for an unknown provider name", () => {
    expect(effectiveModelSpec({ CAPTURIA_PROVIDER: "nonsense" })).toBe(PROVIDER_MODELS.gemini);
  });
});

describe("missingModelKeyError", () => {
  const noByok = { byokProvider: null, byokKey: null };

  it("falls through (null) for prototype-key spec prefixes instead of throwing", () => {
    // "constructor/foo" would resolve Object.prototype.constructor on a bare
    // bracket lookup; envKeys.some would then throw and 500 the route. The
    // guard must treat it like any unknown prefix and let resolveModel decide.
    for (const evil of ["constructor/foo", "toString/x", "valueOf/y", "hasOwnProperty/z"]) {
      expect(missingModelKeyError({ ...noByok, env: { CAPTURIA_MODEL: evil } })).toBeNull();
    }
  });

  it("recognizes the gemini alias spellings as google (same env keys)", () => {
    const err = missingModelKeyError({ ...noByok, env: { CAPTURIA_MODEL: "gemini/gemini-2.5-pro" } });
    expect(err).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(
      missingModelKeyError({
        ...noByok,
        env: { CAPTURIA_MODEL: "gemini/gemini-2.5-pro", GOOGLE_API_KEY: "k" },
      })
    ).toBeNull();
  });

  it("passes BYOK requests through without consulting env", () => {
    expect(
      missingModelKeyError({ byokProvider: "gemini", byokKey: "user-key", env: {} })
    ).toBeNull();
  });

  it("requires BOTH BYOK headers, matching the agents factory", () => {
    const err = missingModelKeyError({ byokProvider: null, byokKey: "user-key", env: {} });
    expect(err).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(
      missingModelKeyError({ byokProvider: "gemini", byokKey: "", env: {} })
    ).not.toBeNull();
  });

  it("blocks the default gemini path with no key, naming both accepted env vars", () => {
    const err = missingModelKeyError({ ...noByok, env: {} });
    expect(err).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(err).toContain("GOOGLE_API_KEY");
    expect(err).toContain("aistudio.google.com");
  });

  it("accepts either google env var (resolveModel reads GOOGLE_API_KEY itself)", () => {
    expect(
      missingModelKeyError({ ...noByok, env: { GOOGLE_GENERATIVE_AI_API_KEY: "k" } })
    ).toBeNull();
    expect(missingModelKeyError({ ...noByok, env: { GOOGLE_API_KEY: "k" } })).toBeNull();
  });

  it("checks the right provider key for CAPTURIA_PROVIDER=claude/openai", () => {
    const claudeErr = missingModelKeyError({ ...noByok, env: { CAPTURIA_PROVIDER: "claude" } });
    expect(claudeErr).toContain("ANTHROPIC_API_KEY");
    expect(
      missingModelKeyError({
        ...noByok,
        env: { CAPTURIA_PROVIDER: "claude", ANTHROPIC_API_KEY: "k" },
      })
    ).toBeNull();
    expect(
      missingModelKeyError({ ...noByok, env: { CAPTURIA_PROVIDER: "openai" } })
    ).toContain("OPENAI_API_KEY");
  });

  it("keys off the pinned CAPTURIA_MODEL's provider, not CAPTURIA_PROVIDER", () => {
    const env = { CAPTURIA_PROVIDER: "gemini", CAPTURIA_MODEL: "anthropic/claude-haiku-4-5" };
    expect(missingModelKeyError({ ...noByok, env })).toContain("ANTHROPIC_API_KEY");
    expect(
      missingModelKeyError({ ...noByok, env: { ...env, ANTHROPIC_API_KEY: "k" } })
    ).toBeNull();
  });

  it("never blocks vertex/unknown prefixes (resolveModel handles those)", () => {
    expect(
      missingModelKeyError({ ...noByok, env: { CAPTURIA_MODEL: "vertex/gemini-2.5-pro" } })
    ).toBeNull();
  });
});
