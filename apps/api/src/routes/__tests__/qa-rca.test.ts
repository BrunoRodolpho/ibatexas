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
              refusal_code: null,
              taint: null,
              session_id: "sess-hash-xyz",
            },
          ],
        };
      }
      // domain enrichment (conversations).
      if (sql.includes("ibx_domain.conversations")) {
        return { rows: [{ chat_cuid: "chat_1", channel: "web", phone_hash: "ph_1" }] };
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
    // [ADJ] lane surfaced the kernel decision row.
    expect(res.json().turn.adj).toEqual([
      {
        recordedAt: "2026-07-09T10:00:01.000Z",
        kind: "read.store.open_now",
        decisionKind: "VALIDATED",
        refusalCode: null,
        taint: null,
      },
    ]);
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
