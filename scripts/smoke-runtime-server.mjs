// Smoke test for electron/runtime-server.js under plain Node (no Electron):
// starts the server with a stub keychain and drives the auth + protocol
// surface end to end over real HTTP. Exercises exactly what a renderer does
// short of running a model: preflight, origin gate, token gate, the
// {method:"info"} passthrough, and the capturia-keycheck probe.
//
//   node scripts/smoke-runtime-server.mjs
//
// Exits 0 when every check passes. Compiles electron/gen/ first so it is
// self-contained.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(root, "scripts", "build-electron-libs.mjs")], {
  stdio: "inherit",
});

const require = createRequire(import.meta.url);
const { startRuntimeServer } = require(join(root, "electron", "runtime-server.js"));

// A vault with a gemini key stored, like a real desktop after onboarding.
const stubKeychain = {
  getKey(provider) {
    if (!["gemini", "claude", "openai"].includes(provider)) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return provider === "gemini" ? "smoke-stored-key" : null;
  },
};

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const server = await startRuntimeServer({
  keychain: stubKeychain,
  isDev: false,
  env: {}, // no env keys: the env-fallback path must fail keycheck
});

const post = (body, headers = {}) =>
  fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const tokenHeader = { "x-capturia-token": server.token };

try {
  check("returns loopback url + token", /^http:\/\/127\.0\.0\.1:\d+\/api\/copilotkit$/.test(server.url) && server.token.length === 64, server.url);

  let r = await post({ method: "capturia-keycheck" });
  check("no token -> 401", r.status === 401, `status ${r.status}`);

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, origin: "https://evil.example" });
  check("disallowed origin -> 403 even with token", r.status === 403, `status ${r.status}`);

  r = await fetch(server.url, {
    method: "OPTIONS",
    headers: { origin: "null", "access-control-request-method": "POST" },
  });
  check(
    "preflight from file:// renderer -> 204 + CORS",
    r.status === 204 && r.headers.get("access-control-allow-origin") === "null",
    `status ${r.status}`
  );

  r = await post({ method: "info" }, tokenHeader);
  check("info handshake passes the key guard", r.status === 200, `status ${r.status}`);

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "gemini", origin: "null" });
  let body = await r.json();
  check("keycheck ok with a stored key (BYOK)", r.status === 200 && body.ok === true, JSON.stringify(body));
  check("CORS reflected on actual response", r.headers.get("access-control-allow-origin") === "null");

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "claude" });
  body = await r.json();
  check("keycheck fails without stored or env key", body.ok === false && typeof body.error === "string", String(body.error).slice(0, 60));

  r = await post({ method: "capturia-keycheck" }, { ...tokenHeader, "x-capturia-provider": "not-a-provider" });
  body = await r.json();
  check("hostile provider header -> no throw, keycheck answers", r.status === 200 && body.ok === false);

  r = await post({ method: "agent/run" }, tokenHeader);
  check("model-running method without any key -> 503 fail-fast", r.status === 503, `status ${r.status}`);
} finally {
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll runtime-server smoke checks passed.");
