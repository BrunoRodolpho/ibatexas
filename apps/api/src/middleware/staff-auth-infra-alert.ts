// staff-auth-infra-alert.ts — BKL-092 SIGNAL half for the staff active-recheck.
//
// The staff path in middleware/auth.ts re-checks `createStaffService().getById(sub)`
// on every request (STAFFREVOKE). A live-validation finding (2026-07-04): with 7
// domain migrations unapplied, that lookup threw a Prisma P2022 (missing column
// `staff.hourly_rate_centavos`) which the middleware's catch swallowed as an
// ordinary unauthenticated result — EVERY staff login silently 401'd with ZERO
// operator signal.
//
// This module makes the INFRASTRUCTURE failure distinguishable from a genuine
// unknown/deactivated staff WITHOUT changing authz behavior: the request still
// fails closed (byte-identical 401 — the caller `return`s and never attaches a
// staff identity). The fix is pure SIGNAL:
//   (1) a structured ERROR log (event `staff_auth.infra_error`, PII-free), and
//   (2) a repeat-counted ops-alert on the NEW-025 ops-alert plane (governed
//       `ops.alert.open`, cause `ops_staff_auth_infra`) so a manager SEES it.
//
// Classification is fail-CLOSED: only a Prisma "record not found" (P2025 — the
// deleted/unknown staff the STAFFREVOKE check is designed to reject) counts as a
// genuine identity miss. ANY other DB error (schema drift, connectivity, or an
// unrecognized shape) is treated as infrastructure and surfaced.

import { getRedisClient, rk } from "@ibatexas/tools";
import {
  createOpsAlertService,
  OPS_ALERT_CAUSE_LABELS_PT,
} from "@ibatexas/domain";
import { getAuditSink } from "@ibatexas/audit-sink";
import type { FastifyBaseLogger } from "fastify";
import { buildSystemEnvelope } from "../subscribers/__shared__/system-actor-envelope.js";

// ── Classification ──────────────────────────────────────────────────────────

/**
 * The staff-lookup failure classes. `record_not_found` is the ONLY non-infra
 * class — it's the genuine "this staff row does not exist" that the STAFFREVOKE
 * active-recheck exists to reject (a deactivated/deleted staff whose staff_token
 * has not yet expired). Every other class is INFRASTRUCTURE and must surface.
 */
export type StaffLookupErrorClass =
  | "record_not_found" // Prisma P2025 — genuine unknown/deleted staff (NOT infra)
  | "schema_drift" // Prisma P2022 — missing column (the live-validation finding)
  | "connectivity" // Prisma P1xxx — DB unreachable / auth / timeout
  | "query_error" // other Prisma P2xxx — malformed / constraint query failure
  | "unknown"; // fail-closed default — any non-not-found DB error is infra

/**
 * Extract a Prisma error code without importing the Prisma runtime error
 * classes (keeps the middleware leaf light + robust to a client bump).
 * `PrismaClientKnownRequestError` exposes `.code` ("P2025", "P2022", …);
 * `PrismaClientInitializationError` exposes `.errorCode` ("P1001", …).
 */
function prismaErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const errorCode = (err as { errorCode?: unknown }).errorCode;
  if (typeof errorCode === "string") return errorCode;
  return undefined;
}

/**
 * Classify a staff `getById` failure. P2025 (record not found) is the single
 * genuine-identity path; everything else is infrastructure (fail-closed default).
 */
export function classifyStaffLookupError(err: unknown): StaffLookupErrorClass {
  const code = prismaErrorCode(err);
  if (code === "P2025") return "record_not_found";
  if (code === "P2022") return "schema_drift";
  if (code && code.startsWith("P1")) return "connectivity";
  if (code && code.startsWith("P2")) return "query_error";
  return "unknown";
}

/** Everything except a genuine record-not-found is an infrastructure failure. */
export function isStaffAuthInfraError(cls: StaffLookupErrorClass): boolean {
  return cls !== "record_not_found";
}

// ── Repeat-emission → ops-alert plane ───────────────────────────────────────

const OPS_CAUSE = "ops_staff_auth_infra" as const;
// One OPEN alert for the GLOBAL condition (no per-resource scope) — repeat
// detections fold in (occurrences++) via the service's dedupeKey logic.
const DEDUPE_KEY = `${OPS_CAUSE}:global`;

