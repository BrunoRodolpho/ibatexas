// WS-B: qa-rca READ ROUTES behind the qa-control gate.
//
// The "Turn forensics" workbench backend (registerRcaReadRoutes) is registered
// INSIDE qaControlRoutes, so it inherits the dev-only + timing-safe-Bearer gate.
// This file pins: the bearer gate (401), the SAFE_ID validation (400 on a
// hostile id), and — the fix pinned by this run — the merged turn view surfaces
// a non-null `sessionHashed` when an intent_audit row carries a session_id.
//
// The pg read pool is mocked (dispatch by SQL) and fetch (VictoriaLogs) is
// stubbed to fail-safe empty, so no real DB or network is touched.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// 24-char dev token (>= 16 required by the gate). Not a secret. // gitleaks:allow
const TOKEN = "qa-ctl-secret-token-1234";
const AUTH = { authorization: `Bearer ${TOKEN}` };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true };
});

// Per-test SQL dispatch for the mocked read pool.
const db = vi.hoisted(() => ({
  query: null as null | ((sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>),
}));

vi.mock("pg", () => {
  class Pool {
    on(): this {
      return this;
    }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      if (db.query) return db.query(sql, params);
      return { rows: [] };
    }
    async end(): Promise<void> {
      /* noop */
    }
  }
  return { Pool };
});

import { qaControlRoutes } from "../qa-control.js";
import { closeRcaReadPool } from "../qa-rca.js";

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(qaControlRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("IBX_QA_CONTROL_ENABLED", "true");
  vi.stubEnv("IBX_QA_CONTROL_TOKEN", TOKEN);
  db.query = null;
  // VictoriaLogs is unreachable in tests → the [VL] lane degrades to empty.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no VL in tests")));
});

afterEach(async () => {
  await closeRcaReadPool();
});

// ── gate: bearer ──────────────────────────────────────────────────────────────

describe("qa-rca — gate", () => {
  it("401s an RCA request with no bearer", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/rca/conversations" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
    await app.close();
  });
});

// ── SAFE_ID validation ────────────────────────────────────────────────────────

describe("qa-rca — id validation", () => {
  it("400s a hostile turn id (fails SAFE_ID)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: `/internal/qa/rca/turns/${encodeURIComponent("bad id!")}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid turn id" });
    await app.close();
  });

  it("400s a hostile conversation id (fails SAFE_ID)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: `/internal/qa/rca/conversations/${encodeURIComponent("bad id!")}/turns`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid conversation id" });
    await app.close();
  });
});

// ── merged turn view ──────────────────────────────────────────────────────────

