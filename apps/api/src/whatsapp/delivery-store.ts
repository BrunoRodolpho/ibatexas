// WhatsApp delivery confirmation store (LE2-030) — "sent" becomes "delivered".
//
// The last unverified hop in the send path: `twilioAdjudicated.messages.create`
// returning without throwing proves only that TWILIO ACCEPTED the message, not
// that WhatsApp delivered it. This store closes that gap by persisting the
// Twilio message SID of every outbound reply at send time, then folding the
// asynchronous delivery-status callbacks (delivered / failed / undelivered …)
// onto the same row, correlated by SID.
//
// ── Why a table and not columns on turn_trace (the store choice) ────────────
//
// `turn_trace` is one row per LLM MODEL CALL (`UNIQUE (turn_id, call_index)`) —
// it has no send-stage row at all: the send is a VictoriaLogs `reply.sent` line,
// not a trace row. Hanging SIDs off it would mean minting synthetic rows per
// reply PART inside a table whose row identity is "a model call", and whose
// canonical migration is owned by the FROZEN @adjudicate/audit-postgres package
// that the cross-repo console reads. Delivery also has a lifecycle turn_trace
// does not: rows are UPDATED minutes after the turn ended, out of order, by an
// external caller keyed on a SID that turn_trace does not carry.
//
// So: a small writer-owned side table keyed by SID, exactly like `llm_wire`
// (llm-wire-writer.ts) — CREATE TABLE IF NOT EXISTS at boot, pinned in
// packages/cli's KERNEL_TABLES + WRITER_OWNED_KERNEL_TABLES so `ibx db clean`
// truncates it and the drift guard names its owner.
//
// ── Governance posture (CLAUDE.md #9) ───────────────────────────────────────
//
// This is PURE TRACE / TELEMETRY. It writes one writer-owned observability
// table and touches NO governed store: no Prisma domain model, no Medusa, no
// kernel-audited resource, no customer-visible state. So the system-actor
// envelope rule (`buildSystemEnvelope()` for system-driven MUTATIONS) does not
// apply here — there is no mutation to adjudicate. The send itself is already
// kernel-gated upstream at `twilioAdjudicated.messages.create`; this store only
// records what that send produced.
//
// ── Fail-open everywhere ────────────────────────────────────────────────────
//
// Delivery telemetry must NEVER break a send or a callback: every method
// swallows its own errors and the send path treats a write failure as "no
// confirmation available", which is exactly the state it was in before.
//
// ── PII ─────────────────────────────────────────────────────────────────────
//
// No message body and no raw phone number is stored — only the SID, the
// correlation ids, the salted `phone_hash` (hashPhone, the same value the send
// logs carry) and Twilio's own status/error codes.

import { Pool } from "pg";
import { logger } from "../lib/logger.js";

/** Minimal structural Postgres surface — pg.Pool satisfies it (turn-trace-writer idiom). */
export interface DeliveryStorePool {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
}

// ── Twilio message status vocabulary ────────────────────────────────────────

/**
 * Twilio's `MessageStatus` values, ranked by lifecycle progress. The rank is
 * the out-of-order defence: Twilio's status callbacks are independent HTTP
 * POSTs with no ordering guarantee, so a `sent` callback can land AFTER the
 * `delivered` one. A status is applied only when it RANKS STRICTLY HIGHER than
 * the one already stored, so a terminal status is never walked backwards.
 *
 * The failure statuses outrank every success status deliberately: if Twilio
 * ever reports a failure after a delivery, the failure is the operator-relevant
 * fact and must win.
 *
 * The keys are the ONLY strings ever interpolated into the rank CASE below, and
 * they are compile-time constants matched against a lowercase [a-z] shape —
 * there is no injection surface (pinned by a test).
 */
export const WHATSAPP_STATUS_RANK: Readonly<Record<string, number>> = Object.freeze({
  queued: 1,
  accepted: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  canceled: 6,
  undelivered: 6,
  failed: 6,
});

/** Statuses after which nothing further is expected (the workbench's verdict). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "delivered",
  "read",
  "canceled",
  "undelivered",
  "failed",
]);

/** Statuses that mean the reply did NOT reach the customer. Exported so the
 *  undelivered query surface (qa-rca.ts) binds the SAME vocabulary rather than
 *  hardcoding a second copy that could drift. */
export const FAILED_WHATSAPP_STATUSES: ReadonlyArray<string> = Object.freeze([
  "failed",
  "undelivered",
  "canceled",
]);

const FAILED_STATUSES: ReadonlySet<string> = new Set(FAILED_WHATSAPP_STATUSES);

export function isTerminalWhatsAppStatus(status: string | null): boolean {
  return status !== null && TERMINAL_STATUSES.has(status);
}

