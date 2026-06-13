// T1b-5 — sim_runs / sim_results: migration + writer-role containment +
// the sessionId join, against a REAL Postgres (testcontainer).
//
// Why a testcontainer, not a mock: three of the properties under test ARE
// Postgres behaviour — (1) the checked-in migration applies (and re-applies
// idempotently via the journeys_sim_migrations ledger); (2) the dedicated
// ibx_sim_writer role (provisioned by the REAL scripts/test-stack/
// create-sim-writer-role.sql) can INSERT the runner-shaped rows while every
// other access fails with SQLSTATE 42501 insufficient_privilege — the
// ORACLE-grade separation: T1a-9's read-only containment stays intact, the
// writer gets INSERT/UPDATE on sim_* ONLY; (3) the documented join
// (SIM_RUN_DECISIONS_SQL) recovers the run's kernel decisions from
// intent_audit through the HASHED sessionId namespaces (D-012) recorded in
// sim_runs.session_ids, windowed to the attempt.
//
// intent_audit here is a MINIMAL stand-in (the four columns the join
// touches) — the kernel's partitioned schema is @adjudicate/audit-postgres's
// layer and `ibx db provision`'s job; this suite pins the JOIN CONTRACT, not
// the kernel DDL (same idiom as readonly-role.integration.test.ts).
//
// Convention mirror: local opt-out via IBX_SKIP_REAL_POSTGRES=1; CI runs
// real. Image matches the test stack's Postgres major (17).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers"
import {
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  refuse,
  type AuditRecord,
  type Decision,
} from "@adjudicate/core"

import { reconcileExpects, type ReconciliationReport } from "../../gates/reconciliation.js"
import type { JourneyExpect } from "../../schema/index.js"
import {
  migrateSimTables,
  SIM_MIGRATIONS_TABLE,
  type SimMigrateResult,
} from "../sim-migrate.js"
import {
  buildSimResults,
  createSimStore,
  requireSimDatabaseUrl,
  SIM_DB_ROLE,
  SIM_RUN_DECISIONS_SQL,
  SimDatabaseUrlError,
  type SimRunRow,
} from "../sim-store.js"

const SKIP_REAL_POSTGRES = process.env["IBX_SKIP_REAL_POSTGRES"] === "1"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const ROLE_SQL_PATH = path.join(REPO_ROOT, "scripts/test-stack/create-sim-writer-role.sql")

const ADMIN_USER = "ibatexas"
const ADMIN_PASSWORD = "ibx-admin-test-pw"
const DB_NAME = "ibatexas_test"
const SIM_PASSWORD = "fedcba9876543210fedcba9876543210" // hex, like gen-env-test.sh

// ── Run fixture (runner-shaped — mirrors run-journey-cli.ts's writeAttempt) ──

/** The run's HASHED audit namespaces (D-012 format: hashed:<8 hex>). */
const HASHED_CHAT = "hashed:aa11bb22"
const HASHED_CUSTOMER = "hashed:cc33dd44"

const T0 = new Date("2026-06-12T12:00:00.000Z")
const atSeconds = (s: number): Date => new Date(T0.getTime() + s * 1_000)

const EXPECTS: JourneyExpect[] = [
  { intentKind: "order.checkout.create", decision: "EXECUTE" },
  { intentKind: "order.cancel", decision: "EXECUTE" },
  { intentKind: "payment.status.transition", decision: "EXECUTE", optional: true },
]

const BASIS = [{ category: "business", code: "rule_satisfied" }] as const

let nonceSeq = 0
function record(args: { kind: string; sessionId: string; decision?: Decision; at: Date }): AuditRecord {
  return buildAuditRecord({
    envelope: buildEnvelope({
      kind: args.kind,
      payload: {},
      actor: { principal: "user", sessionId: args.sessionId },
      taint: "TRUSTED",
      nonce: `t1b5-sim-${nonceSeq++}`,
      createdAt: args.at.toISOString(),
    }),
    decision: args.decision ?? decisionExecute([...BASIS]),
    durationMs: 1,
    at: args.at.toISOString(),
  })
}

