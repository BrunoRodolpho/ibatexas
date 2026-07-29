// RCA read routes (dev-only) — the live-data half of the qa-viewer's
// "Turn forensics" workbench. Server-side reimplementation of the ibx-rca
// skill's ibx-trace-turn.sh: merge [LLM] turn_trace + [ADJ] intent_audit +
// [VL] VictoriaLogs for one turn, and list conversations/turns to navigate to.
// Plus: find-by-text over the audit ledger's archived messages (the skill's
// ibx-find-msg.sh as a route, resolved to jumpable turns), a redacted
// per-conversation transcript, and a preflight status probe of all three
// stores (the skill's step-0 discipline as an endpoint).
//
// READ-ONLY + DEV-ONLY: these routes are registered INSIDE qaControlRoutes,
// AFTER its qaControlGate() early-return + timing-safe Bearer preHandler, so
// they self-disable in production and require the bearer exactly like the rest
// of /internal/qa/*. They only SELECT; no mutation, no write path.
//
// The completion column is already redacted at write (turn-trace-writer.ts), so
// serving it to the viewer is safe. Message text from ibx_domain.conversation_
// messages is NOT redacted at write — every content string served here passes
// through the SAME audit redactor (redactText below) before it leaves the API.
// VictoriaLogs / intent_audit reads are fail-safe: an outage degrades the
// affected lane to empty rather than 500-ing the whole turn view.
//
// THE ADJ BRIDGE (two arms, both needed — live-proven against dev data):
//   arm 1  nonce LIKE '<conversationUuid>:%'   — catches SYSTEM envelopes whose
//          deterministic nonce is conversation-prefixed (e.g. the archiver's
//          `${sessionId}:${sentAt}:${idx}` conversation.message.append rows).
//   arm 2  session_id = 'hashed:' + sha256(conversationId + AUDIT_REDACT_SECRET)[0..8]
//          — the audit redactor's own hash (audit-redactor.ts hashValue),
//          recomputed here server-side. This catches the envelopes that MATTER
//          (order.item.add / payment.refund.issue / order.cancel …): customer-
//          plane envelopes stamp actor.sessionId = conversationId and ops-plane
//          envelopes stamp `admin:<staffId>` (== turn_trace.conversation_id),
//          but their nonces are bare messageIds/UUIDs the LIKE arm never sees.
// Both arms are additionally scoped to the turn's [start-10s, end+45s] span so
// a multi-turn conversation no longer bleeds every decision into every turn.

import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { createAuditRedactor } from "@ibatexas/audit-sink";
import { logger } from "../lib/logger.js";
// LE2-030 — one vocabulary for "this reply did not land", shared with the writer.
import { FAILED_WHATSAPP_STATUSES } from "../whatsapp/delivery-store.js";
// LE2-031 — the rail reads as customers, not kernel sessions. The identity
// ladder + ordering live in a pure module so they are unit-pinnable.
import { groupConversationsByCustomer } from "./qa-rca-grouping.js";
// RCA-legibility (spans route) — the PURE span classifiers, replayed server-side
// on a turn's archived inbound text. First ../claustrum/ imports in this file:
// both modules are pure data + functions (no I/O, no env, no model), so the
// dev-route module graph widens without any boot-order or side-effect hazard.
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
} from "../claustrum/required-claim-decomposer.js";
import { classifyOnlyRequiredTypes } from "../claustrum/classify-only-reads.js";

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

// ── redaction + the ADJ session-hash bridge ─────────────────────────────────

// Lazy singleton — same construction as turn-trace-writer.ts (hashSecret only
// matters for hashed:* fields; free prose gets the BR-PII scrub + truncation).
let redactor: ReturnType<typeof createAuditRedactor> | null = null;
function redactText(text: string): string {
  if (redactor === null) {
    redactor = createAuditRedactor({
      hashSecret: process.env.AUDIT_REDACT_SECRET ?? "",
    });
  }
  try {
    const scrubbed = redactor.redactPayload(text);
    return typeof scrubbed === "string" ? scrubbed : JSON.stringify(scrubbed);
  } catch {
    return "[REDACTED:unavailable]";
  }
}

/** Recompute the audit redactor's session hash (audit-redactor.ts hashValue:
 *  `"hashed:" + sha256(value + secret).hex[0..8]`) for the ADJ bridge arm 2. */
