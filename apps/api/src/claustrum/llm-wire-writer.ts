/**
 * Wire Truth — the durable `llm_wire` store (spec: ~/projects/IBX_WIRE_TRUTH_SPEC.md).
 *
 * One row per wire ATTEMPT: a regenerate-on-empty retry loop yields several
 * rows sharing a `call_index` (the turn_trace row they render into) across
 * ascending `seq` (capture order within the turn). `request_jsonb` is the
 * relay's exact outbound body — captured POST-enrichment at the fetch
 * boundary, so it is byte-faithful to what hit the model — and
 * `response_jsonb` is the raw provider body the frozen provider would
 * otherwise discard (including the `reasoning` channel).
 *
 * Redaction (review-hardened): EVERY message content — system included — and
 * every response string leaf run through the SAME PII regex/sentinel family
 * the audit ledger uses (@ibatexas/pii + the turn-trace CEP pass) — but
 * WITHOUT the audit redactor's 500-char string cap, which would gut "full raw
 * response" (a reasoning field runs KBs). Size safety comes from the honest
 * WIRE_BODY_MAX_BYTES marker instead. The system message is NOT exempt
 * because on the ops plane it embeds the raw staff conversation history
 * (composeOpsPlannerSystem appends the Gerente:/Agente: lines) — an
 * operator-typed CPF from turn 1 resurfaces inside turn 2's system prompt.
 * Persona prose contains no PII shapes, so scrubbing costs nothing there.
 * Tool schemas and sampling params stay verbatim — they ARE the debugging
 * payload and carry no customer data.
 *
 * DDL note: turn_trace's canonical migration lives in the FROZEN
 * @adjudicate/audit-postgres package; llm_wire is an in-repo concern, so it
 * follows the writer-owned `ensureTable` precedent (CREATE IF NOT EXISTS at
 * boot) and is pinned in packages/cli's KERNEL_TABLES registry so
 * `ibx db clean` truncates it.
 *
 * Fail-open everywhere: capture must never break a turn.
 */

import { CARD_RE, CPF_RE, EMAIL_RE, PHONE_RE, PII_SENTINELS } from "@ibatexas/pii";
import { logger } from "../lib/logger.js";
import { capJsonBody, claimWireExchanges, type WireExchange } from "./wire-capture.js";

/** Same trace-local CEP pass turn-trace-writer applies to completions. */
const CEP_RE = /\b\d{5}-\d{3}\b/g;

export interface LlmWireWriterPool {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const LLM_WIRE_DDL = `
CREATE TABLE IF NOT EXISTS llm_wire (
  id BIGSERIAL PRIMARY KEY,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  call_index INTEGER,
  conversation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  request_jsonb JSONB NOT NULL,
  response_jsonb JSONB,
  request_hash TEXT NOT NULL,
  request_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  response_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (turn_id, seq)
);
CREATE INDEX IF NOT EXISTS llm_wire_turn_idx ON llm_wire (turn_id, seq);
CREATE INDEX IF NOT EXISTS llm_wire_recorded_idx ON llm_wire (recorded_at);
`;

/** PII scrub, redactor-family regexes, NO length cap (see header). */
export function scrubWireText(s: string): string {
  return s
    .replace(EMAIL_RE, PII_SENTINELS.EMAIL)
    .replace(CPF_RE, PII_SENTINELS.CPF)
    .replace(PHONE_RE, PII_SENTINELS.PHONE)
    .replace(CARD_RE, PII_SENTINELS.CARD)
    .replace(CEP_RE, "[REDACTED:cep]");
}

function scrubAllStrings(value: unknown): unknown {
  if (typeof value === "string") return scrubWireText(value);
  if (Array.isArray(value)) return value.map(scrubAllStrings);
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return Object.keys(rec).reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = scrubAllStrings(rec[k]);
      return acc;
    }, {});
  }
  return value;
}

/** Redact an OpenAI-shaped wire REQUEST: EVERY message content scrubbed
 *  (system included — see header: the ops system embeds raw staff history);
 *  tool schemas and sampling params verbatim. */
export function redactWireRequest(request: unknown): unknown {
  if (request === null || typeof request !== "object") return request;
  const rec = request as Record<string, unknown>;
  const messages = rec.messages;
  if (!Array.isArray(messages)) return request;
  return {
    ...rec,
    messages: messages.map((m: unknown) => {
      if (m === null || typeof m !== "object") return m;
      const msg = m as Record<string, unknown>;
      return typeof msg.content === "string" ? { ...msg, content: scrubWireText(msg.content) } : msg;
    }),
  };
}

/** Redact a raw provider RESPONSE: every string leaf scrubbed (model output
 *  can echo anything the user typed). */
export function redactWireResponse(response: unknown): unknown {
  return scrubAllStrings(response);
}

export interface LlmWireWriter {
  ensureTable(): Promise<void>;
  writeExchanges(turnId: string, conversationId: string, exchanges: WireExchange[]): Promise<void>;
}

export function createLlmWireWriter(pool: LlmWireWriterPool): LlmWireWriter {
  return {
    async ensureTable(): Promise<void> {
      try {
        await pool.query(LLM_WIRE_DDL);
      } catch (err) {
        logger.warn(
          { component: "llm-wire", err: (err as Error).message },
          "llm_wire ensureTable failed (swallowed — capture must never break boot)",
        );
      }
    },

    async writeExchanges(
      turnId: string,
      conversationId: string,
      exchanges: WireExchange[],
    ): Promise<void> {
      for (const x of exchanges) {
        try {
          const request = capJsonBody(redactWireRequest(x.request));
          const response = capJsonBody(redactWireResponse(x.response));
          await pool.query(
            `INSERT INTO llm_wire (turn_id, seq, call_index, conversation_id, model,
                                   request_jsonb, response_jsonb, request_hash,
                                   request_truncated, response_truncated, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
             ON CONFLICT (turn_id, seq) DO NOTHING`,
            [
              turnId,
              x.seq,
              x.callIndex,
              conversationId,
              x.model,
              JSON.stringify(request.value),
              JSON.stringify(response.value),
              x.requestHash,
              request.truncated,
              response.truncated,
              x.at,
            ],
          );
        } catch (err) {
          logger.warn(
            { component: "llm-wire", err: (err as Error).message },
            "llm_wire write failed (swallowed — telemetry must never break a turn)",
          );
        }
      }
    },
  };
}

/** Flush-time entry: claim the turn's sealed exchanges and persist them.
 *  Called by the turn-trace flush alongside the trace writes. Never throws. */
export async function flushWireExchanges(
  writer: LlmWireWriter,
  turnId: string,
  conversationId: string,
): Promise<void> {
  try {
    const exchanges = claimWireExchanges(turnId);
    if (exchanges.length === 0) return;
    await writer.writeExchanges(turnId, conversationId, exchanges);
  } catch (err) {
    logger.warn(
      { component: "llm-wire", err: (err as Error).message },
      "llm_wire flush failed (swallowed)",
    );
  }
}
