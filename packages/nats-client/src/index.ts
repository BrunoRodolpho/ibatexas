// @ibatexas/nats-client
// NATS Core pub/sub wrapper for domain events.
// NOTE: Uses Core NATS (fire-and-forget), not JetStream.
// JetStream (with persistence/durability) is deferred to Step 14 (Observability).
// TODO: Full JetStream migration needed for production reliability

import { connect, type NatsConnection } from "nats"
import { natsLog } from "./logger.js"

export { setNatsLogger } from "./logger.js"
export type { StructuredLogger } from "./logger.js"

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
                natsLog().warn({ event: "nats_disconnect" }, "Disconnected from server")
                break
              case "reconnect":
                natsLog().info({ event: "nats_reconnect" }, "Reconnected to server")
                break
              case "error":
                natsLog().error({ event: "nats_error", err: status.data }, "Connection error")
                break
              case "reconnecting":
                natsLog().info({ event: "nats_reconnecting" }, "Reconnecting")
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

// Critical events that require outbox durability.
// MUST stay in sync with CRITICAL_EVENTS in apps/api/src/jobs/outbox-retry.ts —
// an event in the retry set but absent here is never persisted, so the retry job
// finds an empty list and silently loses it (see the drift-guard test).
export const OUTBOX_EVENTS = new Set([
  "order.placed",
  "reservation.created",
  "order.status_changed",
  "order.refunded",
  "order.disputed",
  "order.canceled",
  "order.payment_failed",
  "payment.status_changed",
])

// Optional Redis outbox writer (injected by apps/api at startup)
let _outboxWriter: OutboxWriter | null = null

export interface OutboxWriter {
  lPush(key: string, value: string): Promise<unknown>
  lRem(key: string, count: number, value: string): Promise<unknown>
  // Optional: bounds the outbox list so an unreachable NATS server can't grow it
  // without limit (P1-SCALE-OUTBOXMEM). node-redis exposes lTrim; injecting it is
  // backward-compatible (older writers simply skip the guard).
  lTrim?(key: string, start: number, stop: number): Promise<unknown>
}

// Hard cap on outbox list length per critical event. lPush prepends (newest at
// index 0), so we keep the newest OUTBOX_MAX_LEN entries. Matches the retry job's
// LRANGE 0 N-1 head-read so paging and trimming stay consistent.
const OUTBOX_MAX_LEN = Number.parseInt(process.env.OUTBOX_MAX_LEN || "5000", 10)

/**
 * Inject a Redis client for outbox writes. Called once at API startup.
 * The writer must support lpush() and lRem() (node-redis client).
 */
export function setOutboxWriter(writer: OutboxWriter): void {
  _outboxWriter = writer
}

// Optional DLQ handler (injected by apps/api at startup).
// nats-client lives in packages/ and cannot import apps/api's pushToDlq or
// @sentry/node directly (package → app reverse dependency + dep boundary), so
// the app injects its existing DLQ mechanism here. Mirrors setOutboxWriter.
export type DlqHandler = (event: string, payload: Record<string, unknown>, error: unknown) => void | Promise<void>

let _dlqHandler: DlqHandler | null = null

/**
 * Inject a dead-letter-queue handler. Called once at API startup.
 * Used by subscribeNatsEvent() to route unhandled subscriber errors to the DLQ
 * (+ Sentry) instead of dropping them in a bare console.error.
 */
export function setDlqHandler(handler: DlqHandler): void {
  _dlqHandler = handler
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
      const key = outboxKey(envPrefix, event)
      await _outboxWriter.lPush(key, data)
      // Bound the list so a prolonged NATS outage can't grow it unbounded.
      // Keep the newest OUTBOX_MAX_LEN entries (index 0 = newest after lPush).
      if (_outboxWriter.lTrim && OUTBOX_MAX_LEN > 0) {
        await _outboxWriter.lTrim(key, 0, OUTBOX_MAX_LEN - 1)
      }
    } catch (outboxErr) {
      natsLog().error(
        { event: "outbox_write_failed", natsEvent: event, err: (outboxErr as Error).message },
        "Outbox write failed",
      )
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
        natsLog().error(
          { event: "outbox_remove_failed", natsEvent: event, err: (removeErr as Error).message },
          "Outbox remove failed",
        )
        // Non-fatal: outbox-retry job will re-publish (idempotent on subscriber side)
      }
    }
  } catch (error) {
    natsLog().error(
      { event: "publish_failed", natsEvent: event, err: (error as Error).message },
      "Failed to publish event",
    )
    // Non-critical; don't throw (event publishing is async)
    // If NATS publish fails, event stays in outbox for retry
  }
}

