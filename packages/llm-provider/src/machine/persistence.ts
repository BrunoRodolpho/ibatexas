// Redis persistence for XState machine snapshots.
// Each WhatsApp/web session has its own machine instance.
// Snapshots are serialized to JSON and stored with 24h TTL.

import { getRedisClient, rk } from "@ibatexas/tools"

const MACHINE_TTL = Number.parseInt(process.env.MACHINE_SNAPSHOT_TTL || "86400", 10) // 24h

/**
 * Save the machine snapshot to Redis.
 * Called after each event batch is processed.
 */
export async function persistMachineState(
  sessionId: string,
  snapshot: unknown,
): Promise<void> {
  try {
    const redis = await getRedisClient()
    await redis.set(
      rk(`wa:machine:${sessionId}`),
      JSON.stringify(snapshot),
      { EX: MACHINE_TTL },
    )
  } catch (err) {
    // Non-critical: if Redis is down, the machine starts fresh next message
    console.error("[machine:persist]", (err as Error).message)
  }
}

/**
 * Load a previously saved machine snapshot from Redis.
 * Returns null if no snapshot exists (new session).
 */
export async function loadMachineState(
  sessionId: string,
): Promise<unknown | null> {
  try {
    const redis = await getRedisClient()
    const data = await redis.get(rk(`wa:machine:${sessionId}`))
    return data ? JSON.parse(data) : null
  } catch (err) {
    console.error("[machine:load]", (err as Error).message)
    return null
  }
}
