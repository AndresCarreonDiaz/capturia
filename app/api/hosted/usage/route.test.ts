// Route-level contract for the usage endpoint (app/api/hosted/usage/
// route.ts): the in-app hours meter reads exactly this. The one hard
// property is auth parity with the proxy: no token, a garbage token, and an
// expired token must be rejected with the proxy's own 401 (and 503 when the
// tier is unconfigured), because a customer's counters are as private as
// their generations.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRedis } from "@/lib/hosted/memory-redis";
import { getHostedBackend } from "@/lib/hosted/backend";
import { recordUsage } from "@/lib/hosted/gate";
import { generateJwtKeyPair, jwtPrivateKeyFromEnv, signHostedJwt } from "@/lib/hosted/jwt";
import { GET } from "./route";

// Same seam as the activation-code route test: the route resolves its store
// through this single factory.
vi.mock("@/lib/hosted/backend", () => ({
  getHostedBackend: vi.fn(),
}));

const CUSTOMER = "cus_usage_test";
const KEYS = generateJwtKeyPair();

function mintToken(nowMs = Date.now()): string {
  const privateKey = jwtPrivateKeyFromEnv({ CAPTURIA_JWT_PRIVATE_KEY: KEYS.privateKey })!;
  return signHostedJwt({ customer: CUSTOMER, device: "mac-test", plan: "pro", privateKey, nowMs })
    .token;
}

function world() {
  const redis = createMemoryRedis();
  vi.mocked(getHostedBackend).mockResolvedValue({ mode: "memory", run: redis.run });
  return { run: redis.run };
}

function usageRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/hosted/usage", { headers });
}

beforeEach(() => {
  vi.mocked(getHostedBackend).mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("CAPTURIA_JWT_PUBLIC_KEY", KEYS.publicKey);
});

describe("GET /api/hosted/usage", () => {
  it("503s when the hosted tier is unconfigured, like the proxy", async () => {
    vi.stubEnv("CAPTURIA_JWT_PUBLIC_KEY", "");
    const res = await GET(usageRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(503);
  });

  it("401s without a token and with a garbage token, like the proxy", async () => {
    world();
    expect((await GET(usageRequest())).status).toBe(401);
    expect((await GET(usageRequest({ authorization: "Bearer not.a.jwt" }))).status).toBe(401);
    expect((await GET(usageRequest({ "x-goog-api-key": "garbage" }))).status).toBe(401);
  });

  it("401s an expired token", async () => {
    world();
    const stale = mintToken(Date.now() - 2 * 60 * 60 * 1000); // past the 1h TTL
    const res = await GET(usageRequest({ authorization: `Bearer ${stale}` }));
    expect(res.status).toBe(401);
  });

  it("503s when the state backend is unconfigured", async () => {
    vi.mocked(getHostedBackend).mockRejectedValue(new Error("refusing in-memory state"));
    const res = await GET(usageRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(503);
  });

  it("reports zeros and the configured budgets for a fresh period", async () => {
    world();
    const res = await GET(usageRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      tokensUsed: 0,
      monthlyTokenBudget: 5_500_000,
      flashTokensUsed: 0,
      flashTokenBudget: 500_000,
      periodEnd: expect.any(Number),
    });
    // The period ends in the future, at a month boundary the client can
    // show as "resets on <date>".
    expect(body.periodEnd).toBeGreaterThan(Date.now());
  });

  it("reflects recorded usage on both counters", async () => {
    const { run } = world();
    const now = Date.now();
    await recordUsage(run, CUSTOMER, 275_000, now, "gemini-2.5-flash-lite");
    await recordUsage(run, CUSTOMER, 50_000, now, "gemini-2.5-flash");
    const body = await (await GET(usageRequest({ "x-goog-api-key": mintToken() }))).json();
    // Flash charges both counters (a carve-out, not an addition).
    expect(body.tokensUsed).toBe(325_000);
    expect(body.flashTokensUsed).toBe(50_000);
  });

  it("honors the budget env overrides the gate uses", async () => {
    world();
    vi.stubEnv("CAPTURIA_HOSTED_MONTHLY_TOKENS", "1000");
    vi.stubEnv("CAPTURIA_HOSTED_FLASH_MONTHLY_TOKENS", "100");
    const body = await (await GET(usageRequest({ authorization: `Bearer ${mintToken()}` }))).json();
    expect(body.monthlyTokenBudget).toBe(1000);
    expect(body.flashTokenBudget).toBe(100);
  });
});
