// Wiring tests for electron/hosted-billing.js (createHostedBilling), the
// main-process side of the Capturia Pro upgrade flow. The pure decisions are
// pinned in lib/hosted-billing.test.ts; THIS file pins how the wiring layer
// composes them with fetch, the keychain vault, and timers, including the
// vault-write epoch fence that keeps a raced refresh from resurrecting
// credentials the user just cleared.
//
// How the module is loaded (and why not vi.mock): hosted-billing.js is CJS
// and reaches "electron" and "./gen/hosted-billing" through native require(),
// which vi.mock cannot intercept (vitest module mocks only apply to imports
// that flow through the transform pipeline; a probe run confirmed
// vi.mock("electron") never reaches this module). So instead of mocking the
// gen module, the suite runs against the REAL compiled artifact (built by
// scripts/build-electron-libs.mjs when missing, mirroring
// scripts/smoke-runtime-server.mjs) and stubs "electron" by planting a fake
// module in the CJS require cache before anything loads. Higher fidelity
// than a mock re-export: the module under test loads exactly the way
// Electron main loads it, and drift between lib/hosted-billing.ts and the
// gen build would surface here instead of hiding behind a mock.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRefreshDelayMs,
  MAX_REFRESH_DELAY_MS,
  RETRY_TRANSIENT_MS,
  RETRY_UNENTITLED_MS,
} from "./hosted-billing";

const cjsRequire = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = 1_700_000_000_000;
const ORIGIN = "http://127.0.0.1:4571";
// Origin plumb-through: a dev CAPTURIA_HOSTED_URL must point checkout,
// activation, and token refresh at the same deployment as the proxy.
const ENV = { CAPTURIA_HOSTED_URL: `${ORIGIN}/api/hosted` };
const CODE = "CAPTURIA-AB12-CD34-EF56-GH78";

interface FetchResponseLike {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
}

interface HostedBilling {
  startCheckout(): Promise<string>;
  activate(rawCode: unknown): Promise<{ ok: true; devices: number }>;
  getUsage(): Promise<Record<string, number>>;
  refreshNow(): Promise<{ refreshed: boolean; reason?: string }>;
  start(): void;
  deactivateLocal(): void;
  stop(): void;
}

interface FakeKeychain {
  REFRESH_SLOT: string;
  vault: Map<string, string>;
  writes: string[];
  getKey(provider: string): string | null;
  saveKey(provider: string, key: string): void;
  clearKey(provider: string): void;
}

type CreateHostedBilling = (options: {
  keychain: FakeKeychain;
  env: Record<string, string | undefined>;
  log: { log: (line: string) => void };
}) => HostedBilling;

let userDataDir: string;
let electronModuleId: string;
let createHostedBilling: CreateHostedBilling;
let HOSTED_SLOT: string;
let REFRESH_SLOT: string;
let PROVIDERS: string[];

beforeAll(() => {
  // The gen build is a generated artifact: make sure it exists before the
  // module under test requires it, exactly like the runtime-server smoke
  // script does. Long timeout because tsc may have to run once.
  if (!existsSync(join(repoRoot, "electron", "gen", "hosted-billing.js"))) {
    execFileSync(process.execPath, [join(repoRoot, "scripts", "build-electron-libs.mjs")], {
      stdio: "inherit",
    });
  }

  userDataDir = mkdtempSync(join(tmpdir(), "capturia-billing-wiring-"));

  // Plant the electron stub where native require() will find it. Under plain
  // node the electron package resolves to a shim that exports the path to
  // the Electron binary (a string), so without this app.getPath would crash.
  electronModuleId = cjsRequire.resolve("electron");
  cjsRequire.cache[electronModuleId] = {
    id: electronModuleId,
    filename: electronModuleId,
    loaded: true,
    exports: { app: { getPath: () => userDataDir } },
  } as unknown as NodeModule;

  // Real constants, not copies: the fake keychain must mirror the real
  // vault's slot names and provider allowlist, so both come straight from
  // electron/keychain.js (safe to load here: its module scope only
  // destructures the electron stub, safeStorage is untouched until saveKey).
  ({ REFRESH_SLOT, PROVIDERS } = cjsRequire(join(repoRoot, "electron", "keychain.js")));
  ({ createHostedBilling, HOSTED_SLOT } = cjsRequire(
    join(repoRoot, "electron", "hosted-billing.js")
  ));
}, 120_000);

