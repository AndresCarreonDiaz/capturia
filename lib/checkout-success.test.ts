// Pins the checkout-success pickup logic (lib/checkout-success.ts): the
// redirect-param gate and the webhook-lag-tolerant, exactly-once code
// collection the landing overlay runs.

import { describe, expect, it } from "vitest";
import { collectActivationCode, parseCheckoutReturn } from "./checkout-success";

const RET = { sessionId: "cs_live_a1b2c3d4e5", pickup: "pickupnonce0123456789" };

describe("parseCheckoutReturn", () => {
  it("accepts exactly the shape the checkout endpoint builds", () => {
    expect(
      parseCheckoutReturn("?checkout=success&session_id=cs_live_a1b2c3d4e5&pickup=pickupnonce0123456789")
    ).toEqual(RET);
  });

  it("renders nothing for everyone else", () => {
    expect(parseCheckoutReturn("")).toBeNull();
    expect(parseCheckoutReturn("?checkout=cancelled")).toBeNull();
    expect(parseCheckoutReturn("?checkout=success&session_id=cs_live_a1b2c3d4e5")).toBeNull(); // no pickup
    expect(parseCheckoutReturn("?checkout=success&session_id=evil&pickup=pickupnonce0123456789")).toBeNull();
    expect(parseCheckoutReturn("?checkout=success&session_id=cs_live_a1b2c3d4e5&pickup=short")).toBeNull();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchScript(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("fetch script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const instant = () => Promise.resolve();

describe("collectActivationCode", () => {
  it("returns the code on first success and stops immediately", async () => {
    const { fetchImpl, calls } = fetchScript([jsonResponse(200, { code: "CAPTURIA-AB12-CD34-EF56-GH78" })]);
    const out = await collectActivationCode(RET, { fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "ok", code: "CAPTURIA-AB12-CD34-EF56-GH78" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("session_id=cs_live_a1b2c3d4e5");
    expect(calls[0]).toContain("pickup=pickupnonce0123456789");
  });

  it("rides out webhook lag: early 404s retry until the code lands", async () => {
    const { fetchImpl } = fetchScript([
      jsonResponse(404, { error: "nope" }),
      jsonResponse(404, { error: "nope" }),
      jsonResponse(200, { code: "CAPTURIA-AB12-CD34-EF56-GH78" }),
    ]);
    const out = await collectActivationCode(RET, { fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "ok", code: "CAPTURIA-AB12-CD34-EF56-GH78" });
  });

  it("reports pending when every attempt 404s (webhook never landed in time)", async () => {
    const { fetchImpl, calls } = fetchScript(
      Array.from({ length: 4 }, () => jsonResponse(404, { error: "not minted yet" }))
    );
    const out = await collectActivationCode(RET, { attempts: 4, fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "pending" });
    expect(calls).toHaveLength(4);
  });

  it("reports gone and stops polling the moment the endpoint says 410", async () => {
    const { fetchImpl, calls } = fetchScript([
      jsonResponse(404, { error: "not minted yet" }),
      jsonResponse(410, { error: "already collected" }),
    ]);
    const out = await collectActivationCode(RET, { attempts: 6, fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "gone" });
    expect(calls).toHaveLength(2);
  });

  it("aborts before the next request once shouldAbort flips, leaving the code collectable", async () => {
    let aborted = false;
    const { fetchImpl, calls } = fetchScript([jsonResponse(404, { error: "not minted yet" })]);
    const out = await collectActivationCode(RET, {
      attempts: 6,
      fetchImpl,
      sleep: async () => {
        aborted = true; // the user dismissed the overlay between attempts
      },
      shouldAbort: () => aborted,
    });
    expect(out).toEqual({ status: "aborted" });
    expect(calls).toHaveLength(1);
  });

  it("never fetches at all when the overlay is already dismissed", async () => {
    const { fetchImpl, calls } = fetchScript([]);
    const out = await collectActivationCode(RET, {
      fetchImpl,
      sleep: instant,
      shouldAbort: () => true,
    });
    expect(out).toEqual({ status: "aborted" });
    expect(calls).toHaveLength(0);
  });

  it("reports error, not gone, when the server misbehaved along the way", async () => {
    const { fetchImpl } = fetchScript([
      jsonResponse(500, { error: "boom" }),
      jsonResponse(404, { error: "nope" }),
    ]);
    const out = await collectActivationCode(RET, { attempts: 2, fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "error" });
  });

  it("treats 429 as webhook-lag shaped: honors retry-after and keeps polling", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = fetchScript([
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "7" },
      }),
      jsonResponse(200, { code: "CAPTURIA-AB12-CD34-EF56-GH78" }),
    ]);
    const out = await collectActivationCode(RET, {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(out).toEqual({ status: "ok", code: "CAPTURIA-AB12-CD34-EF56-GH78" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(7000); // the server's retry-after, not just the base cadence
  });

  it("reports pending, not error, when the run was all rate-limiting", async () => {
    const { fetchImpl } = fetchScript(
      Array.from({ length: 3 }, () => jsonResponse(429, { error: "slow down" }))
    );
    const out = await collectActivationCode(RET, { attempts: 3, fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "pending" });
  });

  it("recovers a 200 whose body was lost: the grace-window re-collect wins next attempt", async () => {
    const { fetchImpl } = fetchScript([
      new Response("not json at all", { status: 200 }),
      jsonResponse(200, { code: "CAPTURIA-AB12-CD34-EF56-GH78" }),
    ]);
    const out = await collectActivationCode(RET, { fetchImpl, sleep: instant });
    expect(out).toEqual({ status: "ok", code: "CAPTURIA-AB12-CD34-EF56-GH78" });
  });

  it("survives network blips between attempts", async () => {
    const { fetchImpl } = fetchScript([
      new Error("offline"),
      jsonResponse(200, { code: "CAPTURIA-AB12-CD34-EF56-GH78" }),
    ]);
    const out = await collectActivationCode(RET, { fetchImpl, sleep: instant });
    expect(out).toMatchObject({ status: "ok" });
  });
});
