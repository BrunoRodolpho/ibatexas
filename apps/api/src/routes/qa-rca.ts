// RCA read routes (dev-only) — the live-data half of the qa-viewer's
// "Turn forensics" workbench. Server-side reimplementation of the ibx-rca
// skill's ibx-trace-turn.sh: merge [LLM] turn_trace + [ADJ] intent_audit +
// [VL] VictoriaLogs for one turn, and list conversations/turns to navigate to.
//
// READ-ONLY + DEV-ONLY: these routes are registered INSIDE qaControlRoutes,
// AFTER its qaControlGate() early-return + timing-safe Bearer preHandler, so
// they self-disable in production and require the bearer exactly like the rest
// of /internal/qa/*. They only SELECT; no mutation, no write path.
//
// The completion column is already redacted at write (turn-trace-writer.ts), so
// serving it to the viewer is safe. VictoriaLogs / intent_audit reads are
// fail-safe: an outage degrades the affected lane to empty rather than 500-ing
// the whole turn view.

import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { logger } from "../lib/logger.js";

// Dedicated lazy read pool (own connection, not the bootstrap writer pool — the
// RCA surface is dev-only and strictly read-only). connectionString mirrors
// claustrum-bootstrap.ts:2459. Hard Rule #3: config from env only.
let readPool: Pool | null = null;
function pool(): Pool {
  if (readPool === null) {
    readPool = new Pool({ connectionString: process.env.DATABASE_URL });
    // A pg Pool emits 'error' when an IDLE client's backend dies (a server restart
    // in prod, or the bootstrap-harness stopping its postgres container mid-run in
    // tests). With no listener node-pg re-throws it as an UNHANDLED error that fails
    // the vitest run — the 57P01 "terminating connection due to administrator
    // command" teardown race (same class fixed for prompt-overrides.ts's twin pool).
    // This RCA surface is dev-only + read-only; an idle-connection loss is
    // recoverable — the pool reconnects on next use.
    readPool.on("error", (err) => {
      logger.warn(
        { component: "qa-rca", err: (err as Error).message },
        "qa-rca read pool idle-client error (recoverable; ignored)",
      );
    });
  }
  return readPool;
}

/** End the module-singleton read pool (test cleanup: `resetClaustrumForTests()`
 *  calls this so a bootstrap-harness leaves no open pg handle when its container
 *  stops). Best-effort + idempotent; the pool re-creates lazily on next use. */
export async function closeRcaReadPool(): Promise<void> {
  if (readPool !== null) {
    const p = readPool;
    readPool = null;
    await p.end().catch(() => undefined);
  }
}

const VICTORIALOGS_URL = process.env.VICTORIALOGS_URL ?? "http://localhost:9428";

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

// ── coercers ────────────────────────────────────────────────────────────────

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

// Safe id charset for path params (UUID / nonce forms: alnum, dash, underscore,
// colon, dot). Bound params make injection impossible regardless; this just
// rejects obviously-hostile shapes early and keeps LIKE clean.
const SAFE_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const WINDOW_RE = /^\d+[smhd]$/;

// ── VictoriaLogs mirror (apps/api cannot import @ibatexas/cli) ──────────────

interface VlRaw {
  _time?: string;
  _msg?: string;
  level?: number | string;
  component?: string;
  [k: string]: unknown;
}

async function queryVl(query: string, limit: number): Promise<VlRaw[]> {
  const url = `${stripTrailingSlashes(VICTORIALOGS_URL)}/select/logsql/query`;
  const body = new URLSearchParams({ query, limit: String(limit) });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`VictoriaLogs HTTP ${res.status}`);
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as VlRaw)
    .reverse(); // VictoriaLogs returns newest-first; show oldest-first
}

// ── routes ──────────────────────────────────────────────────────────────────

/** Register the read-only RCA routes. Call from inside qaControlRoutes, after
 *  the gate early-return + Bearer preHandler. */
