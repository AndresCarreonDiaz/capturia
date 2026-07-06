// Hosts the CopilotKit runtime inside Electron main on a loopback-only HTTP
// server. Two jobs:
//   1. The packaged desktop app is a static export (no Next server), so the
//      agent endpoint has to live somewhere; main owns it.
//   2. BYOK hardening: the renderer only NAMES a provider (x-capturia-provider)
//      and main reads that provider's key from the OS keychain itself, so the
//      plaintext key never enters a renderer process (the isolation preload.js
//      used to describe as "the M2 hardening").
//
// Access control, in order:
//   1. Binds 127.0.0.1 only.
//   2. Browser-origin allowlist (isAllowedRuntimeOrigin): the file:// renderer
//      (Origin: "null") plus, in dev, the local Next server. Preflights are
//      answered from the allowlist alone, because browsers strip custom
//      headers from preflights and the token cannot gate them.
//   3. A per-launch random bearer token (x-capturia-token) on every actual
//      request. It reaches the renderer over the preload bridge and is never
//      persisted; this is what stops other local processes and null-origin
//      iframes from spending the user's keys.
//
// Dependency-injected (keychain, isDev, env) and free of electron requires, so
// plain Node can start it for smoke tests (scripts/smoke-runtime-server.mjs).

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Must match the client's runtimeUrl path (app/studio/page.tsx) and the web
// route's basePath, so the desktop and web endpoints stay interchangeable.
const BASE_PATH = "/api/copilotkit";

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Minimal .env reader for dev parity: Next loads these for the web route,
// Electron main does not, so without this a dev run whose only key lives in
// .env.local would report "no API key". The OS environment always wins, and
// files load in Next's dev precedence (later names win via last-write-wins).
// Parsing follows dotenv where it matters here: optional `export` prefix,
// bare or single/double quoted values, trimmed, inline ` # comment` stripped
// from unquoted values; malformed lines are skipped.
function loadDevEnvFiles(root) {
  const out = {};
  for (const name of [".env", ".env.development", ".env.local", ".env.development.local"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      const quoted = /^(['"])(.*)\1$/.exec(value);
      if (quoted) value = quoted[2];
      else value = value.replace(/\s+#.*$/, "").trim();
      out[match[1]] = value;
    }
  }
  return out;
}

// Starts the runtime server. Returns { url, token, close } where url already
// includes BASE_PATH (it is the exact string the renderer uses as runtimeUrl).
async function startRuntimeServer({ keychain, isDev, env = process.env, host = "127.0.0.1", port = 0 }) {
  const {
    CopilotRuntime,
    InMemoryAgentRunner,
    BuiltInAgent,
    createCopilotRuntimeHandler,
  } = require("@copilotkit/runtime/v2");
  const { createCopilotNodeHandler } = require("@copilotkit/runtime/v2/node");
  // Compiled from lib/ by scripts/build-electron-libs.mjs (preelectron hook).
  const { SYSTEM_PROMPT } = require("./gen/system-prompt");
  const { isNoThinkingModel } = require("./gen/server-keys");
  const {
    resolveDesktopAgentSpec,
    desktopKeyError,
    isAllowedRuntimeOrigin,
  } = require("./gen/desktop-runtime");

  const effectiveEnv = isDev ? { ...loadDevEnvFiles(path.join(__dirname, "..")), ...env } : env;
  const token = crypto.randomBytes(32).toString("hex");

  // Same agent shape as the web route (see that file for the reasoning behind
  // maxSteps/temperature/thinkingBudget); only the key SOURCE differs.
  function buildAgent(model, apiKey) {
    return new BuiltInAgent({
      model,
      apiKey,
      prompt: SYSTEM_PROMPT,
      maxSteps: 1,
      temperature: 0,
      ...(isNoThinkingModel(model)
        ? { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } }
        : {}),
    });
  }

  // The provider header is client-supplied; keychain.getKey throws on unknown
  // providers (assertProvider), which for a hostile header should mean "no
  // stored key", not a 500.
  function storedKeyFor(provider) {
    if (!provider) return null;
    try {
      return keychain.getKey(provider);
    } catch {
      return null;
    }
  }

  const runtime = new CopilotRuntime({
    agents: ({ request }) => {
      const provider = request.headers.get("x-capturia-provider");
      const { model, apiKey } = resolveDesktopAgentSpec({
        provider,
        storedKey: storedKeyFor(provider),
        env: effectiveEnv,
      });
      return { default: buildAgent(model, apiKey) };
    },
    runner: new InMemoryAgentRunner(),
  });

  // single-route, like the web route: all methods POST to one endpoint and the
  // frontend's auto-detect falls back to single-route mode.
  const handler = createCopilotRuntimeHandler({
    runtime,
    basePath: BASE_PATH,
    mode: "single-route",
  });

  function corsHeaders(origin) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type, x-capturia-provider, x-capturia-token",
      "access-control-allow-methods": "POST, OPTIONS",
      vary: "origin",
    };
  }

  function withCors(response, cors) {
    if (!cors) return response;
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // The web route's guard contract, reproduced 1:1 (info passthrough,
  // capturia-keycheck probe, 503 on a guaranteed-missing key), wrapped in the
  // desktop-only origin + token gate.
  async function guardedFetch(request) {
    const origin = request.headers.get("origin"); // null when not a browser
    if (origin !== null && !isAllowedRuntimeOrigin(origin, Boolean(isDev))) {
      return new Response("forbidden", { status: 403 });
    }
    const cors = origin !== null ? corsHeaders(origin) : null;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors ?? {} });
    }
    if (!timingSafeEqualStr(request.headers.get("x-capturia-token") || "", token)) {
      return withCors(
        Response.json({ error: "Capturia: missing or invalid runtime token." }, { status: 401 }),
        cors
      );
    }

    let method;
    try {
      method = (await request.clone().json())?.method;
    } catch {
      method = undefined; // non-JSON body: let the runtime answer it
    }
    if (method !== "info") {
      const provider = request.headers.get("x-capturia-provider");
      const error = desktopKeyError({
        provider,
        storedKey: storedKeyFor(provider),
        env: effectiveEnv,
      });
      if (method === "capturia-keycheck") {
        return withCors(Response.json({ ok: !error, error: error ?? null }), cors);
      }
      if (error) return withCors(Response.json({ error }, { status: 503 }), cors);
    }
    return withCors(await handler(request), cors);
  }

  const listener = createCopilotNodeHandler(guardedFetch);
  const server = http.createServer((req, res) => {
    listener(req, res).catch((err) => {
      console.error("Capturia runtime server error:", err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Capturia runtime server error." }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const url = `http://${host}:${server.address().port}${BASE_PATH}`;
  return {
    url,
    token,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startRuntimeServer, BASE_PATH };
