// Generates the hosted-tier Ed25519 JWT keypair (M11, issue #10) and prints
// the two env lines to stdout. Nothing is written to disk and nothing must
// ever be committed: paste the private line into the signing deployment's
// secrets (Vercel env / .env.local) and the public line wherever the proxy
// verifies (same deployment today).
//
//   node scripts/hosted-gen-keys.mjs
//
// Encoding contract matches lib/hosted/jwt.ts (base64 PKCS8/SPKI DER); the
// jwt tests pin that a pair in this format round-trips sign -> verify.

import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");

console.log("# Capturia hosted-tier JWT keys. NEVER commit the private key.");
console.log(`CAPTURIA_JWT_PRIVATE_KEY=${priv}`);
console.log(`CAPTURIA_JWT_PUBLIC_KEY=${pub}`);
