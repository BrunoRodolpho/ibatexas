// Turn-trace writer (C2 — persist, REDACTED).
//
// The `turn_trace` store is the per-LLM-call record behind the adjudicate
// console "Turn trace" view: one row per planner/responder model call, grouped
// by `turnId`. It carries the content-addressed prompt manifest (id@hash), the
// (redacted) completion, tokens, and the correlation keys. It is the cross-repo
// contract the adjudicate `createPostgresTurnTraceStore` reads — so this writer
// is the producer (mirrors remediation-proposal-writer.ts; no @adjudicate dep).
//
// Placement: a plain shared table in the SAME database the console reads, named
// `turn_trace` (unqualified, like `intent_audit`) so the console reads it
// domain-agnostically. Retention is a raw row DELETE (retention-cleaner.ts) with
// its own TURN_TRACE_RETENTION_DAYS knob — NOT the shared RETENTION_DAYS.
//
// REDACTION (the load-bearing posture): the completion is FREE PROSE, so it is
// scrubbed through the ibatexas audit redactor's `redactPayload` (BR-PII regex
// defense — email/cpf/phone/card → sentinels — + 500-char truncation) BEFORE the
// row is written, plus a trace-local pass for the Brazilian CEP (postal code)
// shape (F4). The console only ever sees the redacted text.
//
// ACCEPTED RESIDUAL RISK (F4): a regex/field-oriented scrub cannot reliably
// catch a customer's NAME or full ADDRESS that a model echoes inline. This is
// mitigated by three compensating controls rather than a perfect scrubber:
//   (1) PREVENTION — the grounded responder persona instructs the model not to
//       repeat the customer's personal data verbatim (personas.ts, F4);
//   (2) DEFENSE-IN-DEPTH — this redaction pass (cpf/email/phone/card/CEP);
//   (3) MINIMIZATION — the trace has a bounded default retention so any residual
//       miss ages out (retention-cleaner TURN_TRACE_RETENTION_DAYS default, F3),
//       and per-subject LGPD erasure deletes it on request (customer.service).
// The manifest is just ids/hashes (no redaction needed).
//
// Best-effort + fail-open: telemetry must NEVER break a turn — every method
// swallows its errors.

import { createAuditRedactor } from "@ibatexas/audit-sink";
import { logger } from "../lib/logger.js";

// F4 defense-in-depth: the shared audit redactor covers cpf/email/phone/card.
// Add a trace-local pass for the Brazilian CEP (postal code) shape — the most
// regexable component of an address, which the base PII set does not cover. The
// dashed form (NNNNN-NNN) is high-precision (bare 8-digit runs are too ambiguous
// to redact safely in an observability trace).
const CEP_RE = /\b\d{5}-\d{3}\b/g;

/** Minimal structural Postgres surface — pg.Pool satisfies it. */
export interface TurnTraceWriterPool {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
}

/** One persisted LLM-call trace (producer-side shape). */
export interface TurnTraceRecord {
  readonly turnId: string;
  readonly callIndex: number;
  readonly conversationId: string;
  readonly intentHash?: string;
  readonly model: string;
  readonly temperature: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Content-addressed fragment manifest (id@hash entries). */
  readonly promptManifest: ReadonlyArray<string>;
  /** Raw model completion — REDACTED by the writer before persistence. */
  readonly completion: string;
  readonly durationMs: number;
  /** ISO timestamp (the LLMTrace.at). */
  readonly recordedAt: string;
  readonly schemaVersion?: number;
  /**
   * LE2-014 — the `@ibatexas/catalog` `CATALOG_VERSION` this turn ran under
   * (the replay enabler: with the prompt manifest and the durable wire
   * capture, a historical turn is re-runnable against exactly the catalog it
   * saw).
   *
   * Stamped ONCE PER TURN at the flush seam (`flushTurnTraces` in
   * `claustrum-bootstrap.ts`) and repeated onto every row the turn writes —
   * the same shape `conversationId` already has, and the only shape available:
   * `turn_trace` is one row per model call with no per-turn root row.
   *
   * Optional, exactly like `schemaVersion`: a row written by a path that does
   * not resolve a catalog (or by an older writer) is NULL, never a fabricated
   * version. A wrong version is worse than an absent one — it would send a
   * replay at the wrong catalog.
   */
  readonly catalogVersion?: number;
}

