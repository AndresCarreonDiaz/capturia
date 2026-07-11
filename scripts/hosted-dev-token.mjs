// Mints a short-lived Capturia hosted-tier JWT for local verification (M11):
// the curl-side counterpart of the /api/billing/token endpoint, useful before
// any Stripe flow exists. Requires CAPTURIA_JWT_PRIVATE_KEY in the env:
//
//   node --env-file=.env.local scripts/hosted-dev-token.mjs [customer] [ttlSeconds]
//
// Defaults: customer "cus_dev" (pair with CAPTURIA_HOSTED_DEV_ENTITLEMENT=
// cus_dev on the dev server so the entitlement gate passes), ttl 3600.
// Claim and signature format must match lib/hosted/jwt.ts exactly; the live
// end-to-end check in docs/hosted-tier.md is what pins this script against
// the verifier.

import { createPrivateKey, sign } from "node:crypto";

const material = process.env.CAPTURIA_JWT_PRIVATE_KEY;
if (!material) {
  console.error("CAPTURIA_JWT_PRIVATE_KEY is not set. Run scripts/hosted-gen-keys.mjs first.");
  process.exit(1);
}

const customer = process.argv[2] || "cus_dev";
const ttl = Number(process.argv[3]) || 3600;
const privateKey = material.includes("-----BEGIN")
  ? createPrivateKey(material)
  : createPrivateKey({ key: Buffer.from(material, "base64"), format: "der", type: "pkcs8" });

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const iat = Math.floor(Date.now() / 1000);
const signingInput = `${b64url({ alg: "EdDSA", typ: "JWT" })}.${b64url({
  sub: customer,
  device: "dev-machine",
  plan: "pro",
  iss: "capturia",
  aud: "capturia-hosted",
  iat,
  exp: iat + ttl,
})}`;
const signature = sign(null, Buffer.from(signingInput), privateKey).toString("base64url");

console.log(`${signingInput}.${signature}`);