// Stable queue group for the subscriber worker pool. With N API replicas, a
// queue group makes NATS deliver each message to exactly ONE replica instead of
// fanning out to all N (the P1-CONC-QUEUEGROUP duplicate-processing bug).
// Queue groups are scoped per-subject, so a single shared group is correct: each
// distinct subject is independently load-balanced across the pool.
// Overridable via NATS_QUEUE_GROUP for multi-pool deployments.
const DEFAULT_QUEUE_GROUP = process.env.NATS_QUEUE_GROUP || "ibatexas-workers"

// P2-MEM-NATSPENDING: bound the in-flight (pending) backlog per subscription so
// a burst of events while a handler is slow can't grow the iterator's internal
// queue without limit (unbounded memory). nats.js v2 exposes no public pending-
// limit *setter* (the `max` SubscriptionOption auto-unsubscribes after N msgs,
// which would tear down a fire-and-forget subscriber), so we enforce the bound
// at the application layer: when sub.getPending() exceeds the cap we drop the
// current message (Core NATS is already at-most-once / lossy — JetStream
// durability is deferred) and surface it via the DLQ/log instead of buffering.
// Configurable (rule 3); <= 0 disables the bound (unbounded, prior behavior).
const NATS_MAX_PENDING_MSGS = Number.parseInt(process.env.NATS_MAX_PENDING_MSGS || "10000", 10)

/**
 * Subscribe to domain events.
 * Callback is invoked for each message.
 * Returns an object with unsubscribe() to stop listening.
 *
 * @param event   short-form event name (e.g. "order.placed")
 * @param handler message handler
 * @param options.queue queue group for load-balancing across replicas.
 *   Defaults to DEFAULT_QUEUE_GROUP so every subscriber is deduplicated across
 *   replicas without per-call-site changes. Pass a distinct group only to opt a
 *   subscriber into its own independent pool.
 */
export async function subscribeNatsEvent(
  event: string,
  handler: (payload: Record<string, unknown>) => void | Promise<void>,
  options?: { queue?: string }
): Promise<{ unsubscribe: () => void }> {
  const nats = await getNatsConnection()
  const subject = `ibatexas.${event}`
  const queue = options?.queue ?? DEFAULT_QUEUE_GROUP

  const sub = nats.subscribe(subject, { queue })

  // Handle messages asynchronously
  ;(async () => {
    for await (const msg of sub) {
      // P2-MEM-NATSPENDING: shed load when the in-flight backlog exceeds the cap
      // so a burst against a slow handler can't grow the iterator queue without
      // bound. getPending() is only meaningful for the iterator path (which this
      // is) and may be absent on test doubles — guard the call. Dropped messages
      // go to the DLQ (best-effort, fire-and-forget loss is acceptable here).
      if (
        NATS_MAX_PENDING_MSGS > 0 &&
        typeof sub.getPending === "function" &&
        sub.getPending() > NATS_MAX_PENDING_MSGS
      ) {
        natsLog().warn(
          { event: "pending_backlog_drop", natsEvent: event, maxPending: NATS_MAX_PENDING_MSGS },
          "Pending backlog over limit — dropping message (backpressure)",
        )
        if (_dlqHandler) {
          try {
            await _dlqHandler(
              event,
              { _raw: safeDecode(msg.data), _dropped: "nats-pending-overflow" },
              new Error(`NATS pending backlog exceeded ${NATS_MAX_PENDING_MSGS}`),
            )
          } catch (dlqErr) {
            natsLog().error(
              { event: "dlq_handler_failed", natsEvent: event, cause: "backpressure_drop", err: (dlqErr as Error).message },
              "DLQ handler failed (backpressure drop)",
            )
          }
        }
        continue
      }

      let payload: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(new TextDecoder().decode(msg.data)) as Record<string, unknown>
        payload = parsed
        await handler(parsed)
      } catch (error) {
        // Anything escaping the subscriber's own try/catch reaches here. Route
        // it through the injected DLQ (+ Sentry) instead of dropping silently
        // (P1-ERR-NATSLOOP); the structured log line is the local breadcrumb.
        natsLog().error(
          { event: "handler_failed", natsEvent: event, err: (error as Error).message },
          "Event handler failed",
        )
        if (_dlqHandler) {
          try {
            await _dlqHandler(event, payload ?? { _raw: safeDecode(msg.data) }, error)
          } catch (dlqErr) {
            // Never let DLQ failure kill the subscription loop.
            natsLog().error(
              { event: "dlq_handler_failed", natsEvent: event, err: (dlqErr as Error).message },
              "DLQ handler failed",
            )
          }
        }
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

/** Best-effort decode of raw message bytes for DLQ when JSON.parse failed. */
function safeDecode(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data)
  } catch {
    return "<undecodable>"
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

