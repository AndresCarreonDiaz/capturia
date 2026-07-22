// Pins the desktop upgrade-flow decisions (lib/hosted-billing.ts): billing
// origin derivation, activation-code normalization, response validation,
// refresh scheduling, refresh-failure classification, and vault-clear
// routing.

import { describe, expect, it } from "vitest";
import {
  ACTIVATION_CODE_RE,
  billingOriginFromEnv,
  classifyRefreshFailure,
  classifyVaultClear,
  computeRefreshDelayMs,
  MAX_REFRESH_DELAY_MS,
  MIN_REFRESH_DELAY_MS,
  normalizeActivationCode,
  parseActivateResponse,
  parseTokenResponse,
  parseUsageResponse,
} from "./hosted-billing";
import { ACTIVATION_CODE_RE as SERVER_RE, mintActivationCode } from "./hosted/entitlements";

describe("activation code shape", () => {
  it("is the SAME regex object the server mints against", () => {
    expect(SERVER_RE).toBe(ACTIVATION_CODE_RE);
    for (let i = 0; i < 10; i++) {
      expect(normalizeActivationCode(mintActivationCode())).not.toBeNull();
    }
  });

  it("normalizes pasted whitespace and case, refuses everything else", () => {
    expect(normalizeActivationCode("  capturia-ab12-cd34-ef56-gh78\n")).toBe(
      "CAPTURIA-AB12-CD34-EF56-GH78"
    );
    expect(normalizeActivationCode("CAPTURIA-AB12-CD34-EF56")).toBeNull(); // 3 groups
    expect(normalizeActivationCode("CAPTURIA-AB1O-CD34-EF56-GH78")).toBeNull(); // O excluded
    expect(normalizeActivationCode("")).toBeNull();
    expect(normalizeActivationCode(42)).toBeNull();
  });
});

describe("billingOriginFromEnv", () => {
  it("derives the origin from the hosted proxy URL", () => {
    expect(billingOriginFromEnv({})).toBe("https://www.capturia.dev");
    expect(billingOriginFromEnv({ CAPTURIA_HOSTED_URL: "http://localhost:3000/api/hosted" })).toBe(
      "http://localhost:3000"
    );
    expect(billingOriginFromEnv({ CAPTURIA_HOSTED_URL: "https://staging.capturia.dev/api/hosted/" })).toBe(
      "https://staging.capturia.dev"
    );
  });
});

describe("response parsing", () => {
  it("accepts the activate contract and fills a devices default", () => {
    expect(
      parseActivateResponse({ refreshToken: "crt_x", token: "jwt", expiresAt: 123, devices: 2 })
    ).toEqual({ refreshToken: "crt_x", token: "jwt", expiresAt: 123, devices: 2 });
    expect(parseActivateResponse({ refreshToken: "crt_x", token: "jwt", expiresAt: 123 })).toMatchObject(
      { devices: 1 }
    );
  });

  it("rejects partial or malformed bodies", () => {
    expect(parseActivateResponse(null)).toBeNull();
    expect(parseActivateResponse({ token: "jwt", expiresAt: 1 })).toBeNull();
    expect(parseActivateResponse({ refreshToken: "", token: "jwt", expiresAt: 1 })).toBeNull();
    expect(parseActivateResponse({ refreshToken: "crt", token: "jwt", expiresAt: "soon" })).toBeNull();
    expect(parseTokenResponse({ token: "jwt" })).toBeNull();
    expect(parseTokenResponse({ token: "jwt", expiresAt: 5 })).toEqual({ token: "jwt", expiresAt: 5 });
  });

  it("accepts the usage contract and drops extra fields", () => {
    const wire = {
      tokensUsed: 275_000,
      monthlyTokenBudget: 5_500_000,
      flashTokensUsed: 0,
      flashTokenBudget: 500_000,
      periodEnd: 1_800_000_000_000,
      someFutureField: "ignored",
    };
    expect(parseUsageResponse(wire)).toEqual({
      tokensUsed: 275_000,
      monthlyTokenBudget: 5_500_000,
      flashTokensUsed: 0,
      flashTokenBudget: 500_000,
      periodEnd: 1_800_000_000_000,
    });
  });

  it("rejects partial, negative, or malformed usage bodies", () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse({})).toBeNull();
    expect(
      parseUsageResponse({
        tokensUsed: "many",
        monthlyTokenBudget: 5_500_000,
        flashTokensUsed: 0,
        flashTokenBudget: 500_000,
        periodEnd: 1,
      })
    ).toBeNull();
    expect(
      parseUsageResponse({
        tokensUsed: -1,
        monthlyTokenBudget: 5_500_000,
        flashTokensUsed: 0,
        flashTokenBudget: 500_000,
        periodEnd: 1,
      })
    ).toBeNull();
  });
});

describe("refresh scheduling", () => {
  const NOW = 1_700_000_000_000;

  it("refreshes at 80% of remaining lifetime within the clamps", () => {
    expect(computeRefreshDelayMs(NOW + 10 * 60_000, NOW)).toBe(8 * 60_000);
    // A ~1h JWT clamps to the 45min ceiling.
    expect(computeRefreshDelayMs(NOW + 60 * 60_000, NOW)).toBe(MAX_REFRESH_DELAY_MS);
    // Already expired (app was closed): retry at the floor, not instantly.
    expect(computeRefreshDelayMs(NOW - 1, NOW)).toBe(MIN_REFRESH_DELAY_MS);
    expect(computeRefreshDelayMs(Number.NaN, NOW)).toBe(MIN_REFRESH_DELAY_MS);
  });

  it("classifies refresh failures by what the user can do about them", () => {
    expect(classifyRefreshFailure(401)).toBe("drop_credentials");
    expect(classifyRefreshFailure(403)).toBe("drop_credentials");
    expect(classifyRefreshFailure(402)).toBe("keep_and_retry_slowly");
    expect(classifyRefreshFailure(500)).toBe("keep_and_retry");
    expect(classifyRefreshFailure(0)).toBe("keep_and_retry");
  });
});

describe("vault clear routing", () => {
  it("routes the Pro row to local deactivation, never a bare key delete", () => {
    expect(classifyVaultClear("capturia-hosted")).toBe("deactivate_hosted");
  });

  it("routes every BYOK provider to a plain keychain delete", () => {
    expect(classifyVaultClear("gemini")).toBe("clear_key");
    expect(classifyVaultClear("claude")).toBe("clear_key");
    expect(classifyVaultClear("openai")).toBe("clear_key");
  });
});