/**
 * Repeat threshold: raise the ops-alert only once the SAME window has seen this
 * many infra errors, so a single transient blip does not page anyone. Env-
 * overridable (Hard Rule #3) with a sane default. Non-positive / invalid → default.
 */
function alertThreshold(): number {
  const raw = process.env.STAFF_AUTH_INFRA_ALERT_THRESHOLD;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
}

/** Window (seconds) over which the repeat counter accumulates. Env-overridable. */
function alertWindowSeconds(): number {
  const raw = process.env.STAFF_AUTH_INFRA_ALERT_WINDOW_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300;
}

// Lazily constructed ONCE (module scope, not per-request) — mirrors the
// ingredient-depletion subscriber's single-construction of the audited service.
let _opsAlertSvc: ReturnType<typeof createOpsAlertService> | null = null;
function opsAlertSvc(): ReturnType<typeof createOpsAlertService> {
  return (_opsAlertSvc ??= createOpsAlertService({ auditSink: getAuditSink() }));
}

/** @internal — test isolation: drop the cached service so a fresh mock is picked up. */
export function _resetStaffAuthInfraAlert(): void {
  _opsAlertSvc = null;
}

/**
 * Report a staff-auth infrastructure failure. ALWAYS best-effort: this runs in
 * the request path but NEVER throws — the caller has already decided to fail the
 * request closed, so a logging/emission failure must not perturb that outcome.
 *
 *   (1) structured ERROR log — the immediate operator signal (PII-free: only the
 *       Prisma code + the classification, never the staff id or token).
 *   (2) per-window Redis counter (rk()); at/over threshold, RAISE/fold a governed
 *       `ops.alert.open` so the condition surfaces in the admin ops-alerts inbox.
 */
export async function reportStaffAuthInfraError(
  err: unknown,
  classification: StaffLookupErrorClass,
  log?: FastifyBaseLogger,
): Promise<void> {
  const code = prismaErrorCode(err) ?? "unknown";

  // (1) SIGNAL — structured ERROR (English per the logging conventions; component
  // stream tag so VMUI can slice it). No PII: staff id / token never logged.
  log?.error(
    {
      component: "auth",
      event: "staff_auth.infra_error",
      code,
      classification,
    },
    "[auth] staff active-recheck hit a DB infrastructure error — staff auth is failing closed (401) on infrastructure, not identity (check pending domain migrations / DB connectivity)",
  );

  // (2) REPEAT-EMISSION — best-effort ops-alert. Own try/catch; never rethrows.
  try {
    const redis = await getRedisClient();
    const counterKey = rk("staff_auth:infra_error:window");
    const count = await redis.incr(counterKey);
    // Set the window TTL on the first increment of a fresh window (fixed window).
    if (count === 1) {
      await redis.expire(counterKey, alertWindowSeconds());
    }
    // Below the repeat threshold → signal-only (the structured log already fired).
    if (count < alertThreshold()) return;

    const envelope = buildSystemEnvelope({
      kind: "ops.alert.open" as const,
      payload: {
        cause: OPS_CAUSE,
        // Every staff login is dead while this fires — surface at the top band.
        severity: "high" as const,
        source: "staff-auth-middleware",
        scope: null,
        title: OPS_ALERT_CAUSE_LABELS_PT[OPS_CAUSE],
        detail: `A verificação de funcionário no login falhou por erro de infraestrutura do banco (${count} ocorrências em ${alertWindowSeconds()}s). Logins de staff estão retornando 401. Verifique migrações pendentes do domínio e a conectividade do banco.`,
        context: {
          code,
          classification,
          windowCount: count,
          windowSeconds: alertWindowSeconds(),
        },
        dedupeKey: DEDUPE_KEY,
      },
      sourceSubject: "staff-auth-middleware",
      // nonce varies per raise so each observation is its own audit event; the
      // stable dedupeKey still folds the row.
      eventId: `${DEDUPE_KEY}:${Date.now()}`,
    });
    const outcome = await opsAlertSvc().openAlertFromEnvelope(envelope, {});
    if (outcome.decision.kind !== "EXECUTE") {
      log?.warn(
        { component: "auth", decision: outcome.decision.kind },
        "[auth] staff-auth-infra ops-alert open not authorized — skipping",
      );
    }
  } catch (alertErr) {
    log?.warn(
      { component: "auth", error: String(alertErr) },
      "[auth] staff-auth-infra ops-alert emission failed — auth still failing closed",
    );
  }
}