// The run's observed trail: checkout EXECUTEd; cancel REFUSEd (divergence —
// the declared expects[1] wants EXECUTE); optional expects[2] never appears.
const CHECKOUT_RECORD = record({
  kind: "order.checkout.create",
  sessionId: HASHED_CHAT,
  at: atSeconds(5),
})
const CANCEL_REFUSE_RECORD = record({
  kind: "order.cancel",
  sessionId: HASHED_CUSTOMER,
  decision: decisionRefuse(
    refuse("BUSINESS_RULE", "order.cancel.window_closed", "Janela de cancelamento encerrada."),
    [...BASIS],
  ),
  at: atSeconds(10),
})

const RECONCILIATION: ReconciliationReport = reconcileExpects({
  journeyId: "JOURNEY-T1B5",
  expects: EXPECTS,
  verify: [{ invariant: "audit.trajectory.in_order" }],
  records: [CHECKOUT_RECORD, CANCEL_REFUSE_RECORD],
})

const RUN: SimRunRow = {
  runId: randomUUID(),
  journeyId: "JOURNEY-T1B5",
  startedAt: T0,
  finishedAt: atSeconds(60),
  pass: false,
  attempt: 1,
  modelId: "claude-sonnet-4-6",
  certifying: true,
  costUsd: 0.0571234,
  driverTokens: { in: 11_000, out: 1_200 },
  sutTokens: { in: 9_500, out: 800 },
  sessionIds: [HASHED_CHAT, HASHED_CUSTOMER],
}

// ── Pure units (no container) ────────────────────────────────────────────────

describe("requireSimDatabaseUrl — containment accessor", () => {
  it("refuses when SIM_DATABASE_URL is unset", () => {
    expect(() => requireSimDatabaseUrl({})).toThrowError(SimDatabaseUrlError)
  })

  it("refuses a non-postgres URL", () => {
    expect(() =>
      requireSimDatabaseUrl({ SIM_DATABASE_URL: "mysql://ibx_sim_writer:x@h:1/db" }),
    ).toThrowError(/postgresql/)
  })

  it("refuses any user that is not the dedicated writer role (incl. the app/migration role)", () => {
    expect(() =>
      requireSimDatabaseUrl({ SIM_DATABASE_URL: "postgresql://ibatexas:x@h:5434/ibatexas_test" }),
    ).toThrowError(new RegExp(SIM_DB_ROLE))
    expect(() =>
      requireSimDatabaseUrl({ SIM_DATABASE_URL: "postgresql://ibx_oracle_ro:x@h:5434/ibatexas_test" }),
    ).toThrowError(new RegExp(SIM_DB_ROLE))
  })

  it("returns the URL for the writer role", () => {
    const url = `postgresql://${SIM_DB_ROLE}:x@h:5434/ibatexas_test`
    expect(requireSimDatabaseUrl({ SIM_DATABASE_URL: url })).toBe(url)
  })
})

describe("buildSimResults — expects[] × reconciliation mapping", () => {
  it("maps observed / divergent / unobserved entries", () => {
    const results = buildSimResults(EXPECTS, RECONCILIATION)
    expect(results).toHaveLength(3)

    // expects[0]: tuple observed — decisionObserved echoes the tuple, hash present.
    expect(results[0]).toMatchObject({
      seq: 0,
      expectKind: "order.checkout.create",
      expectDecision: "EXECUTE",
      observed: true,
      decisionObserved: "EXECUTE",
      intentHash: CHECKOUT_RECORD.intentHash,
    })

    // expects[1]: kind appeared with a DIVERGENT decision — unobserved, but
    // the divergence (REFUSE) and its record hash are queryable.
    expect(results[1]).toMatchObject({
      seq: 1,
      expectKind: "order.cancel",
      expectDecision: "EXECUTE",
      observed: false,
      decisionObserved: "REFUSE",
      intentHash: CANCEL_REFUSE_RECORD.intentHash,
    })

    // expects[2]: kind never appeared — fully null.
    expect(results[2]).toMatchObject({
      seq: 2,
      expectKind: "payment.status.transition",
      observed: false,
      decisionObserved: null,
      intentHash: null,
    })
  })

  it("records every entry unobserved when the attempt died before the gate (no report)", () => {
    const results = buildSimResults(EXPECTS)
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.observed).toBe(false)
      expect(r.decisionObserved).toBeNull()
      expect(r.intentHash).toBeNull()
    }
  })
})

// ── Real-Postgres legs ───────────────────────────────────────────────────────