function auditSessionHash(sessionId: string): string {
  const h = createHash("sha256");
  h.update(sessionId);
  h.update(process.env.AUDIT_REDACT_SECRET ?? "");
  return `hashed:${h.digest("hex").slice(0, 8)}`;
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
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Parse a `from`/`to` query value to a validated ISO string (else null). */
function isoParam(v: string | undefined): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Safe id charset for path params (UUID / nonce forms: alnum, dash, underscore,
// colon, dot). Bound params make injection impossible regardless; this just
// rejects obviously-hostile shapes early and keeps LIKE clean.
const SAFE_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const WINDOW_RE = /^\d+[smhd]$/;
const CHANNEL_RE = /^[a-z_,-]{1,60}$/;

/** Channel for display/filtering. The ops plane has no ibx_domain.conversations
 *  row — its turn_trace.conversation_id is `admin:<staffId>` — so synthesize
 *  "ops" instead of leaving it "unknown". */
function channelFor(sessionId: string, enriched: string | null): string {
  if (enriched !== null) return enriched;
  return sessionId.startsWith("admin:") ? "ops" : "unknown";
}

/** Most-governance-significant decision of a turn (for the turn-row chip):
 *  a REFUSE outranks the EXECUTEs around it. Archiver appends are excluded by
 *  the caller (kind = conversation.message.append is bookkeeping noise). */
const DECISION_SEVERITY = ["REFUSE", "ESCALATE", "REQUEST_CONFIRMATION", "DEFER", "REWRITE", "EXECUTE"] as const;
function pickDecision(kinds: ReadonlyArray<string>): string | null {
  for (const d of DECISION_SEVERITY) if (kinds.includes(d)) return d;
  return kinds.length > 0 ? kinds[kinds.length - 1]! : null;
}

// The ADJ span slack: a decision is recorded between the planner call and the
// responder call, but a turn whose LAST trace row is the planner (no responder)
// records its decision AFTER max(recorded_at) — hence the asymmetric window.
// Kept tight so back-to-back turns don't bleed decisions into each other.
const ADJ_SLACK_BEFORE = "5 seconds";
const ADJ_SLACK_AFTER = "20 seconds";

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

/** The turn's VL filter. Two fixes over the original `_time:24h correlationId:=`:
 *  (1) match `turnId` too — claims.terminal / claim_planner.* / reply.sent /
 *  empty_completion_retry bind `turnId`, only conductor lines bind
 *  `correlationId` (live-verified census); (2) anchor `_time` to the turn's own
 *  span (absolute range, ±5m) instead of a now-relative window, so a turn older
 *  than 24h no longer renders a silently-empty lane (which also fabricated
 *  false GAP ghosts). An explicit ?window= still overrides as a widener. */
function vlTurnQuery(turnId: string, startedAt: string | null, endedAt: string | null, window: string | null): string {
  const match = `(correlationId:=${JSON.stringify(turnId)} OR turnId:=${JSON.stringify(turnId)})`;
  if (window !== null) return `_time:${window} ${match}`;
  if (startedAt !== null) {
    const s = new Date(Date.parse(startedAt) - 5 * 60_000).toISOString();
    const e = new Date(Date.parse(endedAt ?? startedAt) + 5 * 60_000).toISOString();
    return `_time:[${s}, ${e}] ${match}`;
  }
  return `_time:24h ${match}`;
}

/** Structured VL fields worth carrying to the viewer beyond time/level/
 *  component/msg — the claims + delivery verdict fields (all emitted by our
 *  own signal-only telemetry; the msg text itself is already served raw). */
const VL_FIELD_ALLOWLIST = [
  "event",
  "decisionKind",
  "disposition",
  "posture",
  "kernelTerminal",
  "degradedFromRender",
  "renderedCount",
  "validatedTypes",
  "droppedClaimTypes",
  "candidateTypes",
  "deliveredText", // reply.sent's canonical delivered boolean (== textSent || pixDelivered)
  "textSent",
  "pixDelivered",
  "channel",
  "intentHash",
  "reason",
  "inbound", // conductor's 280-char REDACTED inbound text
  "response", // conductor's 280-char REDACTED reply text
  "errorCode",
  // RCA-legibility — reply-provenance fields: the precedence verdict
  // (claims.render_precedence), the safe-template identity
  // (claims.template_selected), the claim-planner walls
  // (claim_planner.proposal_summary / classify_only), and the funnel tier.
  "mechanism",
  "decision",
  "plane",
  "templateId",
  "terminal",
  "forcedTerminal",
  "suppressedTypes",
  "suppressionCount",
  "envelopeCount",
  "tier",
  "funnelTier",
  "funnelReason",
] as const;
function vlFields(l: VlRaw): Record<string, string> | null {
  let out: Record<string, string> | null = null;
  for (const k of VL_FIELD_ALLOWLIST) {
    const v = l[k];
    if (typeof v === "string" && v.length > 0) {
      out = out ?? {};
      out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out = out ?? {};
      out[k] = String(v);
    }
  }
  return out;
}

// ── preflight probe ─────────────────────────────────────────────────────────

interface StoreProbe {
  ok: boolean;
  latencyMs: number;
  error: string | null;
}

async function probeStore(fn: () => Promise<unknown>): Promise<StoreProbe> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - t0, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
  }
}

// ── LE2-031: the phone-hash identity lane ───────────────────────────────────

/** Best-effort salted phone hash per conversation — the fallback identity for a
 *  guest who never became a customer row. Two independent sources, because they
 *  cover each other's blind spot: `whatsapp_delivery` has a row whenever a reply
 *  was HANDED to Twilio (LE2-030), and `conversation_incidents` has one exactly
 *  when a reply never landed. Delivery wins on conflict (it is written at send,
 *  the incident lane is derived).
 *
 *  Each source degrades on its own — an absent table leaves those sessions
 *  without a hash, which lands them in the explicit "unidentified" bucket
 *  rather than 500-ing the rail. Same fail-safe posture as every other read
 *  here; the value is a hash, never a phone number. */
