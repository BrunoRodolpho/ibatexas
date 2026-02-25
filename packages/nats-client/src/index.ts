// @ibatexas/nats-client
// NATS Core pub/sub wrapper for domain events.
// NOTE: Uses Core NATS (fire-and-forget), not JetStream.
// JetStream (with persistence/durability) is deferred to Step 14 (Observability).

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
    return natsConn
  } catch (error) {
    // Reset so the next call can retry
    pendingConnection = null
    throw error
  } finally {
    pendingConnection = null
  }
}

/**
 * Publish domain event to NATS.
 * Subject format: ibatexas.{domain}.{action}
 * E.g., ibatexas.product.indexed
 */
export async function publishNatsEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const nats = await getNatsConnection()
    const subject = `ibatexas.${event}`
    const data = JSON.stringify(payload)

    nats.publish(subject, new TextEncoder().encode(data))
  } catch (error) {
    console.error(`Failed to publish event ${event}:`, error)
    // Non-critical; don't throw (event publishing is async)
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
        console.error(`Event handler failed for ${event}:`, error)
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
 * Graceful shutdown: close connection and cleanup.
 */
export async function closeNatsConnection(): Promise<void> {
  if (natsConn) {
    await natsConn.close()
    natsConn = null
    pendingConnection = null
  }
}