afterAll(() => {
  delete cjsRequire.cache[electronModuleId];
  rmSync(userDataDir, { recursive: true, force: true });
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// A fetch whose settlement the test controls, for racing deactivateLocal
// against a request that is already on the wire. Both createHostedBilling
// entry points invoke fetch synchronously (nothing is awaited before the
// POST), so release/fail are always assigned by the time the caller returns.
function heldFetch() {
  let release!: (response: FetchResponseLike) => void;
  let fail!: (error: Error) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<FetchResponseLike>((res, rej) => {
        release = res;
        fail = rej;
      })
  );
  return {
    release: (response: FetchResponseLike) => release(response),
    fail: (error: Error) => fail(error),
  };
}

function makeFakeKeychain(): FakeKeychain {
  const vault = new Map<string, string>();
  const writes: string[] = [];
  // Same contract as electron/keychain.js: unknown slots throw, so a typo in
  // the wiring fails these tests loudly instead of writing a ghost slot.
  function assertProvider(provider: string) {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  }
  return {
    REFRESH_SLOT,
    vault,
    writes,
    getKey(provider) {
      assertProvider(provider);
      return vault.get(provider) ?? null;
    },
    saveKey(provider, key) {
      assertProvider(provider);
      if (typeof key !== "string" || !key.trim()) throw new Error("Key must be a non-empty string.");
      vault.set(provider, key);
      writes.push(provider);
    },
    clearKey(provider) {
      assertProvider(provider);
      vault.delete(provider);
    },
  };
}

function makeBilling() {
  const keychain = makeFakeKeychain();
  const log = { log: vi.fn() };
  const billing = createHostedBilling({ keychain, env: ENV, log });
  return { billing, keychain, log };
}

// Seed directly on the Map (not via saveKey) so keychain.writes only records
// writes the module itself performed.
function seed(keychain: FakeKeychain) {
  keychain.vault.set(REFRESH_SLOT, "crt_seed");
  keychain.vault.set(HOSTED_SLOT, "jwt_old");
}

describe("vault slot contract", () => {
  it("uses slot names the real keychain accepts", () => {
    expect(HOSTED_SLOT).toBe("capturia-hosted");
    expect(REFRESH_SLOT).toBe("capturia-hosted-refresh");
    expect(PROVIDERS).toContain(HOSTED_SLOT);
    expect(PROVIDERS).toContain(REFRESH_SLOT);
  });
});

describe("activate", () => {
  it("trades the code for credentials: refresh token saved before the JWT, refresh scheduled", async () => {
    const { billing, keychain } = makeBilling();
    const expiresAt = NOW + 10 * 60_000;
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { refreshToken: "crt_new", token: "jwt_1", expiresAt, devices: 2 })
    );

    // Pasted-with-noise code: the wiring must POST the normalized form.
    await expect(billing.activate(`  ${CODE.toLowerCase()}\n`)).resolves.toEqual({
      ok: true,
      devices: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/billing/activate`);
    const body = JSON.parse(init.body);
    expect(body.code).toBe(CODE);
    // Minted once per install, in the shape the module writes on first run.
    expect(body.deviceId).toMatch(/^mac-[0-9a-f-]{36}$/);

    // Refresh token FIRST: if the JWT write failed, the worst case is a
    // token refresh on next launch, never a stored JWT with no way to renew.
    expect(keychain.writes).toEqual([REFRESH_SLOT, HOSTED_SLOT]);
    expect(keychain.vault.get(REFRESH_SLOT)).toBe("crt_new");
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_1");

    // One refresh armed at 80% of the JWT lifetime; prove the delay by
    // straddling the boundary, then check the fired refresh hits the token
    // endpoint with the refresh token it just stored.
    expect(vi.getTimerCount()).toBe(1);
    const delay = computeRefreshDelayMs(expiresAt, NOW);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "jwt_2", expiresAt: expiresAt + 10 * 60_000 })
    );
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${ORIGIN}/api/billing/token`);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ refreshToken: "crt_new" });
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_2");
  });

  it("refuses a malformed code before any network or vault touch", async () => {
    const { billing, keychain } = makeBilling();
    await expect(billing.activate("CAPTURIA-AB12-CD34-EF56")).rejects.toThrow(
      /does not look like a Capturia activation code/
    );
    await expect(billing.activate(42)).rejects.toThrow(/activation code/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keychain.vault.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces the server's error string on a non-2xx", async () => {
    const { billing, keychain } = makeBilling();
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "That code was already used." }));
    await expect(billing.activate(CODE)).rejects.toThrow("That code was already used.");
    expect(keychain.vault.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a 2xx body that fails validation instead of storing junk", async () => {
    const { billing, keychain } = makeBilling();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "jwt_only" }));
    await expect(billing.activate(CODE)).rejects.toThrow(/unexpected response/);
    expect(keychain.vault.size).toBe(0);
  });
});

