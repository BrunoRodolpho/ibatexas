// oracle/projection-barrier.ts — deterministic projection barrier (T1a-6).
//
// `awaitProjection` polls `OrderProjection` (and its `OrderEventLog` rows)
// until the expected projection state lands. Discipline:
//
//   - NEVER blind-sleeps: every wait is a poll → check → bounded-backoff
//     cycle under a hard deadline, and the result carries `elapsedMs` +
//     `polls` so the harness can emit them on trace events.
//   - Tolerates LGPD-anonymized event payloads: `anonymizeCustomer`
//     (packages/domain `customer.service.ts`, surface 5 + the heavy-path
//     pre-scrub) full-replaces `OrderEventLog.payload` IN PLACE with
//     `{ anonymized: true }`. Identity columns (orderId / eventType /
//     idempotencyKey) survive the scrub — the matching helpers here key
//     on those only and never read payload PII fields.
//   - On timeout throws the named `ProjectionBarrierTimeoutError` carrying
//     the last-seen state (projection version + event types) for flake
//     diagnosis.
//
// The prisma parameter is a STRUCTURAL subset of the @ibatexas/domain
// PrismaClient (field names pinned to packages/domain/prisma/schema.prisma)
// so unit tests inject a plain double; the real client satisfies it.
// Containment (read-only role) is connection-level — wired by T1a-9.

import { setTimeout as sleep } from "node:timers/promises"

// ── Row shapes (structural subset of the domain Prisma models) ───────────────

/** `order_projections` row — `id` is the Medusa order id; `version` bumps on every projector write. */
export interface OrderProjectionRow {
  id: string
  version: number
  [field: string]: unknown
}

/** `order_event_log` row — append-only; `payload` may be LGPD-scrubbed to `{ anonymized: true }`. */
export interface OrderEventLogRow {
  id: string
  orderId: string
  eventType: string
  idempotencyKey: string
  payload: unknown
  [field: string]: unknown
}

/** Structural Prisma subset the barrier needs (real PrismaClient satisfies it). */
export interface ProjectionBarrierPrisma {
  orderProjection: {
    findFirst(args: { where: Record<string, unknown> }): Promise<OrderProjectionRow | null>
  }
  orderEventLog: {
    findMany(args: {
      where: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
    }): Promise<OrderEventLogRow[]>
  }
}

// ── Barrier state + condition contracts ──────────────────────────────────────

/** One poll's snapshot — also what the timeout error carries as `lastSeen`. */
export interface ProjectionBarrierState {
  projection: OrderProjectionRow | null
  /** The order's event-log rows (createdAt asc). Empty until the order id is resolvable. */
  events: OrderEventLogRow[]
}

export type ProjectionPredicate = (state: ProjectionBarrierState) => boolean

export interface AwaitProjectionOptions {
  prisma: ProjectionBarrierPrisma
  /** Target by order id (preferred — also drives the event-log lookup). */
  orderId?: string
  /** Raw `OrderProjection` where-clause when the order id is not known yet (e.g. `{ displayId: 42 }`). */
  filter?: Record<string, unknown>
  /** Satisfied when the projection exists with `version > sinceVersion` (a bump landed). */
  sinceVersion?: number
  /** Satisfied when the predicate returns true (sees projection + events). ANDed with `sinceVersion` when both given. */
  predicate?: ProjectionPredicate
  /** Hard deadline in ms (default 15000). A final poll always runs at the deadline — no blind tail sleep. */
  timeoutMs?: number
  /** Initial poll interval in ms (default 100); backs off ×1.5 per poll. */
  pollMs?: number
  /** Backoff cap in ms (default 1000). */
  maxPollMs?: number
}

export interface AwaitProjectionResult {
  projection: OrderProjectionRow | null
  events: OrderEventLogRow[]
  /** Wall-clock spent inside the barrier — feed into `evidence.*`/trace events. */
  elapsedMs: number
  /** Polls performed (≥ 1 — the barrier never resolves or times out without polling). */
  polls: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_POLL_MS = 100
const DEFAULT_MAX_POLL_MS = 1_000
const BACKOFF_FACTOR = 1.5

// ── LGPD-tolerant event matching ─────────────────────────────────────────────

/**
 * True when the payload is the LGPD full-replace scrub shape
 * (`{ anonymized: true }` — see packages/domain anonymizeCustomer, surface 5).
 */
export function isAnonymizedEventPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).anonymized === true
  )
}

/** Identity-column event matcher — deliberately CANNOT express payload fields. */
export interface EventMatch {
  eventType: string
  orderId?: string
  idempotencyKey?: string
}