export function registerRcaReadRoutes(server: FastifyInstance): void {
  // Rate-limit binding for every route below (global @fastify/rate-limit honours
  // this per-route `config.rateLimit`; registerRateLimit in server.ts). Declared
  // as a LOCAL literal — not a passed parameter — so CodeQL's js/missing-rate-limiting
  // can resolve `config.rateLimit` through dataflow and credit the guard (a param
  // is opaque to it, which is why only these DB-read routes alerted while the
  // sibling qa-control/qa-prompts routes, fed a local const, did not). Same window
  // as qa-control.ts's shared RL — a generous single-operator dev surface.
  const RL = {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  } as const;
  // ── conversations picker ──────────────────────────────────────────────────
  server.get<{ Querystring: { limit?: string; q?: string } }>(
    "/internal/qa/rca/conversations",
    RL,
    async (request) => {
      const limit = Math.min(Math.max(num(request.query.limit) ?? 40, 1), 200);
      const q = typeof request.query.q === "string" ? request.query.q.slice(0, 120) : "";
      const params: unknown[] = [];
      let where = "";
      if (q.length > 0) {
        params.push(`%${q}%`);
        where = `WHERE t.conversation_id ILIKE $1`;
      }
      params.push(limit);
      const { rows } = await pool().query(
        `SELECT t.conversation_id AS session_id, max(t.recorded_at) AS last_at,
                count(DISTINCT t.turn_id) AS turns
         FROM turn_trace t ${where}
         GROUP BY t.conversation_id
         ORDER BY last_at DESC
         LIMIT $${params.length}`,
        params,
      );

      // Best-effort enrichment: channel + chat cuid from the domain schema.
      const meta = new Map<string, { channel: string | null; chatCuid: string | null }>();
      const ids = rows.map((r) => str((r as Record<string, unknown>).session_id)).filter((v): v is string => v !== null);
      if (ids.length > 0) {
        try {
          const enr = await pool().query(
            `SELECT session_id, id AS chat_cuid, channel FROM ibx_domain.conversations WHERE session_id = ANY($1)`,
            [ids],
          );
          for (const r of enr.rows as Array<Record<string, unknown>>) {
            const sid = str(r.session_id);
            if (sid !== null) meta.set(sid, { channel: str(r.channel), chatCuid: str(r.chat_cuid) });
          }
        } catch (err) {
          logger.warn({ component: "qa-rca", err: (err as Error).message }, "conversation enrichment skipped");
        }
      }

      return {
        conversations: rows.map((r) => {
          const row = r as Record<string, unknown>;
          const sid = str(row.session_id) ?? "";
          const m = meta.get(sid);
          return {
            sessionId: sid,
            chatCuid: m?.chatCuid ?? null,
            channel: m?.channel ?? "unknown",
            startedAt: iso(row.last_at),
            lastText: null,
            turnCount: num(row.turns) ?? 0,
          };
        }),
      };
    },
  );

  // ── turns of one conversation ─────────────────────────────────────────────
  server.get<{ Params: { conv: string } }>(
    "/internal/qa/rca/conversations/:conv/turns",
    RL,
    async (request, reply) => {
      const conv = request.params.conv;
      if (!SAFE_ID.test(conv)) return reply.code(400).send({ error: "invalid conversation id" });
      const { rows } = await pool().query(
        `SELECT turn_id, min(recorded_at) AS started_at, count(*) AS calls,
                bool_or(prompt_manifest->>0 LIKE 'ibatexas/responder%' AND output_tokens = 0) AS responder_empty
         FROM turn_trace WHERE conversation_id = $1
         GROUP BY turn_id ORDER BY started_at DESC LIMIT 200`,
        [conv],
      );
      return {
        turns: rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            turnId: str(row.turn_id) ?? "",
            startedAt: iso(row.started_at),
            callCount: num(row.calls) ?? 0,
            decision: null as string | null,
            userText: null as string | null,
            hadSend: false,
            responderEmpty: row.responder_empty === true,
          };
        }),
      };
    },
  );

  // ── THE merged turn view ──────────────────────────────────────────────────
  server.get<{ Params: { turnId: string }; Querystring: { window?: string } }>(
    "/internal/qa/rca/turns/:turnId",
    RL,
    async (request, reply) => {
      const turnId = request.params.turnId;
      if (!SAFE_ID.test(turnId)) return reply.code(400).send({ error: "invalid turn id" });
      const window = WINDOW_RE.test(request.query.window ?? "") ? (request.query.window as string) : "24h";

      // 1) resolve conversation + span from turn_trace (the only plaintext key).
      const head = await pool().query(
        `SELECT conversation_id, min(recorded_at) AS started_at, max(recorded_at) AS ended_at
         FROM turn_trace WHERE turn_id = $1 GROUP BY conversation_id LIMIT 1`,
        [turnId],
      );
      const h = (head.rows[0] ?? {}) as Record<string, unknown>;
      const conv = str(h.conversation_id);
      const startedAt = iso(h.started_at);
      const endedAt = iso(h.ended_at);

      // 2) [LLM] the model calls of this turn.
      const llmRes = await pool().query(
        `SELECT call_index, prompt_manifest->>0 AS prompt0, model, input_tokens,
                output_tokens, completion, duration_ms, recorded_at
         FROM turn_trace WHERE turn_id = $1 ORDER BY call_index, recorded_at`,
        [turnId],
      );
      const llm = llmRes.rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          callIndex: num(row.call_index) ?? 0,
          persona: str(row.prompt0),
          model: str(row.model),
          inputTokens: num(row.input_tokens),
          outputTokens: num(row.output_tokens),
          durationMs: num(row.duration_ms),
          completion: str(row.completion),
          recordedAt: iso(row.recorded_at),
        };
      });

      // 3) [ADJ] kernel decisions — bridge by nonce prefix, NOT session_id
      //    (session_id is hashed by the audit redactor). Fail-safe to empty.
      let adj: Array<Record<string, unknown>> = [];
      if (conv !== null) {
        try {
          const adjRes = await pool().query(
            `SELECT recorded_at, kind, decision_kind, refusal_code, taint, session_id
             FROM intent_audit WHERE nonce LIKE $1 ORDER BY recorded_at`,
            [`${conv}:%`],
          );
          adj = adjRes.rows as Array<Record<string, unknown>>;
        } catch (err) {
          logger.warn({ component: "qa-rca", err: (err as Error).message }, "[ADJ] read degraded to empty");
        }
      }

      // 4) [VL] pino logs by correlationId (== turnId). Fail-safe to empty.
      let vl: VlRaw[] = [];
      try {
        vl = await queryVl(`_time:${window} correlationId:=${JSON.stringify(turnId)}`, 500);
      } catch (err) {
        logger.warn({ component: "qa-rca", err: (err as Error).message }, "[VL] read degraded to empty");
      }

      // context enrichment (display-only; hashed ids never join)
      let channel: string | null = null;
      let chatCuid: string | null = null;
      let phoneHash: string | null = null;
      if (conv !== null) {
        try {
          const c = await pool().query(
            `SELECT id AS chat_cuid, channel, phone_hash FROM ibx_domain.conversations WHERE session_id = $1 LIMIT 1`,
            [conv],
          );
          const cr = (c.rows[0] ?? {}) as Record<string, unknown>;
          channel = str(cr.channel);
          chatCuid = str(cr.chat_cuid);
          phoneHash = str(cr.phone_hash);
        } catch {
          /* domain schema optional — display fields stay null */
        }
      }
      const sessionHashed = str((adj[0] ?? {}).session_id) ?? null;

      const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
      const endMs = endedAt ? Date.parse(endedAt) : Number.NaN;

      return {
        turn: {
          context: {
            turnId,
            conversationId: conv,
            noncePrefix: conv !== null ? `${conv}:` : null,
            chatCuid,
            phoneHash,
            sessionHashed,
            channel,
            startedAt,
            endedAt,
            durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null,
          },
          llm,
          adj: adj.map((row) => ({
            recordedAt: iso(row.recorded_at),
            kind: str(row.kind),
            decisionKind: str(row.decision_kind),
            refusalCode: str(row.refusal_code),
            taint: str(row.taint),
          })),
          vl: vl.map((l) => ({
            time: iso(l._time),
            level: l.level == null ? null : String(l.level),
            component: str(l.component),
            msg: str(l._msg),
          })),
        },
      };
    },
  );
}