async function fetchPhoneHashes(ids: ReadonlyArray<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const read = async (sql: string, lane: string): Promise<Array<Record<string, unknown>>> => {
    try {
      return (await pool().query(sql, [ids])).rows as Array<Record<string, unknown>>;
    } catch (err) {
      logger.warn(
        { component: "qa-rca", lane, err: (err as Error).message },
        "phone-hash lane unavailable — sessions fall back to the unidentified bucket",
      );
      return [];
    }
  };
  const [incidents, deliveries] = await Promise.all([
    read(
      `SELECT DISTINCT ON (session_id) session_id AS conversation_id, phone_hash
       FROM ibx_domain.conversation_incidents
       WHERE session_id = ANY($1) AND phone_hash IS NOT NULL
       ORDER BY session_id, last_drop_at DESC`,
      "incidents",
    ),
    read(
      `SELECT DISTINCT ON (conversation_id) conversation_id, phone_hash
       FROM whatsapp_delivery
       WHERE conversation_id = ANY($1) AND phone_hash IS NOT NULL
       ORDER BY conversation_id, sent_at DESC`,
      "delivery",
    ),
  ]);
  // Delivery applied last so it wins on conflict.
  for (const r of [...incidents, ...deliveries]) {
    const conv = str(r.conversation_id);
    const hash = str(r.phone_hash);
    if (conv !== null && hash !== null && hash.length > 0) out.set(conv, hash);
  }
  return out;
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
  server.get<{
    Querystring: { limit?: string; q?: string; from?: string; to?: string; channel?: string };
  }>("/internal/qa/rca/conversations", RL, async (request) => {
    const limit = Math.min(Math.max(num(request.query.limit) ?? 40, 1), 200);
    const q = typeof request.query.q === "string" ? request.query.q.slice(0, 120) : "";
    const from = isoParam(request.query.from);
    const to = isoParam(request.query.to);
    const channels =
      typeof request.query.channel === "string" && CHANNEL_RE.test(request.query.channel)
        ? new Set(request.query.channel.split(",").filter((c) => c.length > 0))
        : null;

    const params: unknown[] = [];
    const where: string[] = [];
    if (q.length > 0) {
      params.push(`%${q}%`);
      where.push(`t.conversation_id ILIKE $${params.length}`);
    }
    // from/to bound the conversation's ACTIVITY window (any turn in range).
    if (from !== null) {
      params.push(from);
      where.push(`t.recorded_at >= $${params.length}`);
    }
    if (to !== null) {
      params.push(to);
      where.push(`t.recorded_at <= $${params.length}`);
    }
    // Channel pushdown: filter in SQL on the SAME expression channelFor()
    // computes client-side (domain row's channel; synthetic 'ops' for admin:*;
    // 'unknown' when no row) so LIMIT means "N matching conversations", not
    // "whatever survived an over-fetched shortlist". Falls back to the old
    // join-free query + post-enrichment filter if the domain schema is
    // unavailable (the LEFT JOIN itself would then error).
    let rows: unknown[] | undefined;
    let pushedDown = false;
    if (channels !== null) {
      try {
        const p2: unknown[] = [...params, [...channels]];
        const chCond = `COALESCE(c.channel, CASE WHEN t.conversation_id LIKE 'admin:%' THEN 'ops' ELSE 'unknown' END) = ANY($${p2.length})`;
        p2.push(limit);
        rows = (
          await pool().query(
            `SELECT t.conversation_id AS session_id, min(t.recorded_at) AS started_at,
                    max(t.recorded_at) AS last_at, count(DISTINCT t.turn_id) AS turns
             FROM turn_trace t
             LEFT JOIN ibx_domain.conversations c ON c.session_id = t.conversation_id
             WHERE ${[...where, chCond].join(" AND ")}
             GROUP BY t.conversation_id
             ORDER BY last_at DESC
             LIMIT $${p2.length}`,
            p2,
          )
        ).rows;
        pushedDown = true;
      } catch (err) {
        logger.warn(
          { component: "qa-rca", err: (err as Error).message },
          "channel pushdown unavailable — falling back to post-enrichment filter",
        );
      }
    }
    if (rows === undefined) {
      // Over-fetch the shortlist when a channel filter narrows it afterwards.
      params.push(channels !== null ? 200 : limit);
      rows = (
        await pool().query(
          `SELECT t.conversation_id AS session_id, min(t.recorded_at) AS started_at,
                  max(t.recorded_at) AS last_at, count(DISTINCT t.turn_id) AS turns
           FROM turn_trace t ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
           GROUP BY t.conversation_id
           ORDER BY last_at DESC
           LIMIT $${params.length}`,
          params,
        )
      ).rows;
    }

    // Best-effort enrichment: channel + chat cuid + customer id + last archived
    // message from the domain schema. Message content is redacted server-side
    // (see header). customer_id is the TOP rung of LE2-031's identity ladder —
    // when this enrichment is skipped every session falls back to the phone
    // hash and then to the explicit "unidentified" bucket, never to a guess.
    const meta = new Map<
      string,
      {
        channel: string | null;
        chatCuid: string | null;
        customerId: string | null;
        lastText: string | null;
        lastRole: string | null;
      }
    >();
    const ids = rows
      .map((r) => str((r as Record<string, unknown>).session_id))
      .filter((v): v is string => v !== null);
    const phoneHashes = fetchPhoneHashes(ids);
    if (ids.length > 0) {
      try {
        const enr = await pool().query(
          `SELECT c.session_id, c.id AS chat_cuid, c.channel, c.customer_id, m.content, m.role
           FROM ibx_domain.conversations c
           LEFT JOIN LATERAL (
             SELECT content, role FROM ibx_domain.conversation_messages
             WHERE conversation_id = c.id ORDER BY sent_at DESC LIMIT 1
           ) m ON TRUE
           WHERE c.session_id = ANY($1)`,
          [ids],
        );
        for (const r of enr.rows as Array<Record<string, unknown>>) {
          const sid = str(r.session_id);
          const content = str(r.content);
          if (sid !== null) {
            meta.set(sid, {
              channel: str(r.channel),
              chatCuid: str(r.chat_cuid),
              customerId: str(r.customer_id),
              lastText: content !== null ? redactText(content).slice(0, 160) : null,
              lastRole: str(r.role),
            });
          }
        }
      } catch (err) {
        logger.warn({ component: "qa-rca", err: (err as Error).message }, "conversation enrichment skipped");
      }
    }
    const hashes = await phoneHashes;

    const conversations = rows
      .map((r) => {
        const row = r as Record<string, unknown>;
        const sid = str(row.session_id) ?? "";
        const m = meta.get(sid);
        return {
          sessionId: sid,
          chatCuid: m?.chatCuid ?? null,
          channel: channelFor(sid, m?.channel ?? null),
          startedAt: iso(row.started_at),
          lastAt: iso(row.last_at),
          lastText: m?.lastText ?? null,
          lastRole: m?.lastRole ?? null,
          turnCount: num(row.turns) ?? 0,
          // LE2-031 identity columns — the rail groups on these, and they are
          // both opaque (a cuid and a salted hash); no PII crosses the wire.
          customerId: m?.customerId ?? null,
          phoneHash: hashes.get(sid) ?? null,
        };
      })
      .filter((c) => pushedDown || channels === null || channels.has(c.channel))
      .slice(0, limit);

    // LE2-031 — the rail's top-level rows. Derived from exactly the
    // conversations served above (after filtering + LIMIT), so a group never
    // references a session the client cannot see. The flat `conversations`
    // array stays on the wire unchanged: the sub-rows, the channel facets and
    // every existing consumer still read it.
    return { conversations, groups: groupConversationsByCustomer(conversations) };
  });

  // ── turns of one conversation ─────────────────────────────────────────────
  server.get<{ Params: { conv: string }; Querystring: { from?: string; to?: string } }>(
    "/internal/qa/rca/conversations/:conv/turns",
    RL,
    async (request, reply) => {
      const conv = request.params.conv;
      if (!SAFE_ID.test(conv)) return reply.code(400).send({ error: "invalid conversation id" });
      const from = isoParam(request.query.from);
      const to = isoParam(request.query.to);

      const params: unknown[] = [conv];
      let range = "";
      if (from !== null) {
        params.push(from);
        range += ` AND recorded_at >= $${params.length}`;
      }
      if (to !== null) {
        params.push(to);
        range += ` AND recorded_at <= $${params.length}`;
      }
      const { rows } = await pool().query(
        `SELECT turn_id, min(recorded_at) AS started_at, max(recorded_at) AS ended_at,
                count(*) AS calls,
                bool_or((prompt_manifest->>0 LIKE 'ibatexas/responder%'
                         OR prompt_manifest->>0 LIKE 'ops/responder%')
                        AND (output_tokens = 0 OR length(btrim(coalesce(completion, ''))) = 0)) AS responder_empty
         FROM turn_trace WHERE conversation_id = $1${range}
         GROUP BY turn_id ORDER BY started_at DESC LIMIT 200`,
        params,
      );

      const turns = rows.map((r) => {
        const row = r as Record<string, unknown>;
        return {
          turnId: str(row.turn_id) ?? "",
          startedAt: iso(row.started_at),
          endedAt: iso(row.ended_at),
          startMs: row.started_at instanceof Date ? row.started_at.getTime() : Date.parse(str(row.started_at) ?? ""),
          callCount: num(row.calls) ?? 0,
          decision: null as string | null,
          adjCount: 0,
          userText: null as string | null,
          hadSend: false,
          responderEmpty: row.responder_empty === true,
        };
      });

      // Populate decision/adjCount (one ADJ query over the listed span, bucketed
      // to turns in JS) + userText (nearest preceding archived user message).
      // Both lanes are best-effort — a failure leaves the fields null as before.
      if (turns.length > 0) {
        const spanStart = turns[turns.length - 1]!.startedAt;
        const spanEnd = turns[0]!.endedAt ?? turns[0]!.startedAt;
        try {
          const adjRes = await pool().query(
            `SELECT recorded_at, kind, decision_kind FROM intent_audit
             WHERE (nonce LIKE $1 OR session_id = $2)
               AND recorded_at BETWEEN $3::timestamptz - interval '${ADJ_SLACK_BEFORE}'
                                   AND $4::timestamptz + interval '${ADJ_SLACK_AFTER}'
             ORDER BY recorded_at`,
            [`${conv}:%`, auditSessionHash(conv), spanStart, spanEnd],
          );
          // Bucket each decision onto the latest turn that started before it.
          const byStart = [...turns].sort((a, b) => a.startMs - b.startMs);
          const kindsPerTurn = new Map<string, string[]>();
          for (const r of adjRes.rows as Array<Record<string, unknown>>) {
            const kind = str(r.kind) ?? "";
            if (kind === "conversation.message.append") continue; // archiver bookkeeping
            const at = r.recorded_at instanceof Date ? r.recorded_at.getTime() : Date.parse(str(r.recorded_at) ?? "");
            if (!Number.isFinite(at)) continue;
            let target: (typeof byStart)[number] | undefined;
            for (const t of byStart) {
              if (t.startMs - 10_000 <= at) target = t;
              else break;
            }
            if (target === undefined) continue;
            const list = kindsPerTurn.get(target.turnId) ?? [];
            list.push(str(r.decision_kind) ?? "");
            kindsPerTurn.set(target.turnId, list);
          }
          for (const t of turns) {
            const kinds = kindsPerTurn.get(t.turnId) ?? [];
            t.adjCount = kinds.length;
            t.decision = pickDecision(kinds);
          }
        } catch (err) {
          logger.warn({ component: "qa-rca", err: (err as Error).message }, "turn decisions degraded to null");
        }

        try {
          const msgRes = await pool().query(
            `SELECT m.content, m.sent_at FROM ibx_domain.conversations c
             JOIN ibx_domain.conversation_messages m ON m.conversation_id = c.id
             WHERE c.session_id = $1 AND m.role = 'user'
             ORDER BY m.sent_at`,
            [conv],
          );
          const msgs = (msgRes.rows as Array<Record<string, unknown>>)
            .map((r) => ({
              at: r.sent_at instanceof Date ? r.sent_at.getTime() : Date.parse(str(r.sent_at) ?? ""),
              content: str(r.content) ?? "",
            }))
            .filter((m) => Number.isFinite(m.at));
          for (const t of turns) {
            // The user message that triggered a turn is archived with a sent_at
            // at/just before the turn's first LLM call — take the latest one in
            // [start-5min, start+15s]. Heuristic (no turn id on messages).
            let best: { at: number; content: string } | null = null;
            for (const m of msgs) {
              if (m.at > t.startMs + 15_000) break;
              if (m.at >= t.startMs - 300_000) best = m;
            }
            if (best !== null) t.userText = redactText(best.content).slice(0, 120);
          }
        } catch {
          /* domain schema optional — userText stays null */
        }
      }

      return { turns: turns.map(({ startMs: _drop, ...t }) => t) };
    },
  );

  // ── THE merged turn view ──────────────────────────────────────────────────
  server.get<{ Params: { turnId: string }; Querystring: { window?: string } }>(
    "/internal/qa/rca/turns/:turnId",
    RL,
    async (request, reply) => {
      const turnId = request.params.turnId;
      if (!SAFE_ID.test(turnId)) return reply.code(400).send({ error: "invalid turn id" });
      const window = WINDOW_RE.test(request.query.window ?? "") ? (request.query.window as string) : null;

      // 1) resolve conversation + span from turn_trace (the only plaintext key).
      // LE2-014: catalog_version rides along on this same aggregate — it is
      // stamped identically on every row of the turn (turn_trace has no root
      // row), so max() reads the turn's single value without a second query.
      // NULL for turns written before the column existed; surfaced as null, not
      // guessed.
      const head = await pool().query(
        `SELECT conversation_id, min(recorded_at) AS started_at, max(recorded_at) AS ended_at,
                max(catalog_version) AS catalog_version
         FROM turn_trace WHERE turn_id = $1 GROUP BY conversation_id LIMIT 1`,
        [turnId],
      );
      const h = (head.rows[0] ?? {}) as Record<string, unknown>;
      const conv = str(h.conversation_id);
      const startedAt = iso(h.started_at);
      const endedAt = iso(h.ended_at);
      const catalogVersion = num(h.catalog_version);

      const degraded = { adj: false, vl: false, wire: false, delivery: false };

      // 2) [LLM] the model calls, then [ADJ] via this turn's intent hashes —
      //    the [LLM]→[ADJ] chain, the [VL] fetch, and the context enrichment
      //    run as three independent branches (the VL leg carries an 8s timeout
      //    that previously serialized after every pg read).
      const llmAdjBranch = (async () => {
        const llmRes = await pool().query(
          `SELECT call_index, prompt_manifest->>0 AS prompt0, model, temperature, intent_hash,
                  input_tokens, output_tokens, completion, duration_ms, recorded_at
           FROM turn_trace WHERE turn_id = $1 ORDER BY call_index, recorded_at`,
          [turnId],
        );
        const llm = llmRes.rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            callIndex: num(row.call_index) ?? 0,
            persona: str(row.prompt0),
            model: str(row.model),
            temperature: num(row.temperature),
            intentHash: str(row.intent_hash),
            inputTokens: num(row.input_tokens),
            outputTokens: num(row.output_tokens),
            durationMs: num(row.duration_ms),
            completion: str(row.completion),
            recordedAt: iso(row.recorded_at),
          };
        });

        // [ADJ] — the three-arm bridge (see file header): conversation-prefixed
        // nonces + the recomputed session hash, both scoped to the turn span,
        // UNION an exact intent_hash match that is deliberately NOT time-scoped
        // — a parked envelope's confirm/defer RESUME re-adjudication happens in
        // a later turn but is still THIS envelope's story (the supersedes chain
        // ties them together). session_id is hashed by the audit redactor, so
        // arm 2 recomputes that hash; it never round-trips a plaintext id.
        // Fail-safe to empty.
        let adj: Array<Record<string, unknown>> = [];
        const hashes = [...new Set(llm.map((c) => c.intentHash).filter((x): x is string => x !== null))];
        if (conv !== null && startedAt !== null && endedAt !== null) {
          try {
            const adjRes = await pool().query(
              `SELECT recorded_at, kind, decision_kind, refusal_kind, refusal_code,
                      taint, principal, decision_basis, duration_ms, nonce, session_id,
                      intent_hash, supersedes_jsonb,
                      CASE WHEN intent_hash = ANY($5::text[]) THEN 'turn'
                           WHEN nonce LIKE $1 THEN 'system'
                           ELSE 'session' END AS scope
               FROM intent_audit
               WHERE ((nonce LIKE $1 OR session_id = $2)
                      AND recorded_at BETWEEN $3::timestamptz - interval '${ADJ_SLACK_BEFORE}'
                                          AND $4::timestamptz + interval '${ADJ_SLACK_AFTER}')
                  OR intent_hash = ANY($5::text[])
               ORDER BY recorded_at`,
              [`${conv}:%`, auditSessionHash(conv), startedAt, endedAt, hashes],
            );
            adj = adjRes.rows as Array<Record<string, unknown>>;
          } catch (err) {
            degraded.adj = true;
            logger.warn({ component: "qa-rca", err: (err as Error).message }, "[ADJ] read degraded to empty");
          }
        }
        return { llm, adj };
      })();

      // [VL] pino logs by correlationId OR turnId, time-anchored to the turn.
      // Fail-safe to empty — but flagged, so the viewer can distinguish
      // "no logs" (absence-is-signal) from "the log store was unreachable".
      const vlBranch = (async () => {
        try {
          return await queryVl(vlTurnQuery(turnId, startedAt, endedAt, window), 500);
        } catch (err) {
          degraded.vl = true;
          logger.warn({ component: "qa-rca", err: (err as Error).message }, "[VL] read degraded to empty");
          return [] as VlRaw[];
        }
      })();

      // context enrichment (display-only; hashed ids never join).
      // NOTE: conversations has NO phone_hash column (that lives on
      // conversation_incidents) — selecting it here errored on EVERY turn and
      // the catch silently nulled channel/chatCuid too (found in the 2026-07-13
      // deepening scan). phoneHash stays on the wire as null for now.
      const enrichBranch = (async () => {
        if (conv === null) return { channel: null as string | null, chatCuid: null as string | null };
        try {
          const c = await pool().query(
            `SELECT id AS chat_cuid, channel FROM ibx_domain.conversations WHERE session_id = $1 LIMIT 1`,
            [conv],
          );
          const cr = (c.rows[0] ?? {}) as Record<string, unknown>;
          return { channel: str(cr.channel), chatCuid: str(cr.chat_cuid) };
        } catch {
          /* domain schema optional — display fields stay null */
          return { channel: null, chatCuid: null };
        }
      })();

      // [WIRE] Wire Truth — the durable request/response exchanges captured at
      // the model relay (llm_wire, one row per ATTEMPT: retries share a
      // call_index across ascending seq). Fail-safe to empty + flagged, so a
      // pre-capture turn (or a DB without the table yet) reads as explicit
      // absence, never as breakage.
      const wireBranch = (async () => {
        try {
          const wireRes = await pool().query(
            `SELECT seq, call_index, model, request_jsonb, response_jsonb, request_hash,
                    request_truncated, response_truncated, recorded_at
             FROM llm_wire WHERE turn_id = $1 ORDER BY seq`,
            [turnId],
          );
          return wireRes.rows.map((r) => {
            const row = r as Record<string, unknown>;
            return {
              seq: num(row.seq) ?? 0,
              callIndex: num(row.call_index),
              model: str(row.model),
              request: row.request_jsonb ?? null,
              response: row.response_jsonb ?? null,
              requestHash: str(row.request_hash),
              requestTruncated: row.request_truncated === true,
              responseTruncated: row.response_truncated === true,
              recordedAt: iso(row.recorded_at),
            };
          });
        } catch (err) {
          degraded.wire = true;
          logger.warn({ component: "qa-rca", err: (err as Error).message }, "[WIRE] read degraded to empty");
          return [];
        }
      })();

      // [DELIVERY] LE2-030 — the Twilio delivery confirmation per outbound reply
      // part (whatsapp_delivery, one row per SID captured at send). Same
      // fail-safe posture as the wire lane: an unreachable/absent store degrades
      // to empty AND flags it, so the workbench can tell "no callback yet"
      // (pending — the normal early state) from "the store did not answer".
      const deliveryBranch = (async () => {
        try {
          const res = await pool().query(
            `SELECT message_sid, part_index, status, sent_at, status_at,
                    error_code, error_message, callback_count, source
             FROM whatsapp_delivery WHERE turn_id = $1 ORDER BY part_index, sent_at`,
            [turnId],
          );
          return res.rows.map((r) => {
            const row = r as Record<string, unknown>;
            return {
              messageSid: str(row.message_sid),
              partIndex: num(row.part_index) ?? 0,
              // null = no callback has ever arrived for this SID → "pending".
              status: str(row.status),
              sentAt: iso(row.sent_at),
              statusAt: iso(row.status_at),
              errorCode: str(row.error_code),
              errorMessage: str(row.error_message),
              callbackCount: num(row.callback_count) ?? 0,
              source: str(row.source),
            };
          });
        } catch (err) {
          degraded.delivery = true;
          logger.warn(
            { component: "qa-rca", err: (err as Error).message },
            "[DELIVERY] read degraded to empty",
          );
          return [];
        }
      })();

      const [{ llm, adj }, vl, enrich, wire, delivery] = await Promise.all([
        llmAdjBranch,
        vlBranch,
        enrichBranch,
        wireBranch,
        deliveryBranch,
      ]);
      const channel = enrich.channel;
      const chatCuid = enrich.chatCuid;
      const phoneHash: string | null = null;
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
            channel: conv !== null ? channelFor(conv, channel) : channel,
            startedAt,
            endedAt,
            durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null,
            // LE2-014 — the catalog this turn ran under (the replay key).
            catalogVersion,
          },
          llm,
          adj: adj.map((row) => {
            const sup = row.supersedes_jsonb as Record<string, unknown> | null | undefined;
            return {
              recordedAt: iso(row.recorded_at),
              kind: str(row.kind),
              decisionKind: str(row.decision_kind),
              refusalKind: str(row.refusal_kind),
              refusalCode: str(row.refusal_code),
              taint: str(row.taint),
              principal: str(row.principal),
              decisionBasis: strArr(row.decision_basis),
              durationMs: num(row.duration_ms),
              nonce: str(row.nonce),
              intentHash: str(row.intent_hash),
              scope: str(row.scope),
              supersedes:
                sup != null && typeof sup === "object"
                  ? {
                      reason: str(sup.reason),
                      predecessorIntentHash: str(sup.predecessorIntentHash),
                      predecessorAt: iso(sup.predecessorAt),
                    }
                  : null,
            };
          }),
          vl: vl.map((l) => ({
            time: iso(l._time),
            level: l.level == null ? null : String(l.level),
            component: str(l.component),
            msg: str(l._msg),
            fields: vlFields(l),
          })),
          wire,
          // LE2-030 — per-reply-part Twilio delivery confirmation.
          delivery,
          degraded,
        },
      };
    },
  );

  // ── span attribution (RCA-legibility) ─────────────────────────────────────
  // Re-run the DETERMINISTIC span classifiers on the turn's inbound text so the
  // workbench can show WHY a message routed the way it did (which span nets
  // fired, which claim types they force, whether the classify-only read path was
  // eligible) without grepping regexes. The classifiers are pure (no I/O, no
  // env) — this replays classification, it mutates nothing.
  //
  // CAVEATS the response states rather than hides:
  //  - conversation_messages carries no turn id; the inbound text is matched by
  //    the SAME [start-5min, start+15s] window heuristic the turns list uses
  //    (`confidence` says whether the window was unambiguous).
  //  - the turn's live classifier input was the pre-archival perception text;
  //    the archived copy is a faithful-but-not-byte-identical replay.
  //  - L0/L1 funnel turns write no turn_trace rows → 404 here (nothing to
  //    attribute — those turns never reach the span classifier's consumers).
  // Structure-only response: span classes + type names + a 120-char redacted
  // snippet (the same exposure the turns list already grants via userText).
  server.get<{ Params: { turnId: string } }>(
    "/internal/qa/rca/turns/:turnId/spans",
    RL,
    async (request, reply) => {
      const turnId = request.params.turnId;
      if (!SAFE_ID.test(turnId)) return reply.code(400).send({ error: "invalid turn id" });

      const head = await pool().query(
        `SELECT conversation_id, min(recorded_at) AS started_at
         FROM turn_trace WHERE turn_id = $1 GROUP BY conversation_id LIMIT 1`,
        [turnId],
      );
      const h = (head.rows[0] ?? {}) as Record<string, unknown>;
      const conv = str(h.conversation_id);
      const startedAt = iso(h.started_at);
      if (conv === null || startedAt === null) {
        return reply.code(404).send({ error: "turn not found in turn_trace" });
      }

      // The inbound user message, by the turns-list window heuristic (no turn id
      // on conversation_messages). ≥2 candidates in the window → "ambiguous";
      // the LATEST one is still classified (it is the most likely trigger).
      const startMs = Date.parse(startedAt);
      let matched: { at: string; content: string } | null = null;
      let windowCount = 0;
      try {
        const msgRes = await pool().query(
          `SELECT m.content, m.sent_at FROM ibx_domain.conversations c
           JOIN ibx_domain.conversation_messages m ON m.conversation_id = c.id
           WHERE c.session_id = $1 AND m.role = 'user'
             AND m.sent_at >= $2 AND m.sent_at <= $3
           ORDER BY m.sent_at DESC`,
          [conv, new Date(startMs - 300_000).toISOString(), new Date(startMs + 15_000).toISOString()],
        );
        const rows = msgRes.rows as Array<Record<string, unknown>>;
        windowCount = rows.length;
        const top = rows[0];
        if (top !== undefined) {
          const at = iso(top.sent_at);
          const content = str(top.content);
          if (at !== null && content !== null) matched = { at, content };
        }
      } catch {
        /* domain schema optional — falls through to confidence "none" */
      }

      if (matched === null) {
        return {
          spanClasses: [],
          requiredTypes: null,
          classifyOnlyEligible: false,
          matchedMessageAt: null,
          snippet: null,
          confidence: "none",
        };
      }

      const spanClasses = classifyRequestSpans(matched.content);
      // The seam-active, ownership-free projection — the same call the
      // classify-only gate makes. Ownership/date-anchor signals are per-turn
      // runtime state this replay does not have; the set shown is the
      // OVER-INCLUDING one (demote-only signals could only shrink it).
      const requiredTypes = [
        ...decomposeRequiredClaims(spanClasses, undefined, { seamActive: true }),
      ];
      const classifyOnlyEligible = classifyOnlyRequiredTypes(matched.content) !== undefined;

      return {
        spanClasses,
        requiredTypes,
        classifyOnlyEligible,
        matchedMessageAt: matched.at,
        snippet: redactText(matched.content).slice(0, 120),
        confidence: windowCount > 1 ? "ambiguous" : "single_match",
      };
    },
  );

  // ── undelivered replies (LE2-030 AC4) ─────────────────────────────────────
  // The queryable surface for "which replies never landed": rows whose LATEST
  // status is a failure (failed / undelivered / canceled), UNION rows that
  // carry no delivery confirmation at all after a threshold — the silent case,
  // which is the one that used to be invisible. A reply sent 3 seconds ago with
  // no callback yet is NOT undelivered, it is pending; the threshold (default
  // 15 min, Twilio's own delivery window is far shorter) is what separates them.
  //
  // Same fail-safe posture as every other read here: an unreachable/absent
  // store answers `{ rows: [], degraded: true }`, never a 500.
  server.get<{
    Querystring: { thresholdMinutes?: string; limit?: string; from?: string; to?: string };
  }>("/internal/qa/rca/deliveries/undelivered", RL, async (request) => {
    const thresholdMinutes = Math.min(
      Math.max(num(request.query.thresholdMinutes) ?? 15, 0),
      7 * 24 * 60,
    );
    const limit = Math.min(Math.max(num(request.query.limit) ?? 100, 1), 500);
    const from = isoParam(request.query.from);
    const to = isoParam(request.query.to);

    const params: unknown[] = [[...FAILED_WHATSAPP_STATUSES], thresholdMinutes];
    let range = "";
    if (from !== null) {
      params.push(from);
      range += ` AND sent_at >= $${params.length}`;
    }
    if (to !== null) {
      params.push(to);
      range += ` AND sent_at <= $${params.length}`;
    }
    params.push(limit);

    try {
      const { rows } = await pool().query(
        `SELECT message_sid, turn_id, conversation_id, part_index, phone_hash, source,
                sent_at, status, status_at, error_code, error_message, callback_count,
                CASE WHEN status = ANY($1::text[]) THEN 'failed' ELSE 'no_confirmation' END AS reason
         FROM whatsapp_delivery
         WHERE (status = ANY($1::text[])
                OR (status IS NULL AND sent_at < now() - make_interval(mins => $2::int)))
               ${range}
         ORDER BY sent_at DESC
         LIMIT $${params.length}`,
        params,
      );
      return {
        thresholdMinutes,
        degraded: false,
        rows: rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            messageSid: str(row.message_sid),
            turnId: str(row.turn_id),
            conversationId: str(row.conversation_id),
            partIndex: num(row.part_index) ?? 0,
            phoneHash: str(row.phone_hash),
            source: str(row.source),
            sentAt: iso(row.sent_at),
            status: str(row.status),
            statusAt: iso(row.status_at),
            errorCode: str(row.error_code),
            errorMessage: str(row.error_message),
            callbackCount: num(row.callback_count) ?? 0,
            /** 'failed' = Twilio said so; 'no_confirmation' = silence past the threshold. */
            reason: str(row.reason),
          };
        }),
      };
    } catch (err) {
      logger.warn(
        { component: "qa-rca", err: (err as Error).message },
        "undelivered query degraded to empty",
      );
      return { thresholdMinutes, degraded: true, rows: [] };
    }
  });

  // ── find a message by text (ibx-find-msg.sh as a route) ───────────────────
  // Searches the audit ledger's archived message content (populated on
  // conversation.message.append envelopes; carries BOTH roles — a hit may be
  // an assistant/store message, not the user's text), then resolves each hit
  // to the turn whose span the message landed in so the rail can jump straight
  // to it. Content is server-redacted like every other string served here.
  server.get<{ Querystring: { text?: string; limit?: string; from?: string; to?: string } }>(
    "/internal/qa/rca/find",
    RL,
    async (request, reply) => {
      const text =
        typeof request.query.text === "string" ? request.query.text.trim().slice(0, 120) : "";
      if (text.length < 2) return reply.code(400).send({ error: "text must be at least 2 characters" });
      const limit = Math.min(Math.max(num(request.query.limit) ?? 20, 1), 50);
      const from = isoParam(request.query.from);
      const to = isoParam(request.query.to);

      // Escape LIKE wildcards so the user's text is a literal substring match.
      const needle = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const params: unknown[] = [needle];
      let range = "";
      if (from !== null) {
        params.push(from);
        range += ` AND recorded_at >= $${params.length}`;
      }
      if (to !== null) {
        params.push(to);
        range += ` AND recorded_at <= $${params.length}`;
      }
      params.push(limit);
      const { rows } = await pool().query(
        `SELECT recorded_at, decision_kind, nonce,
                envelope_jsonb->'payload'->>'role' AS role,
                envelope_jsonb->'payload'->>'content' AS content,
                envelope_jsonb->'payload'->>'conversationId' AS chat_cuid
         FROM intent_audit
         WHERE envelope_jsonb->'payload'->>'content' ILIKE $1${range}
         ORDER BY recorded_at DESC LIMIT $${params.length}`,
        params,
      );

      // Archiver nonces are `<sessionId>:<sentAt>:<idx>` — but the ops plane's
      // sessionId is itself `admin:<staffId>`, so the conversation-id candidate
      // is the first segment OR the first two joined. Try both against
      // turn_trace; whichever exists there is the real conversation_id.
      const hits = rows.map((r) => {
        const row = r as Record<string, unknown>;
        const content = str(row.content);
        const nonceParts = (str(row.nonce) ?? "").split(":");
        const candidates = [nonceParts[0] ?? ""];
        if (nonceParts.length > 2) candidates.push(`${nonceParts[0]}:${nonceParts[1]}`);
        // Best pre-resolution guess for the conversation id: the ops plane's
        // sessionId is itself `admin:<staffId>` (two segments), so single-segment
        // `admin` is never a real conversation id. Resolution below overrides this
        // once a candidate matches turn_trace; this only shapes the unresolved row.
        const defaultConv =
          nonceParts[0] === "admin" && nonceParts.length > 2
            ? `${nonceParts[0]}:${nonceParts[1]}`
            : (nonceParts[0] ?? null);
        return {
          recordedAt: iso(row.recorded_at),
          atMs:
            row.recorded_at instanceof Date
              ? row.recorded_at.getTime()
              : Date.parse(str(row.recorded_at) ?? ""),
          candidates: candidates.filter((c) => c.length > 0),
          role: str(row.role),
          decisionKind: str(row.decision_kind),
          text: content !== null ? redactText(content).slice(0, 160) : null,
          sessionId: defaultConv,
          chatCuid: str(row.chat_cuid),
          turnId: null as string | null,
        };
      });

      // Resolve each hit to the latest turn of its conversation that started
      // before the message landed (+15s slack: the archiver's assistant append
      // is recorded just after the turn's last trace row). Best-effort.
      const ids = [...new Set(hits.flatMap((h) => h.candidates))];
      if (ids.length > 0) {
        try {
          const t = await pool().query(
            `SELECT conversation_id, turn_id, min(recorded_at) AS started_at
             FROM turn_trace WHERE conversation_id = ANY($1)
             GROUP BY conversation_id, turn_id ORDER BY started_at`,
            [ids],
          );
          const byConv = new Map<string, Array<{ turnId: string; startMs: number }>>();
          for (const r of t.rows as Array<Record<string, unknown>>) {
            const conv = str(r.conversation_id) ?? "";
            const turnId = str(r.turn_id) ?? "";
            const startMs =
              r.started_at instanceof Date ? r.started_at.getTime() : Date.parse(str(r.started_at) ?? "");
            if (!Number.isFinite(startMs) || turnId.length === 0) continue;
            const list = byConv.get(conv) ?? [];
            list.push({ turnId, startMs });
            byConv.set(conv, list);
          }
          for (const h of hits) {
            const conv = h.candidates.find((c) => byConv.has(c));
            if (conv === undefined || !Number.isFinite(h.atMs)) continue;
            h.sessionId = conv;
            let best: string | null = null;
            for (const tr of byConv.get(conv)!) {
              if (tr.startMs <= h.atMs + 15_000) best = tr.turnId;
              else break;
            }
            h.turnId = best;
          }
        } catch (err) {
          logger.warn({ component: "qa-rca", err: (err as Error).message }, "find turn resolution skipped");
        }
      }

      return { hits: hits.map(({ atMs: _a, candidates: _c, ...h }) => h) };
    },
  );

  // ── redacted transcript of one conversation ────────────────────────────────
  // The archived domain messages (both roles, sent order) — content is NOT
  // redacted at write, so every string passes the audit redactor here. The
  // ops plane has no domain row → empty transcript, degraded:false. A domain
  // schema outage degrades to empty WITH the flag (absence-is-signal rule).
  server.get<{ Params: { conv: string }; Querystring: { limit?: string } }>(
    "/internal/qa/rca/conversations/:conv/messages",
    RL,
    async (request, reply) => {
      const conv = request.params.conv;
      if (!SAFE_ID.test(conv)) return reply.code(400).send({ error: "invalid conversation id" });
      const limit = Math.min(Math.max(num(request.query.limit) ?? 200, 1), 500);
      try {
        const { rows } = await pool().query(
          `SELECT m.role, m.content, m.sent_at
           FROM ibx_domain.conversations c
           JOIN ibx_domain.conversation_messages m ON m.conversation_id = c.id
           WHERE c.session_id = $1 ORDER BY m.sent_at LIMIT $2`,
          [conv, limit],
        );
        return {
          messages: rows.map((r) => {
            const row = r as Record<string, unknown>;
            const content = str(row.content);
            return {
              role: str(row.role),
              sentAt: iso(row.sent_at),
              text: content !== null ? redactText(content).slice(0, 2000) : null,
            };
          }),
          degraded: false,
        };
      } catch (err) {
        logger.warn({ component: "qa-rca", err: (err as Error).message }, "transcript degraded to empty");
        return { messages: [], degraded: true };
      }
    },
  );

  // ── preflight status (the skill's step-0 discipline as an endpoint) ───────
  // One cheap reachability probe per store the workbench joins across, plus
  // the two env facts that silently reshape what the lanes can show: the
  // audit-redact secret (arm 2 of the ADJ bridge recomputes its hash — unset
  // here while set on the writer means arm 2 misses everything) and the
  // claims-pipeline flag (claims-ON turns run 3 LLM calls, not 2).
  server.get("/internal/qa/rca/status", RL, async () => {
    const [turnTrace, intentAudit, domain, victoriaLogs] = await Promise.all([
      probeStore(() => pool().query("SELECT 1 FROM turn_trace LIMIT 1")),
      probeStore(() => pool().query("SELECT 1 FROM intent_audit LIMIT 1")),
      probeStore(() => pool().query("SELECT 1 FROM ibx_domain.conversation_messages LIMIT 1")),
      probeStore(async () => {
        const res = await fetch(`${stripTrailingSlashes(VICTORIALOGS_URL)}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }),
    ]);
    return {
      status: {
        turnTrace,
        intentAudit,
        domain,
        victoriaLogs,
        flags: {
          redactSecretSet: (process.env.AUDIT_REDACT_SECRET ?? "") !== "",
          // Same check as claimsPipelineEnabled() (claustrum/claims-pipeline.ts)
          // — read directly so this dev-only route doesn't import the claims
          // pipeline wiring just for one env flag.
          claimsPipeline: process.env.ENABLE_CLAIMS_PIPELINE === "true",
        },
      },
    };
  });
}
