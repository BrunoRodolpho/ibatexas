// OpsAlertService — durable ops-alert journal (NEW-025 detection half).
//
// One Postgres model (`OpsAlert`, schema `ibx_domain`), a PARALLEL plane to the
// conversation `ConversationIncident` journal. Ops alerts are restaurant-GLOBAL
// operational conditions raised by deterministic system watchdogs (stuck orders,
// PIX-expiry backlog, stale defers, DLQ depth) — no session, no customer. The
// condition identity is `dedupeKey`: one OPEN alert per condition (partial-unique
// WHILE non-terminal, hand-written in the migration), and repeat detections of
// the same condition fold in (occurrences++) rather than duplicate.
//
// ── Governance ──────────────────────────────────────────────────────────────
//
// `openAlertFromEnvelope` / `resolveAlertFromEnvelope` route through the
// adjudicate kernel via `withAdjudicate` against `opsAlertPolicyBundle`. Both
// kinds are SYSTEM-only; the open guard additionally REFUSEs an out-of-taxonomy
// cause (fail-closed against a buggy watchdog). The durable row write does NOT
// depend on NATS — the kernel `adjudicate()` is pure/synchronous.
//
// Construct with `auditSink: getAuditSink()` at the call sites — `withAdjudicate`
// skips the audit emit entirely if `auditSink` is absent (with-adjudicate.ts).

import { prisma } from "../client.js"
import {
  Prisma,
  type OpsAlert,
  type OpsAlertCause,
  type OpsAlertSeverity,
  type OpsAlertStatus,
} from "../generated/prisma-client/client.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import {
  opsAlertPolicyBundle,
  type OpsAlertOpenPayload,
  type OpsAlertResolvePayload,
  type OpsAlertState,
} from "./__shared__/ops-alert-policy.js"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"

// ── Severity (monotonic-up on repeat detection) ─────────────────────────────

const SEVERITY_LADDER: readonly OpsAlertSeverity[] = ["low", "medium", "high"]

/**
 * The HIGHER of two severity bands. A repeat detection can only ESCALATE an open
 * alert's severity (never downgrade it) — a condition that worsens between sweeps
 * must surface at its worst-seen band.
 */
export function maxSeverity(
  a: OpsAlertSeverity,
  b: OpsAlertSeverity,
): OpsAlertSeverity {
  return SEVERITY_LADDER.indexOf(a) >= SEVERITY_LADDER.indexOf(b) ? a : b
}

// ── Service ─────────────────────────────────────────────────────────────────

const NON_TERMINAL: readonly OpsAlertStatus[] = ["OPEN", "ACKNOWLEDGED"]

export interface OpenOpsAlertResult {
  /** true → a fresh alert was created; false → an existing open one folded in. */
  readonly opened: boolean
  readonly alert: OpsAlert
}

export interface OpsAlertListParams {
  readonly status?: OpsAlertStatus
  readonly cause?: OpsAlertCause
  readonly limit?: number
  readonly offset?: number
}

export interface OpsAlertListResult {
  readonly alerts: OpsAlert[]
  /** Standalone COUNT of NON_TERMINAL (OPEN + ACKNOWLEDGED) — the inbox badge. */
  readonly openCount: number
}

export interface OpsAlertServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
}