export function isFailedWhatsAppStatus(status: string | null): boolean {
  return status !== null && FAILED_STATUSES.has(status);
}

/** Normalize a raw callback `MessageStatus` to a known rank key, else null. */
export function normalizeWhatsAppStatus(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(WHATSAPP_STATUS_RANK, s) ? s : null;
}

export function whatsAppStatusRank(status: string | null): number {
  if (status === null) return 0;
  return WHATSAPP_STATUS_RANK[status] ?? 0;
}

/**
 * SQL expression yielding the rank of the row's CURRENTLY STORED status.
 * Generated from WHATSAPP_STATUS_RANK so the ordering has exactly one source of
 * truth — a new status added to the map is honoured by the UPDATE for free.
 */
const STORED_RANK_SQL = `CASE status ${Object.entries(WHATSAPP_STATUS_RANK)
  .map(([s, r]) => `WHEN '${s}' THEN ${r}`)
  .join(" ")} ELSE 0 END`;

// ── DDL (writer-owned, llm_wire precedent) ──────────────────────────────────

const WHATSAPP_DELIVERY_DDL = `
CREATE TABLE IF NOT EXISTS whatsapp_delivery (
  message_sid     TEXT PRIMARY KEY,
  turn_id         TEXT,
  conversation_id TEXT,
  part_index      INTEGER NOT NULL DEFAULT 0,
  phone_hash      TEXT,
  source          TEXT,
  sent_at         TIMESTAMPTZ NOT NULL,
  status          TEXT,
  status_at       TIMESTAMPTZ,
  error_code      TEXT,
  error_message   TEXT,
  callback_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS whatsapp_delivery_turn_idx ON whatsapp_delivery (turn_id, part_index);
CREATE INDEX IF NOT EXISTS whatsapp_delivery_status_idx ON whatsapp_delivery (status, sent_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_delivery_sent_idx ON whatsapp_delivery (sent_at DESC);
`;

// ── Module-singleton pool (prompt-overrides.ts idiom) ───────────────────────
//
// The send path lives outside the claustrum bootstrap composition root and
// cannot reach its pgPool without an import cycle, so this store owns a lazy
// pool of its own — the same shape prompt-overrides.ts and qa-rca.ts already
// use. Hard Rule #3: connection config from env only.

let pool: Pool | null = null;

function getPool(): DeliveryStorePool {
  if (pool === null) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // A pg Pool emits 'error' when an IDLE client's backend dies (a server
    // restart in prod, or a test harness stopping its postgres container). With
    // no listener node-pg re-throws it as an UNHANDLED error. This store is
    // best-effort; an idle-connection loss is recoverable.
    pool.on("error", (err) => {
      logger.warn(
        { component: "whatsapp-delivery", err: (err as Error).message },
        "whatsapp_delivery pool idle-client error (recoverable; ignored)",
      );
    });
  }
  return pool;
}

/** Test seam — inject a fake pool (and bypass the lazy pg Pool entirely). */
let injectedPool: DeliveryStorePool | null = null;
export function __setDeliveryStorePoolForTests(p: DeliveryStorePool | null): void {
  injectedPool = p;
}

/**
 * The pool to use, or null when there is no store to write to.
 *
 * NULL when `DATABASE_URL` is unset: node-pg would otherwise silently fall back
 * to libpq defaults and dial localhost, turning "no database configured" into a
 * connection attempt on every send. apps/api's own config schema makes
 * DATABASE_URL REQUIRED (config.ts), so this branch never fires in a real API
 * process — it only keeps unit tests (and any DB-less tool importing the send
 * path) from touching the network.
 */
function db(): DeliveryStorePool | null {
  if (injectedPool !== null) return injectedPool;
  if (!process.env.DATABASE_URL) return null;
  return getPool();
}

/** End the module-singleton pool (test cleanup / `resetClaustrumForTests()`).
 *  Best-effort + idempotent; the pool re-creates lazily on the next call. */
export async function closeWhatsAppDeliveryPool(): Promise<void> {
  if (pool !== null) {
    const p = pool;
    pool = null;
    await p.end().catch(() => undefined);
  }
}

/** Create the table if absent (idempotent). Best-effort — a DDL failure
 *  degrades delivery confirmation to "unknown", never blocks boot. */
