// IncidentService — durable no-reply incident journal (W1).
//
// One Postgres model (`ConversationIncident`, schema `ibx_domain`), separate
// from the Redis EscalationRecord and never touching the bot-pause state — the
// bot keeps replying and can self-heal. Correlated by a soft `sessionId`
// string (no FK), so an incident can open BEFORE the async archiver creates
// the `Conversation` row.
//
// ── Governance ──────────────────────────────────────────────────────────────
//
// `openIncidentFromEnvelope` / `closeIncidentFromEnvelope` route through the
// adjudicate kernel via `withAdjudicate` against `incidentPolicyBundle`. Both
// kinds are SYSTEM-only; the open guard additionally REFUSEs an out-of-taxonomy
// cause (fail-closed against a buggy detector). The durable row write does NOT
// depend on NATS — the kernel `adjudicate()` is pure/synchronous.
//
// Construct with `auditSink: getAuditSink()` at the call sites — `withAdjudicate`
// skips the audit emit entirely if `auditSink` is absent (with-adjudicate.ts).

import { prisma } from "../client.js"
import {
  Prisma,
  type ConversationIncident,
  type IncidentCause,
  type IncidentSeverity,
  type IncidentStatus,
} from "../generated/prisma-client/client.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import {
  incidentPolicyBundle,
  type IncidentClosePayload,
  type IncidentOpenPayload,
  type IncidentState,
} from "./__shared__/incident-policy.js"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"

// ── Severity derivation (the ONE source) ────────────────────────────────────

/**
 * A drop older than this many minutes counts as "aged" for severity. Read-time
 * only — aging cannot be frozen at write time, so `deriveSeverity` is applied
 * on every read (and the persisted column is refreshed on write).
 */
export const SEVERITY_AGING_THRESHOLD_MINUTES = 20

export interface DeriveSeverityInput {
  /** true → `silêncio` (ghost: nothing reached the customer). false → `aviso enviado`. */
  readonly customerImpacted: boolean
  readonly dropCount: number
  readonly openedAt: Date
  /** Present → this incident is a re-open (bumps severity up one band). */
  readonly priorIncidentId?: string | null
  /** Defaults to now; injected in tests for deterministic aging. */
  readonly now?: Date
}

const SEVERITY_LADDER: readonly IncidentSeverity[] = ["low", "medium", "high"]

function bumpUpOneBand(severity: IncidentSeverity): IncidentSeverity {
  const idx = SEVERITY_LADDER.indexOf(severity)
  return SEVERITY_LADDER[Math.min(idx + 1, SEVERITY_LADDER.length - 1)]!
}

/**
 * PURE severity derivation (plan §6). Single source of truth for row tint,
 * dot, default sort, and the sidebar urgency badge.
 *
 *   - `silêncio` AND (aged > 20min OR dropCount ≥ 2 OR reaberto) → high
 *   - `aviso enviado` AND recent (within the aging threshold)    → low
 *   - everything else                                            → medium
 *   - a re-open (`priorIncidentId` present) bumps the result up one band
 *     (never down) — a persistent failure on one conversation is worse than a
 *     one-off.
 */
export function deriveSeverity(input: DeriveSeverityInput): IncidentSeverity {
  const now = input.now ?? new Date()
  const ageMinutes = (now.getTime() - input.openedAt.getTime()) / 60_000
  const aged = ageMinutes > SEVERITY_AGING_THRESHOLD_MINUTES
  const reaberto = input.priorIncidentId != null
  const silencio = input.customerImpacted === true

  let base: IncidentSeverity
  if (silencio && (aged || input.dropCount >= 2 || reaberto)) {
    base = "high"
  } else if (!silencio && !aged) {
    base = "low"
  } else {
    base = "medium"
  }

  return reaberto ? bumpUpOneBand(base) : base
}

// ── Service ─────────────────────────────────────────────────────────────────

const NON_TERMINAL: readonly IncidentStatus[] = ["OPEN", "ACKNOWLEDGED"]
const TERMINAL: readonly IncidentStatus[] = ["AUTO_RESOLVED", "RESOLVED"]

export interface OpenIncidentResult {
  /** true → a fresh incident was created; false → an existing one incremented. */
  readonly opened: boolean
  readonly incident: ConversationIncident
}

export interface IncidentListResult {
  readonly rows: readonly ConversationIncident[]
  /** Independent COUNT(status=OPEN) — NEVER `rows.length`. */
  readonly openCount: number
}

export interface IncidentListParams {
  readonly status?: IncidentStatus
  readonly cause?: IncidentCause
  readonly severity?: IncidentSeverity
  readonly sessionId?: string
  /** Only incidents opened at least this many minutes ago. */
  readonly agingMinutes?: number
  readonly limit?: number
  readonly offset?: number
}

export interface IncidentServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
}