export function createOpsAlertService(options?: OpsAlertServiceOptions) {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
  } as const

  /** Fold a repeat detection into an existing non-terminal alert (occurrences++,
   *  bump lastSeenAt, escalate severity monotonically, refresh detail/context). */
  async function foldIn(
    existing: OpsAlert,
    payload: OpsAlertOpenPayload,
    now: Date,
  ): Promise<OpsAlert> {
    return prisma.opsAlert.update({
      where: { id: existing.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: now,
        severity: maxSeverity(existing.severity, payload.severity),
        // Refresh the human/agent-facing fields to the latest observation.
        title: payload.title,
        detail: payload.detail ?? null,
        context:
          payload.context === undefined || payload.context === null
            ? Prisma.JsonNull
            : (payload.context as Prisma.InputJsonValue),
      },
    })
  }

  async function openExecutor(
    payload: OpsAlertOpenPayload,
  ): Promise<OpenOpsAlertResult> {
    const now = new Date()

    // (1) Already an OPEN alert for this condition → fold this detection in.
    const existing = await prisma.opsAlert.findFirst({
      where: { dedupeKey: payload.dedupeKey, status: { in: [...NON_TERMINAL] } },
      orderBy: { lastSeenAt: "desc" },
    })
    if (existing) {
      return { opened: false, alert: await foldIn(existing, payload, now) }
    }

    // (2) None open → create a fresh alert.
    try {
      const created = await prisma.opsAlert.create({
        data: {
          cause: payload.cause,
          severity: payload.severity,
          status: "OPEN",
          source: payload.source,
          scope: payload.scope ?? null,
          title: payload.title,
          detail: payload.detail ?? null,
          context:
            payload.context === undefined || payload.context === null
              ? Prisma.JsonNull
              : (payload.context as Prisma.InputJsonValue),
          occurrences: 1,
          dedupeKey: payload.dedupeKey,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      })
      return { opened: true, alert: created }
    } catch (err) {
      // `withAdjudicate` does NOT swallow executor errors, so an uncaught P2002
      // would crash/NACK the sweep — catch the partial-unique race here.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        // A concurrent sweep opened the row first (dedupe_open_uq collision) →
        // re-read the open row and fold this detection in (it still counts).
        const racing = await prisma.opsAlert.findFirst({
          where: {
            dedupeKey: payload.dedupeKey,
            status: { in: [...NON_TERMINAL] },
          },
          orderBy: { lastSeenAt: "desc" },
        })
        if (racing) {
          return { opened: false, alert: await foldIn(racing, payload, now) }
        }
      }
      throw err
    }
  }

  async function resolveExecutor(
    payload: OpsAlertResolvePayload,
  ): Promise<OpsAlert | null> {
    const now = new Date()
    const terminalStatus: OpsAlertStatus =
      payload.resolutionType === "AUTO" ? "AUTO_RESOLVED" : "RESOLVED"

    // Idempotent transition: only a non-terminal row moves. Already-terminal is a
    // no-op (the watchdog re-observing a cleared condition must not error).
    await prisma.opsAlert.updateMany({
      where: { id: payload.id, status: { in: [...NON_TERMINAL] } },
      data: {
        status: terminalStatus,
        resolvedAt: now,
        resolvedBy: payload.resolvedBy,
        resolutionType: payload.resolutionType,
      },
    })

    // Return the CURRENT row whether it transitioned or was already closed; null
    // ONLY when the id does not exist (load-bearing for the admin 404).
    return prisma.opsAlert.findUnique({ where: { id: payload.id } })
  }

  return {
    /**
     * Governed `ops.alert.open`. SYSTEM-only. EXECUTE → opens a fresh alert OR
     * folds the detection into the condition's existing open one; REFUSE
     * (out-of-taxonomy cause) → the executor never runs.
     */
    async openAlertFromEnvelope(
      envelope: IntentEnvelope<"ops.alert.open", OpsAlertOpenPayload>,
      state: OpsAlertState,
    ): Promise<AdjudicatedResult<OpenOpsAlertResult>> {
      return withAdjudicate(
        envelope,
        state,
        opsAlertPolicyBundle,
        (payload) => openExecutor(payload as OpsAlertOpenPayload),
        adjudicateOptions,
      )
    },

    /**
     * Governed `ops.alert.resolve`. SYSTEM/STAFF. Returns the current alert when
     * the id exists (transitioned or already-closed) and null ONLY when the id
     * does not exist. AUTO → AUTO_RESOLVED; STAFF → RESOLVED.
     */
    async resolveAlertFromEnvelope(
      envelope: IntentEnvelope<"ops.alert.resolve", OpsAlertResolvePayload>,
      state: OpsAlertState,
    ): Promise<AdjudicatedResult<OpsAlert | null>> {
      return withAdjudicate(
        envelope,
        state,
        opsAlertPolicyBundle,
        (payload) => resolveExecutor(payload as OpsAlertResolvePayload),
        adjudicateOptions,
      )
    },

    /**
     * By-id read. Returns the alert row or `null` when the id does not exist.
     * Backs the BKL-088 ops-plane resolver: it projects `{id,status}` into the
     * pack-ops `OpsState.alert` so `requireAlertActionable` can fail closed on
     * an absent / already-terminal alert BEFORE the staff-verb adjudication.
     */
    async get(id: string): Promise<OpsAlert | null> {
      return prisma.opsAlert.findUnique({ where: { id } })
    },

    /**
     * Filtered alert list + an INDEPENDENT open count. `openCount` is a
     * standalone COUNT of NON_TERMINAL (OPEN + ACKNOWLEDGED) — never `rows.length`
     * and never affected by the list filters (it backs the inbox badge, so an
     * acknowledged alert still counts).
     */
    async list(params: OpsAlertListParams = {}): Promise<OpsAlertListResult> {
      const where: Prisma.OpsAlertWhereInput = {
        ...(params.status ? { status: params.status } : {}),
        ...(params.cause ? { cause: params.cause } : {}),
      }
      const limit = params.limit ?? 50
      const offset = params.offset ?? 0
      const [alerts, openCount] = await Promise.all([
        prisma.opsAlert.findMany({
          where,
          // OPEN-first, then most-recently-active.
          orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }],
          take: limit,
          skip: offset,
        }),
        prisma.opsAlert.count({ where: { status: { in: [...NON_TERMINAL] } } }),
      ])
      return { alerts, openCount }
    },
  }
}

export type OpsAlertService = ReturnType<typeof createOpsAlertService>
