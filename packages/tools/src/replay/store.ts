// Deterministic replay store for debugging agent runs.
//
// Captures the full pipeline input/output for each agent execution.
// Stored in Redis with 24h TTL for post-mortem analysis.
// CLI: `ibx replay <traceId>` to re-run with stored inputs.

import { getRedisClient } from "../redis/client.js"
import { rk } from "../redis/key.js"

const REPLAY_TTL = Number.parseInt(process.env.REPLAY_TTL_SECONDS || "86400", 10) // 24h

export interface ReplayEntry {
  traceId: string
  sessionId: string
  timestamp: string
  input: {
    message: string
    stateValue: string
    channel: string
  }
  synthesizedPrompt: string
  toolCalls: Array<{
    name: string
    input: unknown
    output: unknown
    success: boolean
    durationMs: number
  }>
  llmOutput: string
  totalDurationMs: number
}

/**
 * Persist a replay entry to Redis.
 * Non-blocking, fire-and-forget.
 */
export async function persistReplayEntry(entry: ReplayEntry): Promise<void> {
  try {
    const redis = await getRedisClient()
    await redis.set(
      rk(`replay:${entry.traceId}`),
      JSON.stringify(entry),
      { EX: REPLAY_TTL },
    )
  } catch {
    // Replay is non-critical
  }
}

/**
 * Load a replay entry from Redis.
 */
export async function loadReplayEntry(traceId: string): Promise<ReplayEntry | null> {
  try {
    const redis = await getRedisClient()
    const data = await redis.get(rk(`replay:${traceId}`))
    return data ? (JSON.parse(data) as ReplayEntry) : null
  } catch {
    return null
  }
}

/**
 * List recent replay entries (last 50) for debugging.
 */
export async function listRecentReplays(sessionId?: string): Promise<string[]> {
  try {
    const redis = await getRedisClient()
    // Use SCAN to find replay keys (limited to 50 results)
    const pattern = rk(sessionId ? `replay:*` : `replay:*`)
    const keys: string[] = []
    let cursor = "0"
    do {
      const result = await redis.scan(Number(cursor), { MATCH: pattern, COUNT: 100 })
      cursor = String(result.cursor)
      keys.push(...result.keys)
    } while (cursor !== "0" && keys.length < 50)
    return keys.slice(0, 50).map((k) => k.replace(rk("replay:"), ""))
  } catch {
    return []
  }
}
