// Atomic rate limiter — INCR + conditional EXPIRE in a single Lua eval.
// Prevents the race where a process crashes between INCR and EXPIRE,
// leaving an immortal key that blocks the bucket forever.

import type { createClient } from "redis";

type RedisClientType = ReturnType<typeof createClient>;

const ATOMIC_INCR_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

/**
 * Atomically increment a counter key and set its TTL on first access.
 *
 * Unlike separate INCR + EXPIRE, this guarantees the TTL is always set:
 * if the process crashes between INCR and EXPIRE, the key would persist
 * forever, permanently rate-limiting that bucket.
 */
export async function atomicIncr(
  redis: RedisClientType,
  key: string,
  ttlSeconds: number,
): Promise<number> {
  const result = await (redis as unknown as {
    eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  }).eval(ATOMIC_INCR_SCRIPT, {
    keys: [key],
    arguments: [String(ttlSeconds)],
  });
  return Number(result);
}
