// @ibatexas/nats-client
// NATS Core pub/sub wrapper for domain events.
// NOTE: Uses Core NATS (fire-and-forget), not JetStream.
// JetStream (with persistence/durability) is deferred to Step 14 (Observability).
// TODO: Full JetStream migration needed for production reliability

import { connect, type NatsConnection } from "nats"

let natsConn: NatsConnection | null = null
let pendingConnection: Promise<NatsConnection> | null = null

/**
 * Get or create NATS connection.
 * Singleton pattern with pending-promise guard to prevent race conditions
 * when multiple callers request the connection concurrently.
 */
export async function getNatsConnection(): Promise<NatsConnection> {
  if (natsConn) {
    return natsConn
  }

  // Guard: if a connection attempt is already in flight, wait for it
  if (pendingConnection) {
    return pendingConnection
  }

  const natsUrl = process.env.NATS_URL || "nats://localhost:4222"

  pendingConnection = connect({
    servers: [natsUrl],
    reconnect: true,
    maxReconnectAttempts: -1, // Infinite retries
  })

  try {
    natsConn = await pendingConnection

    // Observability: log connection lifecycle events (guard for test mocks)
    const conn = natsConn
    if (conn && typeof conn.status === "function") {
      ;(async () => {
        try {
          for await (const status of conn.status()) {
            switch (status.type) {
              case "disconnect":
                console.warn("[nats] Disconnected from server")
                break
              case "reconnect":
                console.info("[nats] Reconnected to server")
                break
              case "error":
                console.error("[nats] Connection error:", status.data)
                break
              case "reconnecting":
                console.info("[nats] Reconnecting...")
                break
            }
          }
        } catch {
          // Connection closed or status iterator ended — expected during shutdown
        }
      })()
    }

    return natsConn
  } catch (error) {
    // Reset so the next call can retry
    pendingConnection = null
    throw error
  }
  // No finally block: resetting pendingConnection on success would race with concurrent
  // callers during cold start. The catch block handles the error case; on success
  // pendingConnection is harmless (natsConn check succeeds first).
}

// Critical events that require outbox durability
const OUTBOX_EVENTS = new Set([
  "order.placed",
  "reservation.created",
  "order.status_changed",
  "order.refunded",
  "order.disputed",
  "order.canceled",
  "order.payment_failed",
])

// Optional Redis outbox writer (injected by apps/api at startup)
let _outboxWriter: OutboxWriter | null = null

export interface OutboxWriter {
  lPush(key: string, value: string): Promise<unknown>
  lRem(key: string, count: number, value: string): Promise<unknown>
}

/**
 * Inject a Redis client for outbox writes. Called once at API startup.
 * The writer must support lpush() and lRem() (node-redis client).
 */
export function setOutboxWriter(writer: OutboxWriter): void {
  _outboxWriter = writer
}

/**
 * Get the configured outbox key prefix.
 * Uses rk-compatible format: {env}:outbox:{eventName}
 */
export function outboxKey(envPrefix: string, eventName: string): string {
  return `${envPrefix}:outbox:${eventName}`
}

/**
 * Publish domain event to NATS.
 * Subject format: ibatexas.{domain}.{action}
 * E.g., ibatexas.product.indexed
 *
 * For critical events (order.placed, reservation.created), writes to Redis outbox
 * before NATS publish and removes after success.
 */
export async function publishNatsEvent<T extends Record<string, unknown> = Record<string, unknown>>(event: string, payload: T): Promise<void> {
  const data = JSON.stringify(payload)
  const isCritical = OUTBOX_EVENTS.has(event)
  const envPrefix = process.env.APP_ENV ?? "development"

  // Write to outbox BEFORE NATS publish for critical events
  if (isCritical && _outboxWriter) {
    try {
      await _outboxWriter.lPush(outboxKey(envPrefix, event), data)
    } catch (outboxErr) {
      console.error(`[nats] Outbox write failed for ${event}:`, (outboxErr as Error).message)
      // Continue with NATS publish even if outbox write fails
    }
  }

  try {
    const nats = await getNatsConnection()
    const subject = `ibatexas.${event}`

    nats.publish(subject, new TextEncoder().encode(data))

    // Remove from outbox after successful NATS publish
    if (isCritical && _outboxWriter) {
      try {
        await _outboxWriter.lRem(outboxKey(envPrefix, event), 1, data)
      } catch (removeErr) {
        console.error(`[nats] Outbox remove failed for ${event}:`, (removeErr as Error).message)
        // Non-fatal: outbox-retry job will re-publish (idempotent on subscriber side)
      }
    }
  } catch (error) {
    console.error(`Failed to publish event ${event}:`, (error as Error).message)
    // Non-critical; don't throw (event publishing is async)
    // If NATS publish fails, event stays in outbox for retry
  }
}

/**
 * Subscribe to domain events.
 * Callback is invoked for each message.
 * Returns an object with unsubscribe() to stop listening.
 */
export async function subscribeNatsEvent(
  event: string,
  handler: (payload: Record<string, unknown>) => void | Promise<void>
): Promise<{ unsubscribe: () => void }> {
  const nats = await getNatsConnection()
  const subject = `ibatexas.${event}`

  const sub = nats.subscribe(subject)

  // Handle messages asynchronously
  ;(async () => {
    for await (const msg of sub) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(msg.data))
        await handler(payload)
      } catch (error) {
        console.error(`Event handler failed for ${event}:`, (error as Error).message)
      }
    }
  })()

  // Return a handle to unsubscribe from this event
  return {
    unsubscribe: () => {
      sub.unsubscribe()
    },
  }
}

/**
 * Graceful shutdown: drain pending messages and close connection.
 */
// Use drain() instead of close() to flush pending publishes before closing
export async function closeNatsConnection(): Promise<void> {
  if (natsConn) {
    await natsConn.drain()
    natsConn = null
    pendingConnection = null
  }
}