describe("qa-rca — merged turn view", () => {
  it("surfaces a non-null sessionHashed from the intent_audit row", async () => {
    db.query = async (sql: string) => {
      // head: resolve conversation + span from turn_trace.
      if (sql.includes("min(recorded_at) AS started_at, max(recorded_at) AS ended_at")) {
        return {
          rows: [
            {
              conversation_id: "conv-abc",
              started_at: "2026-07-09T10:00:00.000Z",
              ended_at: "2026-07-09T10:00:02.000Z",
            },
          ],
        };
      }
      // llm calls.
      if (sql.includes("call_index")) return { rows: [] };
      // [ADJ] intent_audit — carries the hashed session_id.
      if (sql.includes("FROM intent_audit")) {
        return {
          rows: [
            {
              recorded_at: "2026-07-09T10:00:01.000Z",
              kind: "read.store.open_now",
              decision_kind: "VALIDATED",
              refusal_kind: null,
              refusal_code: null,
              taint: null,
              principal: "llm",
              decision_basis: ["schema:version_supported"],
              duration_ms: 3,
              nonce: "conv-abc:2026-07-09T10:00:00.000Z:0",
              session_id: "sess-hash-xyz",
              intent_hash: null,
              supersedes_jsonb: null,
              scope: "system",
            },
          ],
        };
      }
      // domain enrichment (conversations). NOTE: no phone_hash column exists on
      // this table — the route must not select it (the pre-scan version did and
      // silently nulled channel/chatCuid on every turn).
      if (sql.includes("ibx_domain.conversations")) {
        return { rows: [{ chat_cuid: "chat_1", channel: "web" }] };
      }
      return { rows: [] };
    };

    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/turns/turn-123",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const ctx = res.json().turn.context;
    expect(ctx.sessionHashed).toBe("sess-hash-xyz");
    expect(ctx.conversationId).toBe("conv-abc");
    expect(ctx.noncePrefix).toBe("conv-abc:");
    expect(ctx.channel).toBe("web");
    expect(ctx.chatCuid).toBe("chat_1");
    // [ADJ] lane surfaced the kernel decision row, with the forensic columns.
    expect(res.json().turn.adj).toEqual([
      {
        recordedAt: "2026-07-09T10:00:01.000Z",
        kind: "read.store.open_now",
        decisionKind: "VALIDATED",
        refusalKind: null,
        refusalCode: null,
        taint: null,
        principal: "llm",
        decisionBasis: ["schema:version_supported"],
        durationMs: 3,
        nonce: "conv-abc:2026-07-09T10:00:00.000Z:0",
        intentHash: null,
        scope: "system",
        supersedes: null,
      },
    ]);
    // VL is stubbed unreachable in tests → the lane degrades AND is flagged.
    expect(res.json().turn.degraded).toEqual({ adj: false, vl: true, wire: false });
    await app.close();
  });

  it("surfaces the turn's wire exchanges with attempt-level rows (Wire Truth)", async () => {
    db.query = async (sql: string) => {
      if (sql.includes("min(recorded_at) AS started_at, max(recorded_at) AS ended_at")) {
        return {
          rows: [
            {
              conversation_id: "conv-abc",
              started_at: "2026-07-21T02:35:48.000Z",
              ended_at: "2026-07-21T02:36:03.000Z",
            },
          ],
        };
      }
      if (sql.includes("FROM llm_wire")) {
        return {
          rows: [
            {
              seq: 0,
              call_index: 0,
              model: "nemotron-3-nano:4b",
              request_jsonb: {
                model: "nemotron-3-nano:4b",
                messages: [{ role: "user", content: "oi" }],
                reasoning_effort: "none",
              },
              response_jsonb: { choices: [{ message: { content: "" } }] },
              request_hash: "a".repeat(64),
              request_truncated: false,
              response_truncated: false,
              recorded_at: "2026-07-21T02:35:50.000Z",
            },
            // A retry attempt of the same logical call — same call_index, next seq.
            {
              seq: 1,
              call_index: 0,
              model: "nemotron-3-nano:4b",
              request_jsonb: {
                model: "nemotron-3-nano:4b",
                messages: [{ role: "user", content: "oi" }],
                reasoning_effort: "none",
              },
              response_jsonb: { choices: [{ message: { content: "Oi! Tudo bem?" } }] },
              request_hash: "a".repeat(64),
              request_truncated: false,
              response_truncated: true,
              recorded_at: "2026-07-21T02:35:52.000Z",
            },
          ],
        };
      }
      if (sql.includes("call_index")) return { rows: [] };
      return { rows: [] };
    };

    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/turns/turn-123",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().turn.wire).toEqual([
      {
        seq: 0,
        callIndex: 0,
        model: "nemotron-3-nano:4b",
        request: {
          model: "nemotron-3-nano:4b",
          messages: [{ role: "user", content: "oi" }],
          reasoning_effort: "none",
        },
        response: { choices: [{ message: { content: "" } }] },
        requestHash: "a".repeat(64),
        requestTruncated: false,
        responseTruncated: false,
        recordedAt: "2026-07-21T02:35:50.000Z",
      },
      {
        seq: 1,
        callIndex: 0,
        model: "nemotron-3-nano:4b",
        request: {
          model: "nemotron-3-nano:4b",
          messages: [{ role: "user", content: "oi" }],
          reasoning_effort: "none",
        },
        response: { choices: [{ message: { content: "Oi! Tudo bem?" } }] },
        requestHash: "a".repeat(64),
        requestTruncated: false,
        responseTruncated: true,
        recordedAt: "2026-07-21T02:35:52.000Z",
      },
    ]);
    expect(res.json().turn.degraded.wire).toBe(false);
    await app.close();
  });

  it("degrades to an empty wire lane when the llm_wire table is unavailable (pre-capture turns/DBs)", async () => {
    db.query = async (sql: string) => {
      if (sql.includes("min(recorded_at) AS started_at, max(recorded_at) AS ended_at")) {
        return { rows: [{ conversation_id: "conv-abc", started_at: null, ended_at: null }] };
      }
      if (sql.includes("FROM llm_wire")) {
        throw new Error('relation "llm_wire" does not exist');
      }
      return { rows: [] };
    };
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/turns/turn-123",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().turn.wire).toEqual([]);
    expect(res.json().turn.degraded.wire).toBe(true);
    await app.close();
  });

  it("leaves sessionHashed null when no intent_audit row exists", async () => {
    db.query = async (sql: string) => {
      if (sql.includes("min(recorded_at) AS started_at, max(recorded_at) AS ended_at")) {
        return { rows: [{ conversation_id: "conv-abc", started_at: null, ended_at: null }] };
      }
      return { rows: [] };
    };
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/turns/turn-123",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().turn.context.sessionHashed).toBeNull();
    await app.close();
  });
});

