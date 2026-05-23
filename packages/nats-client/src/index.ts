// @ibatexas/nats-client
// NATS Core pub/sub wrapper for domain events.
// NOTE: Uses Core NATS (fire-and-forget), not JetStream.
// JetStream (with persistence/durability) is deferred to Step 14 (Observability).
// TODO: Full JetStream migration needed for production reliability
//
// ── W4 P0-12: NATS authentication ────────────────────────────────────────
//
// Pre-W4 the client called `connect()` with no creds / nkey / TLS. Any
// process reaching the NATS port could (a) subscribe to
// `ibatexas.audit.intent.decision.v1` → PII exfiltration, (b) publish
// forged `payment.status_changed` → forged resume signals, (c) publish
// forged `intent.defer.timeout` → forged LGPD anonymize triggers
// (audit 05 §N1/N2).
//
// The fix is two-part:
//   1. CODE (this file) — accept auth credentials and TLS config from
//      env vars. `connect()` picks up the configured authenticator and
//      TLS root cert at call time. NO authentication is wired by default
//      (back-compat for dev / shadow). PRODUCTION REQUIRES the operator
//      to provision creds + flip env vars.
//   2. OPERATOR — provision NATS server credentials, rotate, flip env
//      vars on staging/prod. See
//      `docs/adjudicate-migration/remediation/NATS-AUTH-REQUIREMENTS.md`.
//
// Env vars consumed by this module:
//   - NATS_URL              : connect target (defaults to localhost)
//   - NATS_NKEY_SEED        : nkey seed (raw seed, e.g. "SUAB...")
//   - NATS_CREDS_PATH       : path to a `.creds` file (JWT-bearer auth)
//   - NATS_TLS_CA           : path to TLS CA root cert for the server
//   - NATS_TLS_REQUIRED     : "true" → require TLS (fail-closed if the
//                              server does not offer TLS)
//
// Production warning: if NODE_ENV=production AND the resolved options
// contain no authenticator AND no TLS, we emit a console.error warning
// at connect time. This is a sentinel — operators MUST set creds before
// flipping enforce.

import {
  connect,
  credsAuthenticator,
  nkeyAuthenticator,
  type Authenticator,
  type ConnectionOptions,
  type NatsConnection,
  type TlsOptions,
} from "nats"
import { readFile } from "node:fs/promises"

let natsConn: NatsConnection | null = null
let pendingConnection: Promise<NatsConnection> | null = null

/**
 * Resolve NATS authenticator from env. Returns `undefined` when no
 * credentials are configured (the default for dev / shadow runs).
 *
 * Precedence (first match wins):
 *   - NATS_CREDS_PATH  — JWT-bearer auth via .creds file
 *   - NATS_NKEY_SEED   — nkey seed (string)
 */
async function resolveAuthenticator(): Promise<Authenticator | undefined> {
  const credsPath = process.env.NATS_CREDS_PATH
  if (credsPath && credsPath.length > 0) {
    const buf = await readFile(credsPath)
    return credsAuthenticator(buf)
  }
  const nkeySeed = process.env.NATS_NKEY_SEED
  if (nkeySeed && nkeySeed.length > 0) {
    // nkeyAuthenticator accepts Uint8Array of the seed bytes.
    return nkeyAuthenticator(new TextEncoder().encode(nkeySeed))
  }
  return undefined
}

/**
 * Resolve TLS options from env. Returns `undefined` when no CA is
 * configured. Setting `NATS_TLS_REQUIRED=true` while no CA is provided
 * returns an empty `TlsOptions {}` — the client will fail-closed if the
 * server does not offer TLS.
 */
async function resolveTls(): Promise<TlsOptions | undefined> {
  const caPath = process.env.NATS_TLS_CA
  const required = process.env.NATS_TLS_REQUIRED === "true"
  if (caPath && caPath.length > 0) {
    const ca = await readFile(caPath, "utf8")
    return { ca }
  }
  if (required) {
    return {} // empty TlsOptions = require TLS, accept defaults
  }
  return undefined
}

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
  const authenticator = await resolveAuthenticator()
  const tls = await resolveTls()

  // P0-12: emit a loud warning when production starts without auth.
  // This does NOT block the connect — flipping the auth on is an
  // operator step. See docs/adjudicate-migration/remediation/
  // NATS-AUTH-REQUIREMENTS.md for the runbook.
  if (
    process.env.NODE_ENV === "production" &&
    authenticator === undefined &&
    tls === undefined
  ) {
    console.error(
      "[nats][SECURITY] NATS connection has no authentication and no TLS in " +
        "production. Any process reaching the NATS port can read audit " +
        "records and publish forged events. Provision credentials and set " +
        "NATS_CREDS_PATH or NATS_NKEY_SEED, plus NATS_TLS_CA + " +
        "NATS_TLS_REQUIRED=true. See docs/adjudicate-migration/remediation/" +
        "NATS-AUTH-REQUIREMENTS.md.",
    )
  }

  const opts: ConnectionOptions = {
    servers: [natsUrl],
    reconnect: true,
    maxReconnectAttempts: -1, // Infinite retries
    ...(authenticator ? { authenticator } : {}),
    ...(tls ? { tls } : {}),
  }

  pendingConnection = connect(opts)

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

