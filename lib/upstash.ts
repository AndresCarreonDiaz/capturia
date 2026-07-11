// Minimal Upstash Redis REST client. Deliberately fetch-based with zero
// dependencies: the vote store needs a handful of commands and two EVALs,
// not a client library. Works anywhere fetch exists (Next route handlers).

export interface UpstashConfig {
  url: string;
  token: string;
}

// Vercel's Upstash marketplace integration exports UPSTASH_REDIS_REST_*;
// the older Vercel KV flavor exports KV_REST_API_*. Accept both so "click
// the integration" is the only setup step.
// Typed as a plain string map instead of NodeJS.ProcessEnv: Next augments
// ProcessEnv with a required NODE_ENV that this helper never reads, and
// demanding it would force tests to fabricate a full env object.
export function upstashFromEnv(env: Record<string, string | undefined> = process.env): UpstashConfig | null {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

// Runs one Redis command (["HGET", "key", "field"]) over the REST API and
// returns its raw result. Upstash returns { result } on success and
// { error } on failure; both non-2xx and error bodies throw.
export type RedisRunner = (command: (string | number)[]) => Promise<unknown>;

// Runs several commands in one HTTP round trip via Upstash's /pipeline
// endpoint (same command-count billing, one network hop). Results come back
// positionally; any per-command error throws, since the callers (the beacon
// store) treat a partial write as a failure worth logging.
export type RedisPipeline = (commands: (string | number)[][]) => Promise<unknown[]>;

export function createRedisPipeline(cfg: UpstashConfig): RedisPipeline {
  return async (commands) => {
    const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as
      | { result?: unknown; error?: string }[]
      | null;
    if (!res.ok || !Array.isArray(body)) {
      throw new Error(`upstash pipeline: HTTP ${res.status}`);
    }
    return body.map((entry) => {
      if (entry && typeof entry.error === "string") {
        throw new Error(`upstash: ${entry.error}`);
      }
      return entry?.result;
    });
  };
}

export function createRedisRunner(cfg: UpstashConfig): RedisRunner {
  return async (command) => {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command.map(String)),
      // Route handlers must never serve a cached tally.
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as
      | { result?: unknown; error?: string }
      | null;
    if (!res.ok || !body || typeof body.error === "string") {
      throw new Error(`upstash: ${body?.error || `HTTP ${res.status}`}`);
    }
    return body.result;
  };
}
