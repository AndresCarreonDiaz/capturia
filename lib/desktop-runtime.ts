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

export interface DesktopAgentSpec {
  model: string;
  apiKey: string | undefined;
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

// Missing-key fail-fast with the same message source as the web route, so the
// studio banner wording never forks between web and desktop.
export function desktopKeyError({ provider, storedKey, env }: DesktopKeyInput): string | null {
  return missingModelKeyError({ byokProvider: provider, byokKey: storedKey, env });
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