/** Recompute severity at read time (aging can't be frozen at write time). */
function refreshSeverity(
  row: ConversationIncident,
  now = new Date(),
): ConversationIncident {
  return {
    ...row,
    severity: deriveSeverity({
      customerImpacted: row.customerImpacted,
      dropCount: row.dropCount,
      openedAt: row.openedAt,
      priorIncidentId: row.priorIncidentId,
      now,
    }),
  }
}

export function createIncidentService(options?: IncidentServiceOptions) {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
  } as const

  /** Increment an existing non-terminal incident (a repeat drop, D8). */
  async function incrementDrop(
    existing: ConversationIncident,
    payload: IncidentOpenPayload,
    now: Date,
  ): Promise<ConversationIncident> {
    const nextDropCount = existing.dropCount + 1
    const severity = deriveSeverity({
      customerImpacted: existing.customerImpacted,
      dropCount: nextDropCount,
      openedAt: existing.openedAt,
      priorIncidentId: existing.priorIncidentId,
      now,
    })
    return prisma.conversationIncident.update({
      where: { id: existing.id },
      data: {
        dropCount: { increment: 1 },
        lastCause: payload.cause,
        lastDropAt: now,
        severity,
        ...(payload.lastTurnId !== undefined
          ? { lastTurnId: payload.lastTurnId }
          : {}),
        ...(payload.lastDecisionKind !== undefined
          ? { lastDecisionKind: payload.lastDecisionKind }
          : {}),
      },
    })
  }

  async function openExecutor(
    payload: IncidentOpenPayload,
  ): Promise<OpenIncidentResult> {
    const now = new Date()

    // (0) Same-event replay guard: if this externalId is already persisted (common
    // at-least-once redelivery while the incident is still OPEN) → return it as-is
    // without touching dropCount. The catch(P2002) backstop below still handles the
    // tight concurrent-create race; this check handles the sequential redelivery path.
    const replayed = await prisma.conversationIncident.findUnique({
      where: { externalId: payload.externalId },
    })
    if (replayed) return { opened: false, incident: replayed }

    // (1) Already an open incident on this session → increment (per-incident dedup).
    const existing = await prisma.conversationIncident.findFirst({
      where: { sessionId: payload.sessionId, status: { in: [...NON_TERMINAL] } },
      orderBy: { openedAt: "desc" },
    })
    if (existing) {
      return { opened: false, incident: await incrementDrop(existing, payload, now) }
    }

    // (2) None open → newest terminal row links the re-open chain (priorIncidentId).
    const prior = await prisma.conversationIncident.findFirst({
      where: { sessionId: payload.sessionId, status: { in: [...TERMINAL] } },
      orderBy: { openedAt: "desc" },
      select: { id: true },
    })
    const priorIncidentId = prior?.id ?? null
    const customerImpacted = payload.customerImpacted ?? true
    const severity = deriveSeverity({
      customerImpacted,
      dropCount: 1,
      openedAt: now,
      priorIncidentId,
      now,
    })

    try {
      const created = await prisma.conversationIncident.create({
        data: {
          sessionId: payload.sessionId,
          conversationId: payload.conversationId ?? null,
          customerId: payload.customerId ?? null,
          channel: payload.channel,
          senderRef: payload.senderRef ?? null,
          cause: payload.cause,
          lastCause: payload.cause,
          severity,
          status: "OPEN",
          dropCount: 1,
          customerImpacted,
          openedAt: now,
          lastDropAt: now,
          priorIncidentId,
          lastTurnId: payload.lastTurnId ?? null,
          lastDecisionKind: payload.lastDecisionKind ?? null,
          externalId: payload.externalId,
          phoneHash: payload.phoneHash ?? null,
          detail: payload.detail ?? null,
        },
      })
      return { opened: true, incident: created }
    } catch (err) {
      // `withAdjudicate` does NOT swallow executor errors and the caller is not
      // wrapped, so an uncaught P2002 would crash/NACK — catch it here.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        const target = String(
          (err.meta as { target?: unknown } | undefined)?.target ?? "",
        )
        // externalId collision = the same event was replayed → idempotent
        // no-op (the per-event dedup backstop did its job); do NOT increment.
        if (target.includes("external")) {
          const replayed = await prisma.conversationIncident.findUnique({
            where: { externalId: payload.externalId },
          })
          if (replayed) return { opened: false, incident: replayed }
        }
        // session partial-unique collision = a concurrent drop opened the row
        // first → re-read the open row + increment (this drop still counts).
        const racing = await prisma.conversationIncident.findFirst({
          where: { sessionId: payload.sessionId, status: { in: [...NON_TERMINAL] } },
          orderBy: { openedAt: "desc" },
        })
        if (racing) {
          return {
            opened: false,
            incident: await incrementDrop(racing, payload, now),
          }
        }
      }
      throw err
    }
  }

  async function closeExecutor(
    payload: IncidentClosePayload,
  ): Promise<ConversationIncident | null> {
    const now = new Date()
    const terminalStatus: IncidentStatus =
      payload.resolutionType === "AUTO" ? "AUTO_RESOLVED" : "RESOLVED"

    // Idempotent transition: only a non-terminal row actually moves. count===0
    // (already closed) is a no-op.
    await prisma.conversationIncident.updateMany({
      where: { id: payload.id, status: { in: [...NON_TERMINAL] } },
      data: {
        status: terminalStatus,
        resolvedAt: now,
        resolvedBy: payload.resolvedBy,
        resolutionType: payload.resolutionType,
        ...(payload.closingTurnId !== undefined
          ? { closingTurnId: payload.closingTurnId }
          : {}),
      },
    })

    // Return the CURRENT row whether it transitioned or was already closed;
    // null ONLY when the id does not exist (load-bearing for the admin 404).
    return prisma.conversationIncident.findUnique({ where: { id: payload.id } })
  }

  return {
    /**
     * Governed `incident.ticket.open`. SYSTEM-only. EXECUTE → opens a fresh
     * incident OR increments the session's existing non-terminal one (D8);
     * REFUSE (out-of-taxonomy cause) → executor never runs.
     */
    async openIncidentFromEnvelope(
      envelope: IntentEnvelope<"incident.ticket.open", IncidentOpenPayload>,
      state: IncidentState,
    ): Promise<AdjudicatedResult<OpenIncidentResult>> {
      return withAdjudicate(
        envelope,
        state,
        incidentPolicyBundle,
        (payload) => openExecutor(payload as IncidentOpenPayload),
        adjudicateOptions,
      )
    },

    /**
     * Governed `incident.ticket.close`. SYSTEM-only. Returns the current
     * incident when the id exists (transitioned or already-closed) and null
     * ONLY when the id does not exist. Supports AUTO | STAFF | HANDED_OFF.
     */
    async closeIncidentFromEnvelope(
      envelope: IntentEnvelope<"incident.ticket.close", IncidentClosePayload>,
      state: IncidentState,
    ): Promise<AdjudicatedResult<ConversationIncident | null>> {
      return withAdjudicate(
        envelope,
        state,
        incidentPolicyBundle,
        (payload) => closeExecutor(payload as IncidentClosePayload),
        adjudicateOptions,
      )
    },

    // ── Reads ──────────────────────────────────────────────────────────────

    /**
     * Filtered incident list + an INDEPENDENT open count. `openCount` is a
     * standalone COUNT(status=OPEN) — never `rows.length` and never affected by
     * the list filters (it backs the in-app badge). Severity is recomputed at
     * read time on every returned row.
     */
    async list(params: IncidentListParams = {}): Promise<IncidentListResult> {
      const now = new Date()
      const where: Prisma.ConversationIncidentWhereInput = {
        ...(params.status ? { status: params.status } : {}),
        ...(params.cause ? { cause: params.cause } : {}),
        ...(params.severity ? { severity: params.severity } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.agingMinutes !== undefined
          ? {
              openedAt: {
                lte: new Date(now.getTime() - params.agingMinutes * 60_000),
              },
            }
          : {}),
      }
      const [rows, openCount] = await Promise.all([
        prisma.conversationIncident.findMany({
          where,
          orderBy: { openedAt: "desc" },
          take: params.limit ?? 50,
          skip: params.offset ?? 0,
        }),
        prisma.conversationIncident.count({ where: { status: "OPEN" } }),
      ])
      return { rows: rows.map((r) => refreshSeverity(r, now)), openCount }
    },

    async get(id: string): Promise<ConversationIncident | null> {
      const row = await prisma.conversationIncident.findUnique({ where: { id } })
      return row ? refreshSeverity(row) : null
    },

    /** Independent COUNT(status=OPEN) — backs the sidebar badge. */
    async countOpen(): Promise<number> {
      return prisma.conversationIncident.count({ where: { status: "OPEN" } })
    },

    async listOpen(limit = 50): Promise<readonly ConversationIncident[]> {
      const now = new Date()
      const rows = await prisma.conversationIncident.findMany({
        where: { status: "OPEN" },
        orderBy: { openedAt: "desc" },
        take: limit,
      })
      return rows.map((r) => refreshSeverity(r, now))
    },

    async listBySession(
      sessionId: string,
    ): Promise<readonly ConversationIncident[]> {
      const now = new Date()
      const rows = await prisma.conversationIncident.findMany({
        where: { sessionId },
        orderBy: { openedAt: "desc" },
      })
      return rows.map((r) => refreshSeverity(r, now))
    },
  }
}

export type IncidentService = ReturnType<typeof createIncidentService>
