// In-memory RedisRunner (lib/upstash.ts contract) for the hosted-tier state.
// Two consumers: unit tests (with an injected clock) and local dev without
// Upstash credentials, mirroring how lib/vote-backend.ts falls back to the
// in-memory vote store so "npm run dev" needs zero paid services. Implements
// ONLY the commands the hosted gates and entitlement flow use, and throws on
// anything else so a new command cannot silently diverge from real Redis.
//
// Reply shapes match Upstash REST (what createRedisRunner returns): SET ->
// "OK" | null (failed NX), GET/GETDEL -> string | null, counters -> number,
// SADD/SREM/DEL/SISMEMBER/EXPIRE -> number.

import type { RedisRunner } from "../upstash";

interface Entry {
  value: string | Set<string>;
  /** Absolute ms timestamp, or null for no TTL. */
  expiresAt: number | null;
}

export interface MemoryRedis {
  run: RedisRunner;
  /** Test hook: everything gone, like FLUSHALL. */
  clear(): void;
}

export function createMemoryRedis(now: () => number = Date.now): MemoryRedis {
  const data = new Map<string, Entry>();

  function live(key: string): Entry | undefined {
    const entry = data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  }

  function str(entry: Entry | undefined): string | null {
    if (!entry) return null;
    if (entry.value instanceof Set) throw new Error("memory-redis: wrong type");
    return entry.value;
  }

  function setOf(key: string): Set<string> {
    const entry = live(key);
    if (!entry) {
      const fresh: Entry = { value: new Set(), expiresAt: null };
      data.set(key, fresh);
      return fresh.value as Set<string>;
    }
    if (!(entry.value instanceof Set)) throw new Error("memory-redis: wrong type");
    return entry.value;
  }

  const run: RedisRunner = async (command) => {
    const [rawCmd, ...rawArgs] = command;
    const cmd = String(rawCmd).toUpperCase();
    const args = rawArgs.map(String);
    switch (cmd) {
      case "GET":
        return str(live(args[0]));
      case "GETDEL": {
        const value = str(live(args[0]));
        data.delete(args[0]);
        return value;
      }
      case "SET": {
        const [key, value, ...opts] = args;
        let nx = false;
        let expiresAt: number | null = null;
        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i].toUpperCase();
          if (opt === "NX") nx = true;
          else if (opt === "PX") expiresAt = now() + Number(opts[++i]);
          else if (opt === "EX") expiresAt = now() + Number(opts[++i]) * 1000;
          else throw new Error(`memory-redis: unsupported SET option ${opt}`);
        }
        if (nx && live(key)) return null;
        data.set(key, { value, expiresAt });
        return "OK";
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) {
          if (live(key)) removed++;
          data.delete(key);
        }
        return removed;
      }
      case "INCR":
      case "INCRBY": {
        const key = args[0];
        const by = cmd === "INCR" ? 1 : Number(args[1]);
        const current = Number(str(live(key)) ?? "0");
        const next = current + by;
        const entry = live(key);
        data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
        return next;
      }
      case "EXPIRE":
      case "PEXPIRE": {
        const entry = live(args[0]);
        if (!entry) return 0;
        const ms = cmd === "EXPIRE" ? Number(args[1]) * 1000 : Number(args[1]);
        entry.expiresAt = now() + ms;
        return 1;
      }
      case "SADD": {
        const members = setOf(args[0]);
        let added = 0;
        for (const member of args.slice(1)) {
          if (!members.has(member)) {
            members.add(member);
            added++;
          }
        }
        return added;
      }
      case "SREM": {
        const members = setOf(args[0]);
        let removed = 0;
        for (const member of args.slice(1)) {
          if (members.delete(member)) removed++;
        }
        return removed;
      }
      case "SCARD":
        return setOf(args[0]).size;
      case "SISMEMBER":
        return setOf(args[0]).has(args[1]) ? 1 : 0;
      case "SMEMBERS":
        return [...setOf(args[0])];
      default:
        throw new Error(`memory-redis: unsupported command ${cmd}`);
    }
  };

  return { run, clear: () => data.clear() };
}