/** Filter events on identity columns only — anonymized payloads still match. */
export function findEvents(
  events: readonly OrderEventLogRow[],
  match: EventMatch,
): OrderEventLogRow[] {
  return events.filter(
    (event) =>
      event.eventType === match.eventType &&
      (match.orderId === undefined || event.orderId === match.orderId) &&
      (match.idempotencyKey === undefined || event.idempotencyKey === match.idempotencyKey),
  )
}

export function hasEvent(events: readonly OrderEventLogRow[], match: EventMatch): boolean {
  return findEvents(events, match).length > 0
}

/** Predicate factory: satisfied once a matching event-log row is visible. */
export function eventSeen(match: EventMatch): ProjectionPredicate {
  return (state) => hasEvent(state.events, match)
}

// ── Timeout error (flake diagnosis) ──────────────────────────────────────────

export class ProjectionBarrierTimeoutError extends Error {
  readonly lastSeen: ProjectionBarrierState | null
  readonly elapsedMs: number
  readonly polls: number

  constructor(args: {
    target: string
    condition: string
    lastSeen: ProjectionBarrierState | null
    elapsedMs: number
    polls: number
  }) {
    const projection = args.lastSeen?.projection ?? null
    const events = args.lastSeen?.events ?? []
    const seenProjection =
      projection === null ? "projection=absent" : `projection.version=${projection.version}`
    const seenTypes = [...new Set(events.map((event) => event.eventType))].join(", ")
    super(
      `projection_barrier_timeout: ${args.condition} on ${args.target} not reached after ` +
        `${args.elapsedMs}ms (${args.polls} polls); last seen: ${seenProjection}, ` +
        `${events.length} event(s)${seenTypes.length > 0 ? ` [${seenTypes}]` : ""}`,
    )
    this.name = "ProjectionBarrierTimeoutError"
    this.lastSeen = args.lastSeen
    this.elapsedMs = args.elapsedMs
    this.polls = args.polls
  }
}

// ── awaitProjection ──────────────────────────────────────────────────────────

function describeCondition(opts: AwaitProjectionOptions): string {
  const parts: string[] = []
  if (opts.sinceVersion !== undefined) parts.push(`version>${opts.sinceVersion}`)
  if (opts.predicate !== undefined) parts.push("predicate")
  return parts.join(" AND ")
}

function isSatisfied(state: ProjectionBarrierState, opts: AwaitProjectionOptions): boolean {
  if (opts.sinceVersion !== undefined) {
    if (state.projection === null || state.projection.version <= opts.sinceVersion) return false
  }
  if (opts.predicate !== undefined && !opts.predicate(state)) return false
  return true
}

async function pollOnce(opts: AwaitProjectionOptions): Promise<ProjectionBarrierState> {
  const where = opts.orderId !== undefined ? { id: opts.orderId } : (opts.filter as Record<string, unknown>)
  const projection = await opts.prisma.orderProjection.findFirst({ where })
  const eventOrderId = opts.orderId ?? projection?.id
  const events =
    eventOrderId === undefined
      ? []
      : await opts.prisma.orderEventLog.findMany({
          where: { orderId: eventOrderId },
          orderBy: { createdAt: "asc" },
        })
  return { projection, events }
}

/**
 * Poll until the expected projection state lands. Resolves with the final
 * state + `elapsedMs`/`polls`; throws `ProjectionBarrierTimeoutError`
 * (carrying the last-seen state) once `timeoutMs` is exhausted. Backoff:
 * `pollMs` × 1.5 per poll, capped at `maxPollMs`, never sleeping past the
 * deadline — a final poll always runs at the deadline edge.
 */
export async function awaitProjection(opts: AwaitProjectionOptions): Promise<AwaitProjectionResult> {
  if (opts.orderId === undefined && opts.filter === undefined) {
    throw new TypeError("awaitProjection: provide orderId or filter")
  }
  if (opts.sinceVersion === undefined && opts.predicate === undefined) {
    throw new TypeError("awaitProjection: provide sinceVersion or predicate")
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxPollMs = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS
  let delayMs = opts.pollMs ?? DEFAULT_POLL_MS

  const startedAt = Date.now()
  let polls = 0
  let lastSeen: ProjectionBarrierState | null = null

  for (;;) {
    lastSeen = await pollOnce(opts)
    polls += 1

    if (isSatisfied(lastSeen, opts)) {
      return {
        projection: lastSeen.projection,
        events: lastSeen.events,
        elapsedMs: Date.now() - startedAt,
        polls,
      }
    }

    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) {
      throw new ProjectionBarrierTimeoutError({
        target: opts.orderId !== undefined ? `order ${opts.orderId}` : `filter ${JSON.stringify(opts.filter)}`,
        condition: describeCondition(opts),
        lastSeen,
        elapsedMs: Date.now() - startedAt,
        polls,
      })
    }

    await sleep(Math.min(delayMs, remainingMs))
    delayMs = Math.min(Math.round(delayMs * BACKOFF_FACTOR), maxPollMs)
  }
}