const TURN_TRACE_DDL = `
  CREATE TABLE IF NOT EXISTS turn_trace (
    id              BIGSERIAL PRIMARY KEY,
    turn_id         TEXT NOT NULL,
    call_index      INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    intent_hash     TEXT,
    model           TEXT NOT NULL,
    temperature     DOUBLE PRECISION NOT NULL,
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    prompt_manifest JSONB NOT NULL,
    completion      TEXT NOT NULL,
    duration_ms     INTEGER NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL,
    schema_version  INTEGER,
    catalog_version INTEGER,
    UNIQUE (turn_id, call_index)
  );
  -- LE2-014: CREATE TABLE IF NOT EXISTS does NOT alter an existing table, so
  -- every database provisioned before this column existed would silently never
  -- get it — and the NULL would look like a writer bug rather than a missing
  -- migration. This ALTER is the idempotent catch-up. Additive and nullable, so
  -- the adjudicate console's generic reads (createPostgresTurnTraceStore, whose
  -- canonical migration is 011-create-turn-trace.sql in @adjudicate/audit-
  -- postgres) are unaffected: it selects named columns and never SELECT *.
  ALTER TABLE turn_trace ADD COLUMN IF NOT EXISTS catalog_version INTEGER;
  CREATE INDEX IF NOT EXISTS turn_trace_conversation_idx ON turn_trace(conversation_id, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS turn_trace_turn_idx ON turn_trace(turn_id, call_index);
  CREATE INDEX IF NOT EXISTS turn_trace_recorded_idx ON turn_trace(recorded_at);
`;

export interface TurnTraceWriter {
  /** Create the shared table if absent (idempotent). Call once at boot. */
  ensureTable(): Promise<void>;
  /** Redact + persist one LLM-call trace (best-effort; swallows errors). */
  write(record: TurnTraceRecord): Promise<void>;
  /** Redact a raw completion string (exposed for the redaction-proof test). */
  redactCompletion(completion: string): string;
  /** Delete rows older than the ISO cutoff; returns deleted count (retention). */
  purgeOlderThan(cutoffIso: string): Promise<number>;
}

export function createTurnTraceWriter(
  pool: TurnTraceWriterPool,
  opts: { readonly redactSecret?: string } = {},
): TurnTraceWriter {
  // The redactor's `redactPayload` walks any value; a top-level STRING gets the
  // free-prose scrub (BR-PII regex + truncation). hashSecret only matters for
  // hashed:* fields, which a bare string never produces — pass it for parity.
  const redactor = createAuditRedactor({
    hashSecret: opts.redactSecret ?? process.env.AUDIT_REDACT_SECRET ?? "",
  });

  function redactCompletion(completion: string): string {
    try {
      const scrubbed = redactor.redactPayload(completion);
      const base =
        typeof scrubbed === "string" ? scrubbed : JSON.stringify(scrubbed);
      // F4: trace-local CEP pass on top of the shared cpf/email/phone/card scrub.
      return base.replace(CEP_RE, "[REDACTED:cep]");
    } catch {
      // If redaction itself fails, drop the completion rather than leak it.
      return "[REDACTED:unavailable]";
    }
  }

  return {
    async ensureTable() {
      try {
        await pool.query(TURN_TRACE_DDL);
      } catch (err) {
        logger.warn(
          { component: "turn-trace-writer", err: (err as Error).message },
          "turn_trace ensureTable failed (swallowed — tracing is best-effort)",
        );
      }
    },

    redactCompletion,

    async write(record) {
      try {
        await pool.query(
          // LE2-014: catalog_version is APPENDED LAST, both in the column list
          // and in the params array. The positional contract matters — the
          // redaction proof in `__tests__/turn-trace.test.ts` asserts on
          // `params[9]` being the completion. Insert a column mid-list and that
          // proof silently starts checking the wrong value.
          `INSERT INTO turn_trace
             (turn_id, call_index, conversation_id, intent_hash, model,
              temperature, input_tokens, output_tokens, prompt_manifest,
              completion, duration_ms, recorded_at, schema_version,
              catalog_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)
           ON CONFLICT (turn_id, call_index) DO UPDATE SET
             completion = EXCLUDED.completion,
             prompt_manifest = EXCLUDED.prompt_manifest,
             input_tokens = EXCLUDED.input_tokens,
             output_tokens = EXCLUDED.output_tokens`,
          [
            record.turnId,
            record.callIndex,
            record.conversationId,
            record.intentHash ?? null,
            record.model,
            record.temperature,
            record.inputTokens,
            record.outputTokens,
            JSON.stringify(record.promptManifest),
            redactCompletion(record.completion),
            record.durationMs,
            record.recordedAt,
            record.schemaVersion ?? null,
            record.catalogVersion ?? null,
          ],
        );
      } catch (err) {
        logger.warn(
          {
            component: "turn-trace-writer",
            turnId: record.turnId,
            callIndex: record.callIndex,
            err: (err as Error).message,
          },
          "turn_trace write failed (swallowed — telemetry must never break a turn)",
        );
      }
    },

    async purgeOlderThan(cutoffIso) {
      try {
        const res = (await pool.query(
          `DELETE FROM turn_trace WHERE recorded_at < $1`,
          [cutoffIso],
        )) as { rowCount?: number };
        return res.rowCount ?? 0;
      } catch (err) {
        logger.warn(
          { component: "turn-trace-writer", err: (err as Error).message },
          "turn_trace purge failed (swallowed)",
        );
        return 0;
      }
    },
  };
}
