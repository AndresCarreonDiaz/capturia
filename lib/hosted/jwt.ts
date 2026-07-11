// Capturia-signed Ed25519 JWTs for the hosted tier (M11, issue #10). The
// billing endpoints mint short-lived tokens after a refresh-token exchange;
// the LLM proxy verifies them statelessly (no store hit) before any Redis
// gate runs. Real node:crypto Ed25519, no JWT library: the format is three
// base64url segments and one signature, and owning the verifier means the
// alg-confusion class of bugs ("alg":"none", HMAC downgrade) is structurally
// impossible because only EdDSA over the pinned key is ever accepted.
//
// Key material contract (docs/hosted-tier.md): CAPTURIA_JWT_PRIVATE_KEY is a
// base64 PKCS8 DER Ed25519 private key, CAPTURIA_JWT_PUBLIC_KEY a base64 SPKI
// DER public key. PEM is also accepted (detected by the BEGIN header) so
// operators can paste whichever form their secret store already holds.
// scripts/hosted-gen-keys.mjs prints a matching pair; keys are NEVER
// committed and this module never logs token or key material.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

export const JWT_ISSUER = "capturia";
export const JWT_AUDIENCE = "capturia-hosted";
// Short-lived by design: entitlement revocation propagates on the next
// refresh, and the proxy re-checks the Redis entitlement record per call
// anyway (defense in depth; the JWT alone never grants stale access for
// longer than this).
export const JWT_TTL_SECONDS = 60 * 60;
// Tolerated clock skew between the minting function and the verifying one.
const CLOCK_SKEW_SECONDS = 60;

export interface HostedClaims {
  /** Stripe customer id; doubles as the per-user key for every Redis gate. */
  sub: string;
  /** Registered device id the refresh token is bound to. */
  device: string;
  plan: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

// Fresh keypair in the env encoding above. Used by scripts/hosted-gen-keys.mjs
// (which inlines the same three lines to stay plain .mjs) and by tests to
// prove the env loaders round-trip what the generator emits.
export function generateJwtKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function keyFromMaterial(material: string, kind: "private" | "public"): KeyObject {
  const trimmed = material.trim();
  if (trimmed.includes("-----BEGIN")) {
    return kind === "private" ? createPrivateKey(trimmed) : createPublicKey(trimmed);
  }
  const der = Buffer.from(trimmed, "base64");
  return kind === "private"
    ? createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    : createPublicKey({ key: der, format: "der", type: "spki" });
}

type Env = Record<string, string | undefined>;

// null (not throw) when unset: routes turn that into a 503 "hosted tier not
// configured" instead of a stack trace, and the free BYOK paths never read
// these at all. Malformed material still throws loudly; a misconfigured
// secret must not silently disable auth.
export function jwtPrivateKeyFromEnv(env: Env = process.env): KeyObject | null {
  const material = env.CAPTURIA_JWT_PRIVATE_KEY;
  return material ? keyFromMaterial(material, "private") : null;
}

export function jwtPublicKeyFromEnv(env: Env = process.env): KeyObject | null {
  const material = env.CAPTURIA_JWT_PUBLIC_KEY;
  return material ? keyFromMaterial(material, "public") : null;
}

export interface SignInput {
  customer: string;
  device: string;
  plan: string;
  privateKey: KeyObject;
  ttlSeconds?: number;
  nowMs?: number;
}

export function signHostedJwt({
  customer,
  device,
  plan,
  privateKey,
  ttlSeconds = JWT_TTL_SECONDS,
  nowMs = Date.now(),
}: SignInput): { token: string; expiresAt: number } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const claims: HostedClaims = {
    sub: customer,
    device,
    plan,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    iat,
    exp,
  };
  const header = b64url(Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  // Ed25519 hashes internally; node:crypto wants algorithm null for it.
  const signature = edSign(null, Buffer.from(signingInput), privateKey);
  return { token: `${signingInput}.${b64url(signature)}`, expiresAt: exp * 1000 };
}

export type VerifyResult =
  | { ok: true; claims: HostedClaims }
  | { ok: false; error: string };

// Every rejection returns a generic reason string safe to send to the caller;
// nothing derived from the token body is ever echoed back or logged.
export function verifyHostedJwt(
  token: string | null | undefined,
  publicKey: KeyObject,
  nowMs = Date.now()
): VerifyResult {
  if (!token || typeof token !== "string" || token.length > 4096) {
    return { ok: false, error: "missing or malformed token" };
  }
  const segments = token.split(".");
  if (segments.length !== 3) return { ok: false, error: "missing or malformed token" };
  const [headerSeg, payloadSeg, signatureSeg] = segments;

  let header: unknown;
  try {
    header = decodeSegment(headerSeg);
  } catch {
    return { ok: false, error: "missing or malformed token" };
  }
  // Pin the algorithm to exactly EdDSA. "none", HS256 and friends are not
  // negotiable inputs here; the verifier owns the algorithm, not the token.
  const h = header as { alg?: unknown; typ?: unknown };
  if (!h || h.alg !== "EdDSA" || (h.typ !== undefined && h.typ !== "JWT")) {
    return { ok: false, error: "unsupported token algorithm" };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureSeg, "base64url");
  } catch {
    return { ok: false, error: "missing or malformed token" };
  }
  const valid = edVerify(
    null,
    Buffer.from(`${headerSeg}.${payloadSeg}`),
    publicKey,
    signature
  );
  if (!valid) return { ok: false, error: "invalid token signature" };

  let payload: unknown;
  try {
    payload = decodeSegment(payloadSeg);
  } catch {
    return { ok: false, error: "missing or malformed token" };
  }
  const c = payload as Partial<HostedClaims>;
  if (
    !c ||
    typeof c.sub !== "string" ||
    !c.sub ||
    typeof c.device !== "string" ||
    typeof c.plan !== "string" ||
    typeof c.iat !== "number" ||
    typeof c.exp !== "number"
  ) {
    return { ok: false, error: "missing or malformed token" };
  }
  if (c.iss !== JWT_ISSUER || c.aud !== JWT_AUDIENCE) {
    return { ok: false, error: "token issued for a different service" };
  }
  const nowSec = nowMs / 1000;
  if (c.exp <= nowSec - CLOCK_SKEW_SECONDS) {
    return { ok: false, error: "token expired" };
  }
  if (c.iat > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, error: "token not yet valid" };
  }
  return { ok: true, claims: c as HostedClaims };
}