// ── find-by-text ──────────────────────────────────────────────────────────────

describe("qa-rca — find message by text", () => {
  it("400s when the search text is shorter than 2 characters", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/find?text=x",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("resolves hits to turns via the nonce prefix — both planes", async () => {
    db.query = async (sql: string) => {
      // ledger content search (archiver message.append envelopes).
      if (sql.includes("envelope_jsonb->'payload'->>'content' ILIKE")) {
        return {
          rows: [
            {
              recorded_at: "2026-07-09T10:00:03.000Z",
              decision_kind: "EXECUTE",
              // customer plane: nonce prefix IS the conversation uuid.
              nonce: "conv-1:2026-07-09T10:00:02.000Z:0",
              role: "user",
              content: "quero meu pedido",
              chat_cuid: "chat_9",
            },
            {
              recorded_at: "2026-07-09T11:00:03.000Z",
              decision_kind: "EXECUTE",
              // ops plane: sessionId is itself admin:<staffId>, so the
              // conversation-id candidate is the first TWO segments.
              nonce: "admin:staff1:2026-07-09T11:00:02.000Z:0",
              role: "assistant",
              content: "pedido cancelado",
              chat_cuid: null,
            },
          ],
        };
      }
      // turn resolution over turn_trace.
      if (sql.includes("GROUP BY conversation_id, turn_id")) {
        return {
          rows: [
            { conversation_id: "conv-1", turn_id: "turn-A", started_at: "2026-07-09T09:59:00.000Z" },
            { conversation_id: "conv-1", turn_id: "turn-B", started_at: "2026-07-09T10:00:01.000Z" },
            { conversation_id: "admin:staff1", turn_id: "turn-OPS", started_at: "2026-07-09T11:00:00.000Z" },
          ],
        };
      }
      return { rows: [] };
    };

    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/find?text=pedido",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits;
    expect(hits).toHaveLength(2);
    // Latest turn started before the hit wins — not the first.
    expect(hits[0]).toMatchObject({
      sessionId: "conv-1",
      turnId: "turn-B",
      role: "user",
      decisionKind: "EXECUTE",
      chatCuid: "chat_9",
    });
    expect(hits[0].text).toContain("pedido");
    // Ops plane resolved through the two-segment candidate.
    expect(hits[1]).toMatchObject({ sessionId: "admin:staff1", turnId: "turn-OPS" });
    await app.close();
  });

  it("leaves turnId null when no trace matches the nonce prefix", async () => {
    db.query = async (sql: string) => {
      if (sql.includes("envelope_jsonb->'payload'->>'content' ILIKE")) {
        return {
          rows: [
            {
              recorded_at: "2026-07-09T10:00:03.000Z",
              decision_kind: "EXECUTE",
              nonce: "orphan-uuid",
              role: "user",
              content: "sem turno",
              chat_cuid: null,
            },
          ],
        };
      }
      return { rows: [] };
    };
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/find?text=sem+turno",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits[0]).toMatchObject({ sessionId: "orphan-uuid", turnId: null });
    await app.close();
  });

  it("defaults an unresolved ops hit to admin:<staffId>, never the bare 'admin' segment", async () => {
    db.query = async (sql: string) => {
      if (sql.includes("envelope_jsonb->'payload'->>'content' ILIKE")) {
        return {
          rows: [
            {
              recorded_at: "2026-07-09T11:00:03.000Z",
              decision_kind: "EXECUTE",
              nonce: "admin:staff1:2026-07-09T11:00:02.000Z:0",
              role: "assistant",
              content: "pedido cancelado",
              chat_cuid: null,
            },
          ],
        };
      }
      // no turn_trace match → resolution can't override the default.
      return { rows: [] };
    };
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/find?text=cancelado",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits[0]).toMatchObject({ sessionId: "admin:staff1", turnId: null });
    await app.close();
  });
});