describe("startCheckout", () => {
  it("returns the https checkout URL", async () => {
    const { billing } = makeBilling();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" })
    );
    await expect(billing.startCheckout()).resolves.toBe(
      "https://checkout.stripe.com/c/pay/cs_test_1"
    );
    expect(fetchMock.mock.calls[0][0]).toBe(`${ORIGIN}/api/billing/checkout`);
  });

  it("refuses a non-https URL even on a 2xx: the result goes to shell.openExternal", async () => {
    const { billing } = makeBilling();
    // A compromised or misconfigured billing origin must not be able to hand
    // the OS an arbitrary scheme (recent security guard in the module).
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "capturia://pwn"]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { url }));
      await expect(billing.startCheckout()).rejects.toThrow(/^Could not start checkout/);
    }
  });

  it("relays the server's error detail on failure", async () => {
    const { billing } = makeBilling();
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: "Stripe is not configured." }));
    await expect(billing.startCheckout()).rejects.toThrow(
      "Could not start checkout: Stripe is not configured."
    );
  });
});

describe("getUsage", () => {
  const USAGE = {
    tokensUsed: 275_000,
    monthlyTokenBudget: 5_500_000,
    flashTokensUsed: 10_000,
    flashTokenBudget: 500_000,
    periodEnd: NOW + 10 * 24 * 60 * 60 * 1000,
  };

  it("reads the usage endpoint with the stored JWT as a bearer", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, USAGE));
    await expect(billing.getUsage()).resolves.toEqual(USAGE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/hosted/usage`);
    expect(init.headers.authorization).toBe("Bearer jwt_old");
  });

  it("refuses without a stored JWT, before any network touch", async () => {
    const { billing } = makeBilling();
    await expect(billing.getUsage()).rejects.toThrow(/not active/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's error string and rejects malformed 2xx bodies", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "token expired" }));
    await expect(billing.getUsage()).rejects.toThrow(/token expired/);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tokensUsed: "many" }));
    await expect(billing.getUsage()).rejects.toThrow(/unexpected response/);
  });
});

describe("refresh loop", () => {
  it("does nothing without a refresh token", async () => {
    const { billing } = makeBilling();
    await expect(billing.refreshNow()).resolves.toEqual({
      refreshed: false,
      reason: "no_refresh_token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("saves the fresh JWT and keeps the chain alive", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    const expiresAt = NOW + 10 * 60_000;
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "jwt_new", expiresAt }));

    await expect(billing.refreshNow()).resolves.toEqual({ refreshed: true });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refreshToken: "crt_seed" });
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_new");
    expect(keychain.vault.get(REFRESH_SLOT)).toBe("crt_seed");
    expect(vi.getTimerCount()).toBe(1);

    // The loop re-arms itself off the new expiry and refreshes again.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "jwt_next", expiresAt: expiresAt + 10 * 60_000 })
    );
    await vi.advanceTimersByTimeAsync(computeRefreshDelayMs(expiresAt, NOW));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_next");
  });

  it("drops BOTH slots on 401/403 and stops retrying: only a new code helps", async () => {
    for (const status of [401, 403]) {
      const { billing, keychain } = makeBilling();
      seed(keychain);
      fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: "unknown refresh token" }));
      await expect(billing.refreshNow()).resolves.toEqual({ refreshed: false, reason: "revoked" });
      expect(keychain.vault.size).toBe(0);
      // Terminal: a dead token cannot come back, so no retry timer.
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("keeps the refresh token on 402 and retries on the slow cadence", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    fetchMock.mockResolvedValueOnce(jsonResponse(402, { error: "payment required" }));
    await expect(billing.refreshNow()).resolves.toEqual({ refreshed: false, reason: "http_402" });
    // Stripe may recover the subscription on a later card retry: keep the
    // refresh token, let the stored JWT expire naturally.
    expect(keychain.vault.get(REFRESH_SLOT)).toBe("crt_seed");
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_old");
    expect(vi.getTimerCount()).toBe(1);

    // Prove it is the slow lane: silent at the transient cadence, fires at
    // RETRY_UNENTITLED_MS.
    fetchMock.mockResolvedValueOnce(jsonResponse(402, {}));
    await vi.advanceTimersByTimeAsync(RETRY_TRANSIENT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_UNENTITLED_MS - RETRY_TRANSIENT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("schedules the transient retry on a network error", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(billing.refreshNow()).resolves.toEqual({ refreshed: false, reason: "network" });
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_old");
    expect(vi.getTimerCount()).toBe(1);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "jwt_new", expiresAt: NOW + RETRY_TRANSIENT_MS + 10 * 60_000 })
    );
    await vi.advanceTimersByTimeAsync(RETRY_TRANSIENT_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_new");
  });

  it("refreshes immediately on boot only when a refresh token exists", async () => {
    const cold = makeBilling();
    cold.billing.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();

    const { billing, keychain } = makeBilling();
    seed(keychain);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "jwt_boot", expiresAt: NOW + 10 * 60_000 }));
    billing.start();
    // start() fires refreshNow without awaiting; flush its microtasks.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_boot");
  });
});

describe("epoch fence (vault-write races)", () => {
  it("discards a refresh that raced deactivateLocal: the cleared vault wins", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    const held = heldFetch();
    const inFlight = billing.refreshNow();
    // The user clicks Clear while the token request is on the wire.
    billing.deactivateLocal();
    expect(keychain.vault.size).toBe(0);

    held.release(jsonResponse(200, { token: "jwt_zombie", expiresAt: NOW + 10 * 60_000 }));
    await expect(inFlight).resolves.toEqual({ refreshed: false, reason: "superseded" });

    // The stale success must neither resurrect the JWT nor re-arm the loop.
    expect(keychain.vault.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not re-arm the retry timer when a network failure lands after deactivateLocal", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    const held = heldFetch();
    const inFlight = billing.refreshNow();
    billing.deactivateLocal();

    held.fail(new TypeError("fetch failed"));
    await expect(inFlight).resolves.toEqual({ refreshed: false, reason: "network" });

    // A retry here would refresh with a token the user already cleared.
    expect(vi.getTimerCount()).toBe(0);
    expect(keychain.vault.size).toBe(0);
  });

  it("lets a completed activation win over a Clear that raced it", async () => {
    const { billing, keychain } = makeBilling();
    const held = heldFetch();
    const inFlight = billing.activate(CODE);
    // Clear lands while the activate request is in flight. By the time the
    // response arrives the server has consumed the one-time code and minted
    // these credentials; discarding them would burn a paid code to honor a
    // click the user can simply repeat, so activation installs anyway (the
    // documented choice in the module).
    billing.deactivateLocal();

    held.release(
      jsonResponse(200, {
        refreshToken: "crt_new",
        token: "jwt_new",
        expiresAt: NOW + 10 * 60_000,
        devices: 1,
      })
    );
    await expect(inFlight).resolves.toEqual({ ok: true, devices: 1 });

    expect(keychain.vault.get(REFRESH_SLOT)).toBe("crt_new");
    expect(keychain.vault.get(HOSTED_SLOT)).toBe("jwt_new");
    // And its refresh loop is armed under the new epoch.
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("stop", () => {
  it("cancels the pending refresh and refuses to schedule new ones", async () => {
    const { billing, keychain } = makeBilling();
    seed(keychain);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: "jwt_new", expiresAt: NOW + 10 * 60_000 }));
    await billing.refreshNow();
    expect(vi.getTimerCount()).toBe(1);

    billing.stop();
    expect(vi.getTimerCount()).toBe(0);
    // App quit: even a full retry horizon later, nothing fires.
    await vi.advanceTimersByTimeAsync(MAX_REFRESH_DELAY_MS + RETRY_UNENTITLED_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
