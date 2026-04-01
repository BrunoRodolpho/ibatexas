// Redis persistence for XState machine snapshots.
// Each session has its own machine instance.
// Snapshots are wrapped with version + timestamp for lifecycle management.

import { createHash } from "node:crypto"
import { getRedisClient, rk } from "@ibatexas/tools"
import { createDefaultContext } from "./types.js"

const MACHINE_TTL = Number.parseInt(process.env.MACHINE_SNAPSHOT_TTL || "86400", 10) // 24h

// Increment when the machine schema changes between deploys
export const SNAPSHOT_VERSION = 1

// Idle threshold — discard snapshots older than this
const IDLE_THRESHOLD_MS = Number.parseInt(process.env.SESSION_IDLE_THRESHOLD_MS || "1800000", 10) // 30min

// Absolute max session age
const MAX_SESSION_AGE_MS = Number.parseInt(process.env.MAX_SESSION_AGE_MS || "14400000", 10) // 4h

interface SnapshotWrapper {
  version: number
  checksum: string
  persistedAt: string // ISO
  createdAt: string   // ISO — set on first persist, carried forward
  snapshot: unknown
}

function computeChecksum(snapshot: unknown): string {
  const ctx = (snapshot as { context?: unknown })?.context
  return createHash("sha256").update(JSON.stringify(ctx ?? {})).digest("hex").slice(0, 16)
}

/**
 * Save the machine snapshot to Redis with version + checksum wrapper.
 * If existingCreatedAt is not provided, auto-loads the createdAt from the
 * existing Redis entry so the absolute session age is preserved across persists.
 */
export async function persistMachineState(
  sessionId: string,
  snapshot: unknown,
  existingCreatedAt?: string,
): Promise<void> {
  async function attempt(): Promise<void> {
    const redis = await getRedisClient()

    // Carry forward createdAt from existing snapshot if not provided
    let createdAt = existingCreatedAt
    if (!createdAt) {
      const existing = await redis.get(rk(`wa:machine:${sessionId}`))
      if (existing) {
        try {
          const parsed = JSON.parse(existing) as { createdAt?: string }
          createdAt = parsed.createdAt
        } catch { /* ignore */ }
      }
    }

    const wrapper: SnapshotWrapper = {
      version: SNAPSHOT_VERSION,
      checksum: computeChecksum(snapshot),
      persistedAt: new Date().toISOString(),
      createdAt: createdAt ?? new Date().toISOString(),
      snapshot,
    }
    await redis.set(
      rk(`wa:machine:${sessionId}`),
      JSON.stringify(wrapper),
      { EX: MACHINE_TTL },
    )
  }

  try {
    await attempt()
  } catch (err) {
    console.error("[machine:persist] First attempt failed, retrying:", (err as Error).message)
    // Single retry — if this also fails, re-throw so callers can handle it
    await attempt()
  }
}

export interface LoadResult {
  snapshot: unknown
  createdAt: string
  isStale: boolean
  staleReason?: "idle" | "expired" | "version_mismatch" | "checksum_mismatch"
}

/**
 * Load a previously saved machine snapshot from Redis.
 * Validates version, checksum, and staleness.
 * Returns null if no snapshot exists or validation fails critically.
 */
export async function loadMachineState(
  sessionId: string,
): Promise<LoadResult | null> {
  try {
    const redis = await getRedisClient()
    const data = await redis.get(rk(`wa:machine:${sessionId}`))
    if (!data) return null

    const parsed = JSON.parse(data) as Record<string, unknown>

    // Legacy format (no wrapper) — treat as stale
    if (!("version" in parsed)) {
      console.info("[machine:load] Legacy snapshot without version — discarding")
      return null
    }

    const wrapper = parsed as unknown as SnapshotWrapper

    // Merge loaded context with default context to fill missing fields
    // (handles schema evolution where new fields are added between deploys)
    const snap = wrapper.snapshot as Record<string, unknown> | null
    if (snap && typeof snap === "object" && "context" in snap) {
      const loadedCtx = snap.context as Record<string, unknown>
      const channel = (loadedCtx.channel as "whatsapp" | "web") ?? "whatsapp"
      const customerId = (loadedCtx.customerId as string | null) ?? null
      const defaults = createDefaultContext(channel, customerId)
      snap.context = { ...defaults, ...loadedCtx }
    }

    // Version mismatch — schema changed between deploys
    if (wrapper.version !== SNAPSHOT_VERSION) {
      console.info("[machine:load] Version mismatch (got %d, want %d) — discarding", wrapper.version, SNAPSHOT_VERSION)
      return { snapshot: wrapper.snapshot, createdAt: wrapper.createdAt, isStale: true, staleReason: "version_mismatch" }
    }

    // Checksum validation
    const expectedChecksum = computeChecksum(wrapper.snapshot)
    if (wrapper.checksum !== expectedChecksum) {
      console.warn("[machine:load] Checksum mismatch — possible corruption")
      return { snapshot: wrapper.snapshot, createdAt: wrapper.createdAt, isStale: true, staleReason: "checksum_mismatch" }
    }

    const now = Date.now()
    const persistedAt = new Date(wrapper.persistedAt).getTime()
    const createdAt = new Date(wrapper.createdAt).getTime()

    // Idle expiry — no activity for 30min
    if (now - persistedAt > IDLE_THRESHOLD_MS) {
      return { snapshot: wrapper.snapshot, createdAt: wrapper.createdAt, isStale: true, staleReason: "idle" }
    }

    // Absolute expiry — session older than 4h
    if (now - createdAt > MAX_SESSION_AGE_MS) {
      return { snapshot: wrapper.snapshot, createdAt: wrapper.createdAt, isStale: true, staleReason: "expired" }
    }

    return { snapshot: wrapper.snapshot, createdAt: wrapper.createdAt, isStale: false }
  } catch (err) {
    console.error("[machine:load]", (err as Error).message)
    return null
  }
}
