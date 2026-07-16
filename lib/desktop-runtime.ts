// Decision logic for the desktop runtime server (electron/runtime-server.js):
// which model + key a request runs on, the missing-key fail-fast, and which
// browser origins may talk to the loopback server at all. Framework-free so
// it is unit-testable; Electron main consumes the CJS build in electron/gen/
// (scripts/build-electron-libs.mjs), never this file directly.
//
// Mirrors the agents factory in app/api/copilotkit/[[...slug]]/route.ts with
// ONE deliberate difference: on desktop the plaintext key never leaves the
// main process, so instead of trusting an x-capturia-key header the caller
// passes the key it read from the OS keychain for the renderer-named provider.
// Keep both in sync via lib/server-keys.ts, which owns every shared rule.

import {
  providerModelSpec,
  effectiveModelSpec,
  missingModelKeyError,
  canonicalProvider,
  envKeysForSpec,
} from "./server-keys";

// The hosted-tier pseudo-provider (M11, issue #10): the vault slot holds a
// Capturia access token instead of a vendor API key, and the runtime points
// the Gemini wire at Capturia's proxy with that token in the key slot. The
// proxy speaks the exact @ai-sdk/google shape (see lib/hosted/proxy.ts), so
// hosted mode is a baseURL + key swap, not a new client.
export const HOSTED_PROVIDER = "capturia-hosted";
const DEFAULT_HOSTED_BASE = "https://www.capturia.dev/api/hosted";
const DEFAULT_HOSTED_MODEL_ID = "gemini-2.5-flash-lite";

export interface HostedRoute {
  /** baseURL for createGoogleGenerativeAI: <hosted base>/v1beta. */
  baseUrl: string;
  /** Bare Gemini model id; the proxy enforces its own allowlist anyway. */
  modelId: string;
}

export interface DesktopAgentSpec {
  model: string;
  apiKey: string | undefined;
  /** Present only for the capturia-hosted provider. */
  hosted?: HostedRoute;
}

// CAPTURIA_HOSTED_URL overrides the proxy origin (dev: http://localhost:3000
// /api/hosted); CAPTURIA_HOSTED_MODEL picks among the proxy's allowed ids.
export function hostedRouteFromEnv(env: Record<string, string | undefined>): HostedRoute {
  const base = (env.CAPTURIA_HOSTED_URL || DEFAULT_HOSTED_BASE).replace(/\/+$/, "");
  return {
    baseUrl: `${base}/v1beta`,
    modelId: env.CAPTURIA_HOSTED_MODEL || DEFAULT_HOSTED_MODEL_ID,
  };
}

export interface DesktopKeyInput {
  // x-capturia-provider header value; client-supplied, so lookups must be
  // prototype-safe (providerModelSpec already is).
  provider: string | null;
  // The keychain's plaintext key for that provider, or null when absent.
  storedKey: string | null;
  env: Record<string, string | undefined>;
}

// Same contract as the web route: BYOK (a stored key for the renderer-named
// provider) wins, and CAPTURIA_MODEL is honored only while it stays on the
// user's provider so their key is never sent to a different provider. With no
// stored key the env fallback picks the model, and unlike the web route the
// key is resolved from the PASSED env for every mapped provider: on desktop
// the caller's env can include dev .env.local values that resolveModel's own
// process.env fallback would never see (Electron main does not load env
// files), so relying on that fallback would let the keycheck pass while every
// run fails. Unmapped specs (vertex, unknown) still return undefined for
// resolveModel to handle itself.
export function resolveDesktopAgentSpec({ provider, storedKey, env }: DesktopKeyInput): DesktopAgentSpec {
  // Hosted tier first: the stored value is the Capturia token (slice 1 keeps
  // the raw JWT in the vault; the refresh loop is the desktop entitlement
  // slice). The model string stays a google/<id> spec so shared logic like
  // isNoThinkingModel keeps working; runtime-server builds the actual
  // proxy-pointed model instance from `hosted`.
  if (provider === HOSTED_PROVIDER && storedKey) {
    const hosted = hostedRouteFromEnv(env);
    return { model: `google/${hosted.modelId}`, apiKey: storedKey, hosted };
  }
  if (provider && storedKey) {
    const fallback = providerModelSpec(provider);
    const override = env.CAPTURIA_MODEL;
    const model =
      override && canonicalProvider(override) === canonicalProvider(fallback)
        ? override
        : fallback;
    return { model, apiKey: storedKey };
  }
  const model = effectiveModelSpec(env);
  const apiKey = envKeysForSpec(model)
    ?.map((k) => env[k])
    .find(Boolean);
  return { model, apiKey };
}

// Missing-key fail-fast sharing the DECISION with the web route (via
// missingModelKeyError) but not the words: the web copy says "set X in
// .env.local", which is meaningless inside a packaged app where the fix is
// Settings. The hosted provider gets its own message: telling a Pro user to
// go set GOOGLE_API_KEY would be exactly the setup the hosted tier exists
// to remove.
export function desktopKeyError({ provider, storedKey, env }: DesktopKeyInput): string | null {
  const error = missingModelKeyError({ byokProvider: provider, byokKey: storedKey, env });
  if (!error) return null;
  // Only rewrite a REAL failure: with a usable env fallback the agents
  // factory would run anyway (hosted-without-token falls through to the env
  // spec), and blocking a run that would succeed forks keycheck from run.
  if (provider === HOSTED_PROVIDER && !storedKey) {
    return (
      "Capturia Pro is selected but no access token is stored. " +
      "Paste your token in Settings, or switch to a BYOK provider."
    );
  }
  return (
    "Capturia has no AI key yet. Open Settings (⌘,), pick Google Gemini, " +
    "and paste a free key from https://aistudio.google.com (about a minute), " +
    "or upgrade to Capturia Pro for hosted keys."
  );
}

// Browser origins allowed to call the loopback runtime. The packaged renderer
// loads from file://, which browsers serialize as the literal string "null";
// in dev the studio comes from the local Next server (any localhost port,
// matching electron/ipc-schemas.js isAllowedUrl). Everything else is rejected
// before the bearer-token check even runs. Note "null" also matches sandboxed
// iframes on arbitrary websites; the per-launch token is what stops those.
export function isAllowedRuntimeOrigin(origin: string, isDev: boolean): boolean {
  if (origin === "null") return true;
  if (!isDev) return false;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}
