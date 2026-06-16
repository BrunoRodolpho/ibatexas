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
//      `docs/security/NATS-AUTH-REQUIREMENTS.md`.
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

// NEW-P1-ENV: strict-yet-tolerant boolean env parser. Mirrors the
// shared helper at `@ibatexas/llm-provider/parse-bool-env.ts`; copied
// inline here because `@ibatexas/nats-client` cannot import from
// `@ibatexas/llm-provider` (llm-provider depends on nats-client).
function parseBoolEnv(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue
  const v = value.trim().toLowerCase()
  if (v.length === 0) return defaultValue
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true
  if (v === "false" || v === "0" || v === "no" || v === "off") return false
  return defaultValue
}

/**
 * Resolve TLS options from env. Returns `undefined` when no CA is
 * configured. Setting `NATS_TLS_REQUIRED=true` while no CA is provided
 * returns an empty `TlsOptions {}` — the client will fail-closed if the
 * server does not offer TLS.
 */
async function resolveTls(): Promise<TlsOptions | undefined> {
  const caPath = process.env.NATS_TLS_CA
  // NEW-P1-ENV: was `=== "true"` — accepted only the exact string and
  // silently fell through for "TRUE", "1", "yes". A security-critical
  // gate (transport encryption) MUST honour the canonical truthy lexicon.
  const required = parseBoolEnv(process.env.NATS_TLS_REQUIRED, false)
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

  // NEW-P0-X3 — fail-CLOSED in production.
  //
  // Pre-fix (W4 P0-12 added the code path but did not flip polarity):
  // when NODE_ENV=production AND no authenticator AND no TLS, this
  // function emitted a `console.error` and PROCEEDED with the connect.
  // Any process reaching the NATS port could:
  //   (a) subscribe to `ibatexas.audit.intent.decision.v1` → PII exfiltration
  //   (b) publish forged `payment.status_changed` → forged resume signals
  //   (c) publish forged `intent.defer.timeout` → forged LGPD anonymize
  // The console.error was a sentinel an operator could miss in a busy
  // deploy. The correct posture is to refuse to bring up the connection
  // until creds (or at minimum TLS) are provisioned.
  //
  // Post-fix: throw an Error. The process exits non-zero at boot; ops
  // sets NATS_CREDS_PATH / NATS_NKEY_SEED and re-deploys. The console.error
  // is preserved as a breadcrumb in stderr right before the throw.
  if (
    process.env.NODE_ENV === "production" &&
    authenticator === undefined &&
    tls === undefined
  ) {
    const securityMessage =
      "[nats][SECURITY] production requires NATS auth (NATS_CREDS_PATH or " +
      "NATS_NKEY_SEED) and/or TLS (NATS_TLS_CA + NATS_TLS_REQUIRED=true). " +
      "Without authentication any process reaching the NATS port can read " +
      "audit records and publish forged events. See " +
      "docs/security/NATS-AUTH-REQUIREMENTS.md."
    console.error(securityMessage)
    throw new Error(securityMessage)
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

// ── T3-10: dedicated (non-singleton) authenticated connections ─────────────
//
// The journey-test plane carries MULTIPLE NATS identities in one process: the
// app seed (NATS_NKEY_SEED — what getNatsConnection's singleton resolves)
// plus the SUBSCRIBE-ONLY capture seed and the publish-only trigger seed
// (IBX_TEST_NATS_CAPTURE_NKEY_SEED / IBX_TEST_NATS_TRIGGER_NKEY_SEED —
// server-side enforcement in infra/nats/nats-server.test-plane.conf). A
// process-wide singleton cannot serve two identities, so per-role consumers
// (the journeys NatsCapture; the T3-9 trigger publish helper) open a
// DEDICATED connection with EXPLICIT credentials.
//
// Deliberately explicit-only: this function NEVER falls back to the env vars
// getNatsConnection reads — a capture composed with missing capture creds
// must fail loudly rather than silently ride the publish-capable app
// credential. Callers wanting env-resolved auth use getNatsConnection().
// TLS resolution (NATS_TLS_CA / NATS_TLS_REQUIRED) is shared with the
// singleton path. Callers own the returned connection's lifecycle (close()).

export interface DedicatedNatsAuth {
  /** Path to a `.creds` file (JWT-bearer auth) — takes precedence. */
  credsPath?: string
  /** Raw nkey seed string ("SU..."). */
  nkeySeed?: string
}

export async function openDedicatedNatsConnection(auth: DedicatedNatsAuth): Promise<NatsConnection> {
  let authenticator: Authenticator
  if (auth.credsPath && auth.credsPath.length > 0) {
    authenticator = credsAuthenticator(await readFile(auth.credsPath))
  } else if (auth.nkeySeed && auth.nkeySeed.length > 0) {
    authenticator = nkeyAuthenticator(new TextEncoder().encode(auth.nkeySeed))
  } else {
    throw new Error(
      "[nats] openDedicatedNatsConnection requires explicit credentials " +
        "(credsPath or nkeySeed) — use getNatsConnection() for env-resolved auth",
    )
  }
  const natsUrl = process.env.NATS_URL || "nats://localhost:4222"
  const tls = await resolveTls()
  return connect({
    servers: [natsUrl],
    reconnect: true,
    maxReconnectAttempts: -1,
    authenticator,
    ...(tls ? { tls } : {}),
  })
}

// Critical events that require outbox durability.
// MUST stay in sync with CRITICAL_EVENTS in apps/api/src/jobs/outbox-retry.ts —
// which now DERIVES from this set (single source of truth). An event in the retry
// set but absent here is never persisted, so the retry job finds an empty list and
// silently loses it (the P0-PAY-4 regression: payment.status_changed was retried
// but not persisted; see the drift-guard test).
export const OUTBOX_EVENTS = new Set([
  "order.placed",
  "reservation.created",
  "order.status_changed",
  "order.refunded",
  "order.disputed",
  "order.canceled",
  "order.payment_failed",
  // P0-PAY-4: payment status changes drive order auto-confirm; a lost publish
  // strands a paid order in pending with no recovery.
  "payment.status_changed",
  // audit-2026-05-25 (I9): cross-DB LGPD scrub kickoff. The in-process
  // Prisma anonymize TX commits BEFORE this publish; if NATS is down,
  // the Medusa-side customer row keeps PII indefinitely (no
  // pending-tracking record gets written by the subscriber because the
  // subscriber never receives the event, so the retry job finds
  // nothing to retry). Outbox durability + outbox-retry job re-publish
  // on broker recovery closes the gap.
  "customer.anonymize.medusa.pending",
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
// LRANGE 0 N-1 head-read so paging and trimming stay consistent (P1-SCALE-OUTBOXMEM).
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
 * (+ Sentry) instead of dropping them in a bare console.error (P1-ERR-NATSLOOP).
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

// P2-MEM-NATSPENDING: bound the in-flight (pending) backlog per subscription so
// a burst of events while a handler is slow can't grow the iterator's internal
// queue without limit (unbounded memory). nats.js v2 exposes no public pending-
// limit *setter* (the `max` SubscriptionOption auto-unsubscribes after N msgs,
// which would tear down a fire-and-forget subscriber), so we enforce the bound
// at the application layer: when sub.getPending() exceeds the cap we drop the
// current message (Core NATS is already at-most-once / lossy — JetStream
// durability is deferred) and surface it via a warn log instead of buffering.
// Configurable (rule 3); <= 0 disables the bound (unbounded, prior behavior).
const NATS_MAX_PENDING_MSGS = Number.parseInt(process.env.NATS_MAX_PENDING_MSGS || "10000", 10)

/**
 * Subscribe to domain events.
 * Callback is invoked for each message.
 * Returns an object with unsubscribe() to stop listening.
 *
 * ── audit-2026-05-24 P2-4 — queue groups ──────────────────────────────────
 * Pass `options.queueGroup` so subscribers running in multiple replicas
 * load-balance the stream instead of every replica handling every message
 * (N-fold handler inflation). Names must be stable across deploys and
 * unique per subscriber file — distinct queue groups on the same subject
 * still fan out to each group, so independent consumers (e.g. defer-
 * resolver + payment-lifecycle on `payment.status_changed`) coexist.
 */
export interface SubscribeNatsEventOptions {
  queueGroup?: string
}

export async function subscribeNatsEvent(
  event: string,
  handler: (payload: Record<string, unknown>) => void | Promise<void>,
  options?: SubscribeNatsEventOptions,
): Promise<{ unsubscribe: () => void }> {
  const nats = await getNatsConnection()
  const subject = `ibatexas.${event}`

  const sub = options?.queueGroup
    ? nats.subscribe(subject, { queue: options.queueGroup })
    : nats.subscribe(subject)

  // Handle messages asynchronously
  ;(async () => {
    for await (const msg of sub) {
      // P2-MEM-NATSPENDING: shed load when the in-flight backlog exceeds the cap
      // so a burst against a slow handler can't grow the iterator queue without
      // bound. getPending() may be absent on test doubles — guard the call (and
      // keep this operand order: cap>0, then typeof, then call). Core NATS is
      // already at-most-once, so dropping is acceptable; surfaced via warn log.
      if (
        NATS_MAX_PENDING_MSGS > 0 &&
        typeof (sub as { getPending?: () => number }).getPending === "function" &&
        (sub as { getPending: () => number }).getPending() > NATS_MAX_PENDING_MSGS
      ) {
        console.warn(
          `[nats] Pending backlog over ${NATS_MAX_PENDING_MSGS} for ${event} — dropping message (backpressure)`,
        )
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
        // (P1-ERR-NATSLOOP). console.error is kept as a local breadcrumb.
        console.error(`Event handler failed for ${event}:`, (error as Error).message)
        if (_dlqHandler) {
          try {
            await _dlqHandler(event, payload ?? { _raw: safeDecode(msg.data) }, error)
          } catch (dlqErr) {
            // Never let DLQ failure kill the subscription loop.
            console.error(`DLQ handler failed for ${event}:`, (dlqErr as Error).message)
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

// JetStream stream provisioning (at-least-once migration, Phase 0). Additive —
// does not change delivery for the current Core NATS subscribers.
export {
  STREAM_DEFS,
  ensureStreams,
  streamForSubject,
  streamConfig,
  type StreamDef,
  type EnsureStreamsResult,
} from "./streams.js"

