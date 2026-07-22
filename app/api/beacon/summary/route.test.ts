// Route-level contract for the public summary endpoint (app/api/beacon/
// summary/route.ts). The old bearer-token gate is gone by decision: the
// endpoint serves aggregates that cannot identify anyone, so the properties
// worth pinning are the new ones: anonymous 200s, the CDN cache header that
// keeps the Upstash bill flat, and the per-IP limit on the cache-miss path.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_RATE_LIMIT_MAX } from "@/lib/beacon";
import { createMemoryBeaconStore, getBeaconStore, type BeaconStore } from "@/lib/beacon-store";
import { GET } from "./route";

// Same seam as the other route tests: the route resolves its store through
// this single factory, so the test controls which store it sees.
vi.mock("@/lib/beacon-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/beacon-store")>();
  return { ...actual, getBeaconStore: vi.fn() };
});

function world(): BeaconStore {
  const store = createMemoryBeaconStore();
  vi.mocked(getBeaconStore).mockReturnValue(store);
  return store;
}

function summaryRequest(ip?: string): Request {
  return new Request("http://localhost/api/beacon/summary", {
    headers: ip ? { "x-forwarded-for": ip } : undefined,
  });
}

beforeEach(() => {
  vi.mocked(getBeaconStore).mockReset();
});

describe("GET /api/beacon/summary", () => {
  it("serves the aggregate summary to anyone, no token anywhere", async () => {
    const store = world();
    await store.record({
      installId: "9b2f8c1e-4a3d-4f6b-8a1c-2d3e4f5a6b7c",
      event: "launch",
      appVersion: "0.2.0",
      macosVersion: "26.0",
    });
    const res = await GET(summaryRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backend).toBe("memory");
    expect(body.dau).toBe(1);
    expect(body.events.launch).toBe(1);
    expect(body.versions["0.2.0"]).toBe(1);
  });

  it("tells the CDN to absorb the traffic", async () => {
    world();
    const res = await GET(summaryRequest());
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600"
    );
  });

  it("rate-limits one IP without touching another, and without a cacheable 429", async () => {
    world();
    for (let i = 0; i < SUMMARY_RATE_LIMIT_MAX; i++) {
      expect((await GET(summaryRequest("203.0.113.7"))).status).toBe(200);
    }
    const limited = await GET(summaryRequest("203.0.113.7"));
    expect(limited.status).toBe(429);
    // A 429 must never be handed to the CDN as a fresh public copy.
    expect(limited.headers.get("cache-control")).toBeNull();
    expect((await GET(summaryRequest("203.0.113.8"))).status).toBe(200);
  });

  it("keeps summary reads out of the beacon POST budget (namespaced bucket)", async () => {
    const store = world();
    for (let i = 0; i <= SUMMARY_RATE_LIMIT_MAX; i++) {
      await GET(summaryRequest("203.0.113.7"));
    }
    // The POST route's bucket for the same IP is the bare truncated hash;
    // exhausting the summary budget must leave it untouched.
    const postBucket = createHash("sha256").update("203.0.113.7").digest("hex").slice(0, 16);
    expect(await store.allow(postBucket)).toBe(true);
  });

  it("fails open when the limiter backend hiccups", async () => {
    const store = world();
    store.allow = async () => {
      throw new Error("limiter down");
    };
    expect((await GET(summaryRequest())).status).toBe(200);
  });

  it("503s when the store read fails", async () => {
    const store = world();
    store.summary = async () => {
      throw new Error("redis down");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await GET(summaryRequest())).status).toBe(503);
    warn.mockRestore();
  });
});