describe.skipIf(SKIP_REAL_POSTGRES)(
  "sim store — migration, writer role, sessionId join (postgres testcontainer)",
  () => {
    let container: StartedTestContainer
    let admin: pg.Client
    let writer: pg.Client
    let simDatabaseUrl: string
    let firstMigrate: SimMigrateResult
    let secondMigrate: SimMigrateResult

    beforeAll(async () => {
      container = await new GenericContainer("postgres:17-alpine")
        .withExposedPorts(5432)
        .withEnvironment({
          POSTGRES_USER: ADMIN_USER,
          POSTGRES_PASSWORD: ADMIN_PASSWORD,
          POSTGRES_DB: DB_NAME,
        })
        // initdb restarts postgres once; the port being open is not enough.
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/, 2),
        )
        .withStartupTimeout(120_000)
        .start()

      const host = container.getHost()
      const port = container.getMappedPort(5432)

      admin = new pg.Client({
        host,
        port,
        user: ADMIN_USER,
        password: ADMIN_PASSWORD,
        database: DB_NAME,
      })
      await admin.connect()

      // Minimal intent_audit stand-in: the columns SIM_RUN_DECISIONS_SQL
      // touches (the real partitioned schema is the kernel layer's job).
      await admin.query(`
        CREATE TABLE public.intent_audit (
          id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          kind TEXT NOT NULL,
          session_id TEXT NOT NULL,
          decision_kind TEXT NOT NULL,
          intent_hash TEXT NOT NULL,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)

      // The REAL migration, applied twice (second run = the ledger-skip path).
      firstMigrate = await migrateSimTables(admin)
      secondMigrate = await migrateSimTables(admin)

      // The REAL role-provisioning SQL (sentinel substituted exactly like
      // provision-sim-writer-role.sh) — twice, to pin idempotency (second
      // run takes the ALTER ROLE re-sync path).
      const template = await readFile(ROLE_SQL_PATH, "utf8")
      expect(template).toContain("__SIM_WRITER_PASSWORD__")
      const roleSql = template.replaceAll("__SIM_WRITER_PASSWORD__", SIM_PASSWORD)
      await admin.query(roleSql)
      await admin.query(roleSql)

      writer = new pg.Client({
        host,
        port,
        user: SIM_DB_ROLE,
        password: SIM_PASSWORD,
        database: DB_NAME,
      })
      await writer.connect()
      simDatabaseUrl = `postgresql://${SIM_DB_ROLE}:${SIM_PASSWORD}@${host}:${port}/${DB_NAME}`
    }, 180_000)

    afterAll(async () => {
      await writer?.end().catch(() => undefined)
      await admin?.end().catch(() => undefined)
      await container?.stop()
    })

    it("applies the migration once and skips it on re-run (apply-once ledger)", async () => {
      expect(firstMigrate.applied).toContain("001-sim-tables.sql")
      expect(secondMigrate.applied).toHaveLength(0)
      expect(secondMigrate.skipped).toContain("001-sim-tables.sql")

      const tables = await admin.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('sim_runs', 'sim_results', $1)
          ORDER BY table_name`,
        [SIM_MIGRATIONS_TABLE],
      )
      expect(tables.rows.map((r) => r["table_name"])).toEqual([
        SIM_MIGRATIONS_TABLE,
        "sim_results",
        "sim_runs",
      ])
    })

    it("writes a runner-shaped attempt through the DEDICATED writer role (SIM_DATABASE_URL)", async () => {
      // The default factory path — env-sourced URL, role-validated.
      const store = createSimStore({ env: { SIM_DATABASE_URL: simDatabaseUrl } })
      try {
        await store.writeAttempt({
          run: RUN,
          expects: EXPECTS,
          reconciliation: RECONCILIATION,
        })
      } finally {
        await store.close()
      }

      const runs = await admin.query("SELECT * FROM sim_runs WHERE run_id = $1", [RUN.runId])
      expect(runs.rows).toHaveLength(1)
      const row = runs.rows[0]!
      expect(row["journey_id"]).toBe("JOURNEY-T1B5")
      expect(row["pass"]).toBe(false)
      expect(row["attempt"]).toBe(1)
      expect(row["model_id"]).toBe("claude-sonnet-4-6")
      expect(row["certifying"]).toBe(true)
      expect(Number(row["cost_usd"])).toBeCloseTo(0.057123, 6)
      expect(row["driver_tokens_in"]).toBe(11_000)
      expect(row["driver_tokens_out"]).toBe(1_200)
      expect(row["sut_tokens_in"]).toBe(9_500)
      expect(row["sut_tokens_out"]).toBe(800)
      expect(row["session_ids"]).toEqual([HASHED_CHAT, HASHED_CUSTOMER])

      const results = await admin.query(
        "SELECT * FROM sim_results WHERE run_id = $1 ORDER BY seq",
        [RUN.runId],
      )
      expect(results.rows).toHaveLength(3)
      expect(results.rows[0]).toMatchObject({
        seq: 0,
        expect_kind: "order.checkout.create",
        expect_decision: "EXECUTE",
        observed: true,
        decision_observed: "EXECUTE",
        intent_hash: CHECKOUT_RECORD.intentHash,
      })
      expect(results.rows[1]).toMatchObject({
        seq: 1,
        expect_kind: "order.cancel",
        expect_decision: "EXECUTE",
        observed: false,
        decision_observed: "REFUSE",
        intent_hash: CANCEL_REFUSE_RECORD.intentHash,
      })
      expect(results.rows[2]).toMatchObject({
        seq: 2,
        expect_kind: "payment.status.transition",
        observed: false,
        decision_observed: null,
        intent_hash: null,
      })
    })

    it("joins sim_runs.session_ids to intent_audit and returns ONLY the run's decisions", async () => {
      // Seed the kernel-side rows: two in the run's namespaces + window, one
      // out-of-namespace, one out-of-window — only the first two may join.
      await admin.query(
        `INSERT INTO intent_audit (kind, session_id, decision_kind, intent_hash, recorded_at)
         VALUES
           ($1, $2, 'EXECUTE', $3, $4),
           ($5, $6, 'REFUSE',  $7, $8),
           ('order.checkout.create', 'hashed:99999999', 'EXECUTE', 'hash-other-run', $4),
           ('order.item.add', $2, 'EXECUTE', 'hash-out-of-window', $9)`,
        [
          "order.checkout.create",
          HASHED_CHAT,
          CHECKOUT_RECORD.intentHash,
          atSeconds(5).toISOString(),
          "order.cancel",
          HASHED_CUSTOMER,
          CANCEL_REFUSE_RECORD.intentHash,
          atSeconds(10).toISOString(),
          atSeconds(-60).toISOString(), // before started_at
        ],
      )

      const joined = await admin.query(SIM_RUN_DECISIONS_SQL, [RUN.runId])
      expect(joined.rows).toHaveLength(2)
      expect(joined.rows.map((r) => [r["intent_kind"], r["decision_kind"]])).toEqual([
        ["order.checkout.create", "EXECUTE"],
        ["order.cancel", "REFUSE"],
      ])
      expect(joined.rows.map((r) => r["intent_hash"])).toEqual([
        CHECKOUT_RECORD.intentHash,
        CANCEL_REFUSE_RECORD.intentHash,
      ])
    })

    it("containment: the writer role can do NOTHING but INSERT/UPDATE on sim_* (42501 everywhere else)", async () => {
      const sqlStateOf = async (query: string): Promise<string | undefined> => {
        try {
          await writer.query(query)
        } catch (error) {
          return (error as { code?: string }).code
        }
        expect.fail(`query unexpectedly succeeded for the sim-writer role: ${query}`)
      }

      // No reads — not even of its own tables (append-only evidence plane).
      expect(await sqlStateOf("SELECT * FROM sim_runs")).toBe("42501")
      expect(await sqlStateOf("SELECT * FROM intent_audit")).toBe("42501")
      // No kernel-table writes — the hashed audit schema is untouchable.
      expect(
        await sqlStateOf(
          "INSERT INTO intent_audit (kind, session_id, decision_kind, intent_hash) " +
            "VALUES ('x.y', 'hashed:deadbeef', 'EXECUTE', 'h')",
        ),
      ).toBe("42501")
      // No destructive access to its own tables, no DDL.
      expect(await sqlStateOf("DELETE FROM sim_runs")).toBe("42501")
      expect(await sqlStateOf("TRUNCATE sim_results")).toBe("42501")
      expect(await sqlStateOf("CREATE TABLE sim_escape (id int)")).toBe("42501")
    })
  },
)
