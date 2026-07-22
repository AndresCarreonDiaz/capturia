// Route-level contract for self-serve device deactivation
// (app/api/billing/deactivate/route.ts). The hard properties: auth parity
// with the proxy (same device JWT, same 401/503 shapes), the caller can only
// free its OWN seat (customer and device both come from verified claims),
// idempotency (a retry answers the same 200), and the end-to-end degrade:
// a deactivated device's refresh token must stop minting.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRedis } from "@/lib/hosted/memory-redis";
import { getHostedBackend } from "@/lib/hosted/backend";
import {
  isDeviceRegistered,
  mintRefreshToken,
  registerDevice,
  writeEntitlement,
} from "@/lib/hosted/entitlements";
import { generateJwtKeyPair, jwtPrivateKeyFromEnv, signHostedJwt } from "@/lib/hosted/jwt";
import { POST } from "./route";
import { POST as refreshToken } from "../token/route";

// Same seam as the usage route test: the route resolves its store through
// this single factory.
vi.mock("@/lib/hosted/backend", () => ({
  getHostedBackend: vi.fn(),
}));

const CUSTOMER = "cus_deactivate_test";
const DEVICE = "mac-deactivate-1";
const KEYS = generateJwtKeyPair();

function mintToken(device = DEVICE, nowMs = Date.now()): string {
  const privateKey = jwtPrivateKeyFromEnv({ CAPTURIA_JWT_PRIVATE_KEY: KEYS.privateKey })!;
  return signHostedJwt({ customer: CUSTOMER, device, plan: "pro", privateKey, nowMs }).token;
}

function world() {
  const redis = createMemoryRedis();
  vi.mocked(getHostedBackend).mockResolvedValue({ mode: "memory", run: redis.run });
  return { run: redis.run };
}

function deactivateRequest(headers?: Record<string, string>): Request {
  return new Request("http://localhost/api/billing/deactivate", { method: "POST", headers });
}

beforeEach(() => {
  vi.mocked(getHostedBackend).mockReset();
  vi.unstubAllEnvs();
  vi.stubEnv("CAPTURIA_JWT_PUBLIC_KEY", KEYS.publicKey);
});

describe("POST /api/billing/deactivate", () => {
  it("503s when the hosted tier is unconfigured, like the proxy", async () => {
    vi.stubEnv("CAPTURIA_JWT_PUBLIC_KEY", "");
    const res = await POST(deactivateRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(503);
  });

  it("401s without a token, with a garbage token, and with an expired token", async () => {
    world();
    expect((await POST(deactivateRequest())).status).toBe(401);
    expect((await POST(deactivateRequest({ authorization: "Bearer not.a.jwt" }))).status).toBe(401);
    const stale = mintToken(DEVICE, Date.now() - 2 * 60 * 60 * 1000); // past the 1h TTL
    expect((await POST(deactivateRequest({ authorization: `Bearer ${stale}` }))).status).toBe(401);
  });

  it("503s when the state backend is unconfigured", async () => {
    vi.mocked(getHostedBackend).mockRejectedValue(new Error("refusing in-memory state"));
    const res = await POST(deactivateRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(503);
  });

  it("frees exactly the calling device's seat so a new device can take it", async () => {
    const { run } = world();
    await registerDevice(run, CUSTOMER, DEVICE);
    await registerDevice(run, CUSTOMER, "mac-keeper-2");
    await registerDevice(run, CUSTOMER, "mac-keeper-3");
    const res = await POST(deactivateRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, devices: 2 });
    // Only the JWT's own device left the set.
    expect(await isDeviceRegistered(run, CUSTOMER, DEVICE)).toBe(false);
    expect(await isDeviceRegistered(run, CUSTOMER, "mac-keeper-2")).toBe(true);
    expect(await isDeviceRegistered(run, CUSTOMER, "mac-keeper-3")).toBe(true);
    // The freed seat is immediately usable: the 4th distinct device now fits.
    expect(await registerDevice(run, CUSTOMER, "mac-newer-4")).toEqual({ ok: true, devices: 3 });
  });

  it("is idempotent: deactivating an already-free device answers the same 200", async () => {
    const { run } = world();
    await registerDevice(run, CUSTOMER, DEVICE);
    expect((await POST(deactivateRequest({ authorization: `Bearer ${mintToken()}` }))).status).toBe(200);
    const retry = await POST(deactivateRequest({ authorization: `Bearer ${mintToken()}` }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, devices: 0 });
  });

  it("stops the deactivated device's refresh token from minting (403 at the token endpoint)", async () => {
    const { run } = world();
    vi.stubEnv("CAPTURIA_JWT_PRIVATE_KEY", KEYS.privateKey);
    await writeEntitlement(run, CUSTOMER, "active", "sub_1", Date.now());
    await registerDevice(run, CUSTOMER, DEVICE);
    const token = await mintRefreshToken(run, CUSTOMER, DEVICE, Date.now());
    const mintReq = () =>
      new Request("http://localhost/api/billing/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: token }),
      });
    expect((await refreshToken(mintReq())).status).toBe(200);
    await POST(deactivateRequest({ authorization: `Bearer ${mintToken()}` }));
    // 403 is what the desktop refresh loop classifies as drop_credentials.
    expect((await refreshToken(mintReq())).status).toBe(403);
  });
});