// ── transcript ────────────────────────────────────────────────────────────────

describe("qa-rca — conversation transcript", () => {
  it("400s a hostile conversation id", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: `/internal/qa/rca/conversations/${encodeURIComponent("bad id!")}/messages`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("serves the archived messages in sent order (server-redacted)", async () => {
    db.query = async (sql: string) => {
      if (sql.includes("ibx_domain.conversation_messages")) {
        return {
          rows: [
            { role: "user", content: "oi", sent_at: "2026-07-09T10:00:00.000Z" },
            { role: "assistant", content: "olá!", sent_at: "2026-07-09T10:00:02.000Z" },
          ],
        };
      }
      return { rows: [] };
    };
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/conversations/conv-abc/messages",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      messages: [
        { role: "user", sentAt: "2026-07-09T10:00:00.000Z", text: "oi" },
        { role: "assistant", sentAt: "2026-07-09T10:00:02.000Z", text: "olá!" },
      ],
      degraded: false,
    });
    await app.close();
  });

  it("degrades to empty WITH the flag when the domain schema is unreachable", async () => {
    db.query = async () => {
      throw new Error("schema missing");
    };
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/conversations/conv-abc/messages",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messages: [], degraded: true });
    await app.close();
  });
});

// ── preflight status ──────────────────────────────────────────────────────────

describe("qa-rca — preflight status", () => {
  it("probes all three stores + VictoriaLogs and surfaces the env flags", async () => {
    vi.stubEnv("AUDIT_REDACT_SECRET", "test-secret");
    vi.stubEnv("ENABLE_CLAIMS_PIPELINE", "true");
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/rca/status",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const status = res.json().status;
    // pg probes run against the mocked pool (resolves) — reachable.
    expect(status.turnTrace.ok).toBe(true);
    expect(status.intentAudit.ok).toBe(true);
    expect(status.domain.ok).toBe(true);
    // fetch is stubbed to reject → VictoriaLogs down, with the error carried.
    expect(status.victoriaLogs.ok).toBe(false);
    expect(status.victoriaLogs.error).toContain("no VL in tests");
    expect(status.flags).toEqual({ redactSecretSet: true, claimsPipeline: true });
    await app.close();
  });
});