export async function ensureWhatsAppDeliveryTable(): Promise<void> {
  const p = db();
  if (p === null) return;
  try {
    await p.query(WHATSAPP_DELIVERY_DDL);
  } catch (err) {
    logger.warn(
      { component: "whatsapp-delivery", err: (err as Error).message },
      "whatsapp_delivery ensureTable failed (swallowed — delivery tracking is best-effort)",
    );
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** One outbound reply part, recorded at send time. */
export interface OutboundSidRecord {
  readonly messageSid: string;
  /** `capsule.turnId` — null for sends with no conductor turn (jobs, alerts). */
  readonly turnId?: string | null;
  readonly conversationId?: string | null;
  /** Index of this part within the logical reply (splitForWhatsApp). */
  readonly partIndex: number;
  readonly phoneHash?: string | null;
  /** Call-site tag: "send" (text) | "sendMedia". */
  readonly source?: string | null;
  /** ISO timestamp of the accepted send. */
  readonly sentAt: string;
}

/**
 * Persist the SID of one accepted outbound part. Never throws.
 *
 * ON CONFLICT DO NOTHING: the SID is Twilio-unique, so a conflict can only mean
 * a redelivery of the same logical send — the FIRST row wins and any status
 * already folded onto it by a callback is preserved (an upsert would reset it).
 */
export async function recordOutboundSid(record: OutboundSidRecord): Promise<void> {
  const p = db();
  if (p === null) return;
  try {
    await p.query(
      `INSERT INTO whatsapp_delivery
         (message_sid, turn_id, conversation_id, part_index, phone_hash, source, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (message_sid) DO NOTHING`,
      [
        record.messageSid,
        record.turnId ?? null,
        record.conversationId ?? null,
        record.partIndex,
        record.phoneHash ?? null,
        record.source ?? null,
        record.sentAt,
      ],
    );
  } catch (err) {
    logger.warn(
      { component: "whatsapp-delivery", err: (err as Error).message },
      "whatsapp_delivery SID write failed (swallowed — telemetry must never break a send)",
    );
  }
}

/** One ingested Twilio delivery-status callback. */
export interface DeliveryStatusUpdate {
  readonly messageSid: string;
  /** A normalized status (normalizeWhatsAppStatus) — callers reject unknowns. */
  readonly status: string;
  /** ISO timestamp the callback was ingested. */
  readonly at: string;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

/**
 * Outcome of folding a callback onto its row:
 *   applied  — the store now reflects this status (it advanced the lifecycle,
 *              or already held it because Twilio re-sent the same callback)
 *   stale    — the SID is known but a HIGHER-ranked status was retained: an
 *              out-of-order callback (`sent` arriving after `delivered`). The
 *              terminal status stands; only `callback_count` moves.
 *   unknown  — no row carries this SID (never sent by us / row aged out)
 *   error    — the store was unreachable
 */
export type DeliveryStatusOutcome = "applied" | "stale" | "unknown" | "error";

/**
 * Fold a delivery-status callback onto its send row, correlated by SID.
 *
 * ONE atomic statement, no read-modify-write: the rank comparison happens
 * server-side inside the UPDATE, so concurrent callbacks for the same SID
 * cannot interleave into a lost update. `callback_count` always increments (so
 * a stale callback is still evidence the hop reported), while the status fields
 * only move forward.
 *
 * Never throws.
 */
export async function recordDeliveryStatus(
  update: DeliveryStatusUpdate,
): Promise<DeliveryStatusOutcome> {
  const rank = whatsAppStatusRank(update.status);
  const p = db();
  if (p === null) return "error";
  try {
    const res = (await p.query(
      `UPDATE whatsapp_delivery SET
         callback_count = callback_count + 1,
         status        = CASE WHEN $2 > (${STORED_RANK_SQL}) THEN $3 ELSE status END,
         status_at     = CASE WHEN $2 > (${STORED_RANK_SQL}) THEN $4::timestamptz ELSE status_at END,
         error_code    = CASE WHEN $2 > (${STORED_RANK_SQL}) THEN $5 ELSE error_code END,
         error_message = CASE WHEN $2 > (${STORED_RANK_SQL}) THEN $6 ELSE error_message END
       WHERE message_sid = $1
       RETURNING status`,
      [
        update.messageSid,
        rank,
        update.status,
        update.at,
        update.errorCode ?? null,
        update.errorMessage ?? null,
      ],
    )) as { rowCount?: number; rows?: Array<{ status?: string | null }> };

    const matched = res.rowCount ?? res.rows?.length ?? 0;
    if (matched === 0) return "unknown";
    // RETURNING carries the POST-update status. It equals ours when the CASE
    // branch fired (the advance) or when the row already held it (a Twilio
    // re-send) — both mean the store reflects this status. Anything else means
    // a higher-ranked status was retained: the out-of-order case.
    const stored = res.rows?.[0]?.status ?? null;
    return stored === update.status ? "applied" : "stale";
  } catch (err) {
    logger.warn(
      { component: "whatsapp-delivery", err: (err as Error).message },
      "whatsapp_delivery status write failed (swallowed — callback ingest is best-effort)",
    );
    return "error";
  }
}
