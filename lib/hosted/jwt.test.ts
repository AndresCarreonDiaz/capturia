// Pins the hosted-tier JWT crypto (lib/hosted/jwt.ts): a real Ed25519
// sign/verify roundtrip, the env-encoding contract the setup script prints,
// and the rejection paths that make algorithm confusion and token tampering
// structurally impossible.

import { describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync, sign as rawEdSign } from "node:crypto";
import {
  generateJwtKeyPair,
  jwtPrivateKeyFromEnv,
  jwtPublicKeyFromEnv,
  signHostedJwt,
  verifyHostedJwt,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_TTL_SECONDS,
} from "./jwt";

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

function keys() {
  const pair = generateJwtKeyPair();
  const privateKey = jwtPrivateKeyFromEnv({ CAPTURIA_JWT_PRIVATE_KEY: pair.privateKey })!;
  const publicKey = jwtPublicKeyFromEnv({ CAPTURIA_JWT_PUBLIC_KEY: pair.publicKey })!;
  return { pair, privateKey, publicKey };
}

function mint(overrides: Partial<Parameters<typeof signHostedJwt>[0]> = {}) {
  const { privateKey, publicKey } = keys();
  const signed = signHostedJwt({
    customer: "cus_123",
    device: "device-abc",
    plan: "pro",
    privateKey,
    nowMs: NOW,
    ...overrides,
  });
  return { ...signed, publicKey, privateKey };
}

describe("key material", () => {
  it("round-trips the generator's base64 DER encoding through the env loaders", () => {
    const { token } = mint();
    expect(token.split(".")).toHaveLength(3);
  });

  it("returns null (not throw) when env vars are absent", () => {
    expect(jwtPrivateKeyFromEnv({})).toBeNull();
    expect(jwtPublicKeyFromEnv({})).toBeNull();
  });

  it("accepts PEM material too", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const priv = jwtPrivateKeyFromEnv({ CAPTURIA_JWT_PRIVATE_KEY: privPem })!;
    const pub = jwtPublicKeyFromEnv({ CAPTURIA_JWT_PUBLIC_KEY: pubPem })!;
    const { token } = signHostedJwt({
      customer: "cus_pem",
      device: "d-123456",
      plan: "pro",
      privateKey: priv,
      nowMs: NOW,
    });
    const verdict = verifyHostedJwt(token, pub, NOW);
    expect(verdict.ok).toBe(true);
  });

  it("throws loudly on malformed key material instead of disabling auth", () => {
    expect(() => jwtPublicKeyFromEnv({ CAPTURIA_JWT_PUBLIC_KEY: "not-a-key" })).toThrow();
  });
});

describe("sign -> verify roundtrip", () => {
  it("verifies a fresh token and returns the claims", () => {
    const { token, publicKey, expiresAt } = mint();
    const verdict = verifyHostedJwt(token, publicKey, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.sub).toBe("cus_123");
      expect(verdict.claims.device).toBe("device-abc");
      expect(verdict.claims.plan).toBe("pro");
      expect(verdict.claims.iss).toBe(JWT_ISSUER);
      expect(verdict.claims.aud).toBe(JWT_AUDIENCE);
    }
    expect(expiresAt).toBe(NOW + JWT_TTL_SECONDS * 1000);
  });

  it("rejects a token verified against the wrong public key", () => {
    const { token } = mint();
    const other = keys().publicKey;
    const verdict = verifyHostedJwt(token, other, NOW);
    expect(verdict).toEqual({ ok: false, error: "invalid token signature" });
  });

  it("rejects an expired token but tolerates small clock skew", () => {
    const { token, publicKey } = mint({ ttlSeconds: 60 });
    expect(verifyHostedJwt(token, publicKey, NOW + 90_000).ok).toBe(true); // within skew
    const late = verifyHostedJwt(token, publicKey, NOW + 200_000);
    expect(late).toEqual({ ok: false, error: "token expired" });
  });

  it("rejects a token issued in the future beyond skew", () => {
    const { token, publicKey } = mint({ nowMs: NOW + 10 * 60_000 });
    const verdict = verifyHostedJwt(token, publicKey, NOW);
    expect(verdict).toEqual({ ok: false, error: "token not yet valid" });
  });
});

describe("tamper resistance", () => {
  it("rejects a payload swap (signature no longer covers the body)", () => {
    const { token, publicKey } = mint();
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        sub: "cus_attacker",
        device: "d-123456",
        plan: "pro",
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        iat: Math.floor(NOW / 1000),
        exp: Math.floor(NOW / 1000) + 3600,
      })
    ).toString("base64url");
    const verdict = verifyHostedJwt(`${header}.${forgedPayload}.${signature}`, publicKey, NOW);
    expect(verdict.ok).toBe(false);
  });

  it('rejects alg "none"', () => {
    const { publicKey } = mint();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "cus_x",
        device: "d-123456",
        plan: "pro",
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        iat: Math.floor(NOW / 1000),
        exp: Math.floor(NOW / 1000) + 3600,
      })
    ).toString("base64url");
    const verdict = verifyHostedJwt(`${header}.${payload}.`, publicKey, NOW);
    expect(verdict).toEqual({ ok: false, error: "unsupported token algorithm" });
  });

  it("rejects an HS256 downgrade signed with the public key bytes", () => {
    const { pair, publicKey } = keys();
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "cus_x",
        device: "d-123456",
        plan: "pro",
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
        iat: Math.floor(NOW / 1000),
        exp: Math.floor(NOW / 1000) + 3600,
      })
    ).toString("base64url");
    const mac = createHmac("sha256", Buffer.from(pair.publicKey, "base64"))
      .update(`${header}.${payload}`)
      .digest("base64url");
    const verdict = verifyHostedJwt(`${header}.${payload}.${mac}`, publicKey, NOW);
    expect(verdict).toEqual({ ok: false, error: "unsupported token algorithm" });
  });

  it("rejects wrong issuer/audience even when correctly signed", () => {
    const { privateKey, publicKey } = keys();
    // Sign a claims set for a hypothetical other Capturia service by
    // hand-building segments with the real signer's key.
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "cus_x",
        device: "d-123456",
        plan: "pro",
        iss: "someone-else",
        aud: JWT_AUDIENCE,
        iat: Math.floor(NOW / 1000),
        exp: Math.floor(NOW / 1000) + 3600,
      })
    ).toString("base64url");
    const sig = rawEdSign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const verdict = verifyHostedJwt(`${header}.${payload}.${sig}`, publicKey, NOW);
    expect(verdict).toEqual({ ok: false, error: "token issued for a different service" });
  });

  it("rejects garbage shapes without throwing", () => {
    const { publicKey } = mint();
    for (const bad of [null, undefined, "", "a.b", "a.b.c.d", "!!.!!.!!", "x".repeat(5000)]) {
      const verdict = verifyHostedJwt(bad as string | null | undefined, publicKey, NOW);
      expect(verdict.ok).toBe(false);
    }
  });

  it("rejects claims missing required fields", () => {
    const { privateKey, publicKey } = keys();
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: JWT_ISSUER, aud: JWT_AUDIENCE, exp: Math.floor(NOW / 1000) + 3600 })
    ).toString("base64url");
    const sig = rawEdSign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const verdict = verifyHostedJwt(`${header}.${payload}.${sig}`, publicKey, NOW);
    expect(verdict).toEqual({ ok: false, error: "missing or malformed token" });
  });
});
