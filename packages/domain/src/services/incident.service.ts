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

export interface IncidentStats {
  /**
   * OPEN-only count — backs the "Abertos" StatCard. Deliberately DISTINCT from
   * `IncidentListResult.openCount` (which counts NON_TERMINAL = OPEN +
   * ACKNOWLEDGED for the sidebar badge) so the "Abertos" and "Reconhecidos"
   * cards never double-count the same acknowledged incident.
   */
  readonly open: number
  readonly acknowledged: number
  readonly resolvedToday: number
  readonly resolvedAuto: number
  readonly resolvedStaff: number
  readonly avgMinutes: number
}

export interface IncidentListResult {
  readonly rows: readonly ConversationIncident[]
  /**
   * Independent COUNT of NON_TERMINAL (OPEN + ACKNOWLEDGED) incidents — NEVER
   * `rows.length` and never affected by the list filters. Backs the sidebar
   * "still needs attention" badge (an acknowledged incident still counts).
   */
  readonly openCount: number
  /**
   * Independent StatCard aggregate (M10) — computed with its OWN queries, NOT
   * derived from the (paginated / OPEN-first) `rows` window, so resolved-today /
   * avg-time stay correct during a storm when zero resolved rows are in view.
   *
   * OPTIONAL: the aggregate is EXPENSIVE (two counts + a resolved-since findMany),
   * so `list()` computes it only when the caller needs it — explicitly via
   * `IncidentListParams.includeStats`, else only on the FIRST page (`offset` 0).
   * `undefined` when skipped (a paginated request beyond page 0). Every current
   * caller (the route + client fetch page 0) still receives it — see `list()`.
   */
  readonly stats?: IncidentStats
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
  /**
   * Lower bound for the resolved-today stat window (terminal incidents with
   * `resolvedAt >= resolvedSince`). Defaults to server start-of-today.
   */
  readonly resolvedSince?: Date
  /**
   * Force-compute (or force-skip) the expensive M10 StatCard aggregate. When
   * omitted, `list()` computes stats only on the FIRST page (`offset` 0) and skips
   * it while paginating — so a large-history page-turn no longer recomputes the
   * whole-inbox aggregate. Set `true` to always include, `false` to always skip.
   */
  readonly includeStats?: boolean
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

/** Server-local start-of-today — default lower bound for the resolved-today stat window. */
function startOfServerDay(now: Date): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * INDEPENDENT StatCard aggregate (M10). Runs its OWN queries — an OPEN count, an
 * ACKNOWLEDGED count, and the small terminal `resolvedAt >= resolvedSince` set —
 * so the resolved-today / avg-time cards stay correct during a storm when the
 * OPEN-first list window contains zero resolved rows. PERF: the resolved-since
 * set is small/bounded (one day of terminal incidents; incidents are exceptional).
 */
async function computeStats(resolvedSince: Date): Promise<IncidentStats> {
  const [open, acknowledged, resolved] = await Promise.all([
    prisma.conversationIncident.count({ where: { status: "OPEN" } }),
    prisma.conversationIncident.count({ where: { status: "ACKNOWLEDGED" } }),
    prisma.conversationIncident.findMany({
      where: { status: { in: [...TERMINAL] }, resolvedAt: { gte: resolvedSince } },
      select: { openedAt: true, resolvedAt: true, resolutionType: true },
    }),
  ])
  const resolvedToday = resolved.length
  // SYSTEM-driven closes are NOT staff work: AUTO (self-heal on the next delivered
  // reply) and HANDED_OFF (`resolveIncidentOnHandoff` → resolvedBy `system:escalation`)
  // are both closed by the system, not by a human clicking "resolver". Counting
  // HANDED_OFF as staff over-reported the "você" sub-line. `resolvedStaff` is the
  // genuinely-manual remainder (STAFF), so `auto + você = resolvedToday` still holds.
  const resolvedAuto = resolved.filter(
    (r) => r.resolutionType === "AUTO" || r.resolutionType === "HANDED_OFF",
  ).length
  const resolvedStaff = resolvedToday - resolvedAuto
  // Ignore negative durations (clock skew / bad data) — mirrors the client guard.
  const durations = resolved
    .map((r) => (r.resolvedAt ? r.resolvedAt.getTime() - r.openedAt.getTime() : -1))
    .filter((ms) => ms >= 0)
  const avgMinutes = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60_000)
    : 0
  return { open, acknowledged, resolvedToday, resolvedAuto, resolvedStaff, avgMinutes }
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
    // customerImpacted is MONOTONIC (never downgrade true→false): a later
    // TRUE-ghost drop escalates a degraded (aviso-enviado, customerImpacted=false)
    // incident to silêncio so it can reach the high/silêncio branch. Escalate only
    // when the incoming drop is explicitly customer-impacting; an unknown/omitted
    // impact preserves the known existing value.
    const nextCustomerImpacted =
      existing.customerImpacted || payload.customerImpacted === true
    const severity = deriveSeverity({
      customerImpacted: nextCustomerImpacted,
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
        customerImpacted: nextCustomerImpacted,
        // Advance externalId to THIS drop's id so the step-0 replay guard matches
        // a redelivered increment (ordinary NATS at-least-once) and does NOT
        // double-count dropCount. The id is unique to this event (the step-0
        // findUnique already returned null for it), so no @@unique(externalId)
        // collision is possible here.
        //
        // DEFERRED (schema decision): this is dedupe-LATEST — the row remembers
        // only the most recent event id, so a redelivery of an EARLIER drop (after
        // a newer one advanced externalId) could double-count. AIRTIGHT per-event
        // dedup needs a per-row processed-key SET (e.g. a `processed_event_ids`
        // text[] column, or a child dedup table) so every event id is remembered,
        // not just the latest. That is a schema addition owned by the schema wave;
        // keep dedupe-latest until it lands rather than half-implement it.
        externalId: payload.externalId,
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

    /**
     * BKL-260 — close an incident the caller has ALREADY adjudicated. THE CALLER
     * MUST HOLD A POSITIVE (EXECUTE/REWRITE) `Decision` for the verb that
     * authorized this close; this method performs NO adjudication. It is the raw
     * post-decision persistence body {@link closeIncidentFromEnvelope} runs, and
     * mirrors `OrderCommandService.writeAdjudicatedNote` (BKL-083 option b).
     *
     * The only caller is the ops tool registry's `incident.ticket.close.staff`
     * executor, dispatched by the ops Conductor on a decision the composed ops
     * router produced with `adminSessionOnlyGuard` + `staffRoleGuard`
     * {OWNER,MANAGER} + the actionability guard against resolver-projected state.
     * It used to BUILD a SYSTEM `incident.ticket.close` envelope and adjudicate it
     * here a second time — a second decision for one staff action, and a strictly
     * WEAKER one: `incidentPolicyBundle` carries no state guards and no auth
     * guards, its frozen-cause guard is scoped to `incident.ticket.open`, and its
     * SYSTEM taint floor was satisfied by construction because the executor itself
     * had just stamped `taint: "SYSTEM"`. That inner run could only ever return
     * EXECUTE.
     *
     * `closeIncidentFromEnvelope` stays the entry point for the callers that have
     * NO decision behind them — the admin incidents resolve route, the auto-close
     * driver, and the hand-off path — and MUST keep adjudicating (rule #9).
     *
     * Returns the current row whether it transitioned or was already closed, and
     * `null` ONLY when the id does not exist (the ops render gate keys on that).
     */
    async writeAdjudicatedIncidentClose(
      payload: IncidentClosePayload,
    ): Promise<ConversationIncident | null> {
      return closeExecutor(payload)
    },

    // ── Reads ──────────────────────────────────────────────────────────────

    /**
     * Filtered incident list + an INDEPENDENT open count + an INDEPENDENT stat
     * aggregate. `openCount` is a standalone COUNT of NON_TERMINAL (OPEN +
     * ACKNOWLEDGED) — never `rows.length` and never affected by the list filters
     * (it backs the "still needs attention" sidebar badge, so an acknowledged
     * incident still counts). `stats` (M10) is likewise computed with its own
     * queries, not the paginated/OPEN-first row window. Severity is recomputed at
     * read time on every returned row.
     */
    async list(params: IncidentListParams = {}): Promise<IncidentListResult> {
      const now = new Date()
      // Severity is NOT a DB filter: `deriveSeverity` is the ONE source of truth
      // and is recomputed at read time, so the persisted `severity` column lags
      // once an incident ages past the threshold (e.g. medium → high). Filtering
      // on the stale column would exclude a row that is displayed as `high`. So
      // the severity predicate is applied to the DERIVED value below.
      const where: Prisma.ConversationIncidentWhereInput = {
        ...(params.status ? { status: params.status } : {}),
        ...(params.cause ? { cause: params.cause } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.agingMinutes !== undefined
          ? {
              openedAt: {
                lte: new Date(now.getTime() - params.agingMinutes * 60_000),
              },
            }
          : {}),
      }
      const limit = params.limit ?? 50
      const offset = params.offset ?? 0
      const openCountP = prisma.conversationIncident.count({
        where: { status: { in: [...NON_TERMINAL] } },
      })
      // Independent stat aggregate (M10) — own queries, not the `rows` window. It
      // is EXPENSIVE (two counts + a resolved-since findMany), so compute it ONLY
      // when the caller needs it: explicitly via `includeStats`, else only on the
      // FIRST page (offset 0). Paginating a large history no longer recomputes the
      // whole-inbox aggregate. The default preserves every current caller — the
      // route + client fetch page 0, so they still receive `stats`.
      const wantStats = params.includeStats ?? offset === 0
      const statsP = wantStats
        ? computeStats(params.resolvedSince ?? startOfServerDay(now))
        : undefined

      if (params.severity) {
        // Recompute-then-filter: the severity predicate can't be pushed into SQL
        // (see above), so it — and therefore pagination — must be applied in
        // memory over the derived severity. PERF CAVEAT: this scans every row
        // matching the non-severity filters (no DB `take`/`skip`). Bounded in
        // practice — incidents are exceptional and status/session/aging narrow
        // the set — but revisit if incident volume ever grows large.
        const [all, openCount, stats] = await Promise.all([
          prisma.conversationIncident.findMany({
            where,
            orderBy: { openedAt: "desc" },
          }),
          openCountP,
          statsP,
        ])
        const rows = all
          .map((r) => refreshSeverity(r, now))
          .filter((r) => r.severity === params.severity)
          .slice(offset, offset + limit)
        return { rows, openCount, stats }
      }

      const [rows, openCount, stats] = await Promise.all([
        prisma.conversationIncident.findMany({
          where,
          orderBy: { openedAt: "desc" },
          take: limit,
          skip: offset,
        }),
        openCountP,
        statsP,
      ])
      return { rows: rows.map((r) => refreshSeverity(r, now)), openCount, stats }
    },

    async get(id: string): Promise<ConversationIncident | null> {
      const row = await prisma.conversationIncident.findUnique({ where: { id } })
      return row ? refreshSeverity(row) : null
    },

    /**
     * Independent COUNT of NON_TERMINAL (OPEN + ACKNOWLEDGED) incidents — backs
     * the "still needs attention" sidebar badge (an acknowledged incident still
     * needs a human, so it stays counted).
     */
    async countOpen(): Promise<number> {
      return prisma.conversationIncident.count({
        where: { status: { in: [...NON_TERMINAL] } },
      })
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

    /**
     * Cheap indexed lookup for THE non-terminal incident on a session (backs the
     * auto-close / handoff-close seams). Returns `null` on the happy path — the
     * `@@index([sessionId])` makes this fast enough to run on every delivered
     * reply. Severity is NOT recomputed (callers only need the id/status).
     */
    async findOpenBySession(
      sessionId: string,
    ): Promise<ConversationIncident | null> {
      return prisma.conversationIncident.findFirst({
        where: { sessionId, status: { in: [...NON_TERMINAL] } },
        orderBy: { openedAt: "desc" },
      })
    },
  }
}

export type IncidentService = ReturnType<typeof createIncidentService>
