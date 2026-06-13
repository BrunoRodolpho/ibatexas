// T1a-7 — AuditReader against a REAL audit-postgres schema (postgres
// testcontainer).
//
// Why a testcontainer, not a mock: the properties under test only exist on a
// live migrated schema — run-sessionId namespace scoping via SQL (`= ANY` +
// escaped LIKE prefix), chronological ordering across RANGE partitions, JSONB
// round-tripping through the package's `rowToRecord`, tamper-evidence
// (`verifyAuditRecord`) over rows a hostile UPDATE actually modified, and the
// SELECT-only ibx_oracle_ro containment path the reader's default factory
// enforces (T1a-9).
//
// Migrations are applied with an INLINED port of the kernel-migrate runner
// pattern (apps/api/src/__tests__/audit-read-paths.test.ts): journeys can
// never import apps/api or packages/cli code (check-bypass legs), so the
// small apply-once + monthly-partition helper lives here. Seeding goes
// through the production WRITE path (`createPostgresSink` + INSERT_AUDIT_SQL
// / auditInsertParams), so reads are exercised against rows shaped exactly
// as the live audit sink writes them.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readdir, readFile } from "node:fs/promises"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers"
import {
  AUDIT_RECORD_VERSION,
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  refuse,
  type AuditRecord,
  type Decision,
  type IntentActor,
} from "@adjudicate/core"
import { INSERT_AUDIT_SQL, auditInsertParams, createPostgresSink } from "@adjudicate/audit-postgres"
import {
  AuditReaderScopeError,
  createAuditReader,
  runNamespacePrefix,
  verifyFetchedRecords,
  type AuditReader,
} from "../audit-reader.js"
import { matchTrajectory } from "../audit-trail-matcher.js"

// Mirror the repo's postgres-container convention: local-only opt-out, CI runs real.
const SKIP_REAL_POSTGRES = process.env["IBX_SKIP_REAL_POSTGRES"] === "1"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, "../../..")
const REPO_ROOT = path.resolve(PKG_ROOT, "../..")

const ADMIN_USER = "ibatexas"
const ADMIN_PASSWORD = "ibx-admin-test-pw"
const DB_NAME = "ibatexas_test"
const ORACLE_PASSWORD = "0123456789abcdef0123456789abcdef" // hex, like gen-env-test.sh

// ── Inlined migration applier (kernel-migrate pattern, journeys-local) ───────

const AUDIT_MIGRATION_FILE_RE = /^\d{3}-.*\.sql$/

function resolveAuditMigrationsDir(): string {
  const candidates = [
    path.join(PKG_ROOT, "node_modules/@adjudicate/audit-postgres/migrations"),
    path.join(REPO_ROOT, "node_modules/@adjudicate/audit-postgres/migrations"),
    path.join(REPO_ROOT, "apps/api/node_modules/@adjudicate/audit-postgres/migrations"),
  ]
  for (const dir of candidates) {
    if (
      fs.existsSync(dir) &&
      fs.statSync(dir).isDirectory() &&
      fs.readdirSync(dir).some((f) => AUDIT_MIGRATION_FILE_RE.test(f))
    ) {
      return dir
    }
  }
  throw new Error(
    `Could not locate @adjudicate/audit-postgres migrations. Looked in:\n  ${candidates.join("\n  ")}`,
  )
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** Apply the audit-postgres migrations in order, then the monthly partitions. */
async function applyAuditMigrations(client: pg.Client, now: Date): Promise<void> {
  const dir = resolveAuditMigrationsDir()
  const files = (await readdir(dir)).filter((f) => AUDIT_MIGRATION_FILE_RE.test(f)).sort()
  expect(files.length).toBeGreaterThanOrEqual(10) // sanity: the full kernel set
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8")
    await client.query("BEGIN")
    try {
      await client.query(sql)
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  }
  // Monthly intent_audit partitions covering [now-1 month, now+1 month].
  for (let offset = -1; offset <= 1; offset++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1))
    const name = `intent_audit_${start.getUTCFullYear()}_${pad2(start.getUTCMonth() + 1)}`
    const from = `${start.toISOString().slice(0, 10)} 00:00:00+00`
    const to = `${next.toISOString().slice(0, 10)} 00:00:00+00`
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF intent_audit ` +
        `FOR VALUES FROM ('${from}') TO ('${to}')`,
    )
  }
}

/** Provision the SELECT-only oracle role with the REAL checked-in SQL (T1a-9). */
async function provisionOracleRole(client: pg.Client): Promise<void> {
  const sqlPath = path.join(REPO_ROOT, "scripts/test-stack/create-readonly-role.sql")
  const template = await readFile(sqlPath, "utf8")
  expect(template).toContain("__ORACLE_PASSWORD__")
  await client.query(template.replaceAll("__ORACLE_PASSWORD__", ORACLE_PASSWORD))
}

// ── Seeds ────────────────────────────────────────────────────────────────────

const NOW_MS = Date.now()
const MINUTE = 60_000
const isoAgo = (minutes: number): string => new Date(NOW_MS - minutes * MINUTE).toISOString()

const BASIS = [{ category: "business", code: "rule_satisfied" }] as const

function seed(args: {
  kind: string
  sessionId: string
  payload: Record<string, unknown>
  at: string
  nonce: string
  decision?: Decision
  principal?: IntentActor["principal"]
  supersedes?: AuditRecord["supersedes"]
  envelope?: ReturnType<typeof buildEnvelope>
}): AuditRecord {
  const envelope =
    args.envelope ??
    buildEnvelope({
      kind: args.kind,
      payload: args.payload,
      actor: { principal: args.principal ?? "llm", sessionId: args.sessionId },
      taint: "UNTRUSTED",
      nonce: args.nonce,
      createdAt: args.at,
    })
  // buildAuditRecord computes the v4+ auditHash — fetched rows must VERIFY.
  return buildAuditRecord({
    envelope,
    decision: args.decision ?? decisionExecute([...BASIS]),
    durationMs: 1,
    at: args.at,
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
  })
}

// Run under test: "run-alpha". The harness records the SUT-minted chat handle
// (web:sess-alpha) and mints jrun:run-alpha:* identifiers for trigger acts.
const ALPHA_SCOPE = {
  sessionIds: ["web:sess-alpha"],
  sessionIdPrefix: runNamespacePrefix("run-alpha"),
}

const rCart = seed({
  kind: "cart.item.add",
  sessionId: "web:sess-alpha",
  payload: { handle: "costela-bovina-defumada", qty: 1 },
  at: isoAgo(50),
  nonce: "t1a7-alpha-cart",
})
// Confirmation chain: same envelope adjudicated twice (awaiting → resolved).
const checkoutEnvelope = buildEnvelope({
  kind: "order.checkout.create",
  payload: { customerId: "cus_alpha" },
  actor: { principal: "llm", sessionId: "web:sess-alpha" },
  taint: "UNTRUSTED",
  nonce: "t1a7-alpha-checkout",
  createdAt: isoAgo(40),
})
const rAwait = seed({
  kind: "order.checkout.create",
  sessionId: "web:sess-alpha",
  payload: {},
  envelope: checkoutEnvelope,
  decision: decisionRequestConfirmation("Confirma o pedido?", [...BASIS]),
  at: isoAgo(40),
  nonce: "unused",
})
const rResolved = seed({
  kind: "order.checkout.create",
  sessionId: "web:sess-alpha",
  payload: {},
  envelope: checkoutEnvelope,
  at: isoAgo(39),
  nonce: "unused",
  supersedes: {
    predecessorIntentHash: rAwait.intentHash,
    predecessorAt: rAwait.at,
    reason: "confirmation_resolved",
  },
})
// Harness-minted (run-namespaced) trigger act — scoped by prefix, not by set.
const rTrigger = seed({
  kind: "order.note.add",
  sessionId: "jrun:run-alpha:trigger-1",
  principal: "system",
  payload: { orderId: "ord_alpha", note: "gatilho do harness" },
  at: isoAgo(30),
  nonce: "t1a7-alpha-trigger",
})
// Will be tampered post-insert via an admin UPDATE (duration_ms is in the
// auditHash pre-image, so verification must flag it).
const rTampered = seed({
  kind: "order.cancel",
  sessionId: "web:sess-alpha",
  payload: { orderId: "ord_alpha" },
  decision: decisionRefuse(
    refuse("BUSINESS_RULE", "replay_suppressed", "Pedido já processado."),
    [{ category: "ledger", code: "replay_suppressed" }],
  ),
  at: isoAgo(20),
  nonce: "t1a7-alpha-tampered",
})
// Hand-built WITHOUT auditHash (pre-v4 style) — verification → missing_hash.
const noHashEnvelope = buildEnvelope({
  kind: "order.note.add",
  payload: { orderId: "ord_alpha", note: "sem hash" },
  actor: { principal: "user", sessionId: "web:sess-alpha" },
  taint: "UNTRUSTED",
  nonce: "t1a7-alpha-nohash",
  createdAt: isoAgo(10),
})
const rNoHash: AuditRecord = {
  version: AUDIT_RECORD_VERSION,
  intentHash: noHashEnvelope.intentHash,
  envelope: noHashEnvelope,
  decision: decisionExecute([...BASIS]),
  decision_basis: [...BASIS],
  at: isoAgo(10),
  durationMs: 1,
}

// Outside the run's namespace — must be invisible to ALPHA_SCOPE reads.
const oBeta = seed({
  kind: "cart.item.add",
  sessionId: "web:sess-beta",
  payload: { handle: "linguica-artesanal", qty: 2 },
  at: isoAgo(45),
  nonce: "t1a7-beta-cart",
})
const oOtherRun = seed({
  kind: "order.note.add",
  sessionId: "jrun:run-beta:trigger-1",
  principal: "system",
  payload: { orderId: "ord_beta", note: "outra run" },
  at: isoAgo(25),
  nonce: "t1a7-beta-trigger",
})
// LIKE-escaping pair: prefix jrun:run_x: must match ONLY the literal
// underscore session — never "jrun:runax:" via an unescaped `_` wildcard.
const oUnderscore = seed({
  kind: "cart.item.add",
  sessionId: "jrun:run_x:a",
  payload: { handle: "costela-bovina-defumada", qty: 1 },
  at: isoAgo(15),
  nonce: "t1a7-underscore",
})
const oUnderscoreBait = seed({
  kind: "cart.item.add",
  sessionId: "jrun:runax:b",
  payload: { handle: "costela-bovina-defumada", qty: 1 },
  at: isoAgo(14),
  nonce: "t1a7-underscore-bait",
})

const ALL_SEEDS = [
  rCart,
  rAwait,
  rResolved,
  rTrigger,
  rTampered,
  rNoHash,
  oBeta,
  oOtherRun,
  oUnderscore,
  oUnderscoreBait,
]

const tupleOf = (r: AuditRecord): [string, string] => [r.envelope.kind, r.decision.kind]

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_REAL_POSTGRES)("AuditReader (postgres testcontainer)", () => {
  let container: StartedTestContainer
  let adminPool: pg.Pool
  let reader: AuditReader

  beforeAll(async () => {
    container = await new GenericContainer("postgres:17-alpine")
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: ADMIN_USER,
        POSTGRES_PASSWORD: ADMIN_PASSWORD,
        POSTGRES_DB: DB_NAME,
      })
      // initdb restarts postgres once; the port being open is not enough.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .withStartupTimeout(120_000)
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(5432)
    const adminUrl = `postgresql://${ADMIN_USER}:${ADMIN_PASSWORD}@${host}:${port}/${DB_NAME}`

    // Migrations + role provisioning on a single client (transaction-per-file).
    const setupClient = new pg.Client({ connectionString: adminUrl })
    await setupClient.connect()
    try {
      await applyAuditMigrations(setupClient, new Date(NOW_MS))
      // The provisioning SQL's ordering guard requires the domain schema.
      await setupClient.query("CREATE SCHEMA IF NOT EXISTS ibx_domain")
      await provisionOracleRole(setupClient)
    } finally {
      await setupClient.end()
    }

    // Seed through the production write path.
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 4 })
    const sink = createPostgresSink({
      writer: {
        insertAudit: async (row) => {
          await adminPool.query(INSERT_AUDIT_SQL, [...auditInsertParams(row)])
        },
      },
    })
    for (const record of ALL_SEEDS) await sink.emit(record)

    // Out-of-band tamper: duration_ms is inside the auditHash pre-image.
    const tampered = await adminPool.query(
      "UPDATE intent_audit SET duration_ms = 9999 WHERE intent_hash = $1",
      [rTampered.intentHash],
    )
    expect(tampered.rowCount).toBe(1)

    // The reader's DEFAULT factory path: ORACLE_DATABASE_URL validated to the
    // SELECT-only role — the oracle never holds a writable connection.
    reader = createAuditReader({
      env: {
        ORACLE_DATABASE_URL: `postgresql://ibx_oracle_ro:${ORACLE_PASSWORD}@${host}:${port}/${DB_NAME}`,
      },
    })
  }, 240_000)

  afterAll(async () => {
    await reader?.close().catch(() => undefined)
    await adminPool?.end().catch(() => undefined)
    await container?.stop({ remove: true, timeout: 10_000 }).catch(() => undefined)
  }, 60_000)

  describe("run-sessionId namespace scoping", () => {
    it("union scope (recorded set + run prefix) sees exactly the run's rows, chronological", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE)
      expect(records.map(tupleOf)).toEqual([
        ["cart.item.add", "EXECUTE"],
        ["order.checkout.create", "REQUEST_CONFIRMATION"],
        ["order.checkout.create", "EXECUTE"],
        ["order.note.add", "EXECUTE"],
        ["order.cancel", "REFUSE"],
        ["order.note.add", "EXECUTE"],
      ])
      const ats = records.map((r) => r.at)
      expect([...ats].sort()).toEqual(ats)
      // Rows outside the namespace are invisible by construction.
      const hashes = new Set(records.map((r) => r.intentHash))
      for (const outside of [oBeta, oOtherRun, oUnderscore, oUnderscoreBait]) {
        expect(hashes.has(outside.intentHash)).toBe(false)
      }
    })

    it("prefix-only scope sees only harness-minted run-namespaced sessions", async () => {
      const records = await reader.fetchRecords({
        sessionIdPrefix: runNamespacePrefix("run-alpha"),
      })
      expect(records.map((r) => r.intentHash)).toEqual([rTrigger.intentHash])
      expect(records[0]!.envelope.actor.sessionId).toBe("jrun:run-alpha:trigger-1")
    })

    it("sessionIds-only scope sees only the recorded session set", async () => {
      const records = await reader.fetchRecords({ sessionIds: ["web:sess-alpha"] })
      expect(records).toHaveLength(5)
      expect(records.every((r) => r.envelope.actor.sessionId === "web:sess-alpha")).toBe(true)
    })

    it("REFUSES unscoped reads (AuditReaderScopeError)", async () => {
      await expect(reader.fetchRecords({})).rejects.toThrow(AuditReaderScopeError)
      await expect(reader.fetchRecords({ sessionIds: [] })).rejects.toThrow(
        AuditReaderScopeError,
      )
    })

    it("escapes LIKE metacharacters — a runId underscore is literal, not a wildcard", async () => {
      const records = await reader.fetchRecords({
        sessionIdPrefix: runNamespacePrefix("run_x"),
      })
      expect(records.map((r) => r.intentHash)).toEqual([oUnderscore.intentHash])
    })

    it("a scope nothing was recorded under sees nothing", async () => {
      await expect(
        reader.fetchRecords({ sessionIds: ["web:sess-ghost"] }),
      ).resolves.toEqual([])
    })
  })

  describe("fetch filters", () => {
    it("filters by intentKind", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, { intentKind: "cart.item.add" })
      expect(records.map((r) => r.intentHash)).toEqual([rCart.intentHash])
    })

    it("filters by decision kind", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, { decision: "REFUSE" })
      expect(records.map((r) => r.intentHash)).toEqual([rTampered.intentHash])
    })

    it("honors the since lower bound", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, {
        since: new Date(NOW_MS - 35 * MINUTE),
      })
      expect(records.map((r) => r.envelope.kind)).toEqual([
        "order.note.add",
        "order.cancel",
        "order.note.add",
      ])
    })

    it("caps rows via limit, keeping chronological head", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, { limit: 2 })
      expect(records.map(tupleOf)).toEqual([
        ["cart.item.add", "EXECUTE"],
        ["order.checkout.create", "REQUEST_CONFIRMATION"],
      ])
    })
  })

  describe("rowToRecord round-trip + tamper-evidence (audit.record.verified)", () => {
    it("round-trips the supersession link through the package's rowToRecord", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, {
        intentKind: "order.checkout.create",
      })
      expect(records).toHaveLength(2)
      const resolved = records[1]!
      expect(resolved.decision.kind).toBe("EXECUTE")
      expect(resolved.supersedes).toEqual({
        predecessorIntentHash: rAwait.intentHash,
        predecessorAt: rAwait.at,
        reason: "confirmation_resolved",
      })
      expect(resolved.envelope.payload).toEqual({ customerId: "cus_alpha" })
    })

    it("intact records verify (verifyAuditRecord via verifyFetchedRecords)", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, {
        until: new Date(NOW_MS - 25 * MINUTE), // before the tampered/no-hash rows
      })
      expect(records).toHaveLength(4)
      const report = verifyFetchedRecords(records)
      expect(report).toMatchObject({
        ok: true,
        total: 4,
        verifiedCount: 4,
        missingHashCount: 0,
        failures: [],
      })
    })

    it("a row tampered out-of-band fails verification with reason tampered", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE)
      const report = verifyFetchedRecords(records)
      expect(report.ok).toBe(false)
      const tampered = report.failures.find((f) => f.reason === "tampered")
      expect(tampered).toMatchObject({
        intentHash: rTampered.intentHash,
        intentKind: "order.cancel",
      })
      expect(tampered?.derived).not.toBe(tampered?.stored)
    })

    it("a hash-less record fails closed by default, tolerated only via allowMissingHash", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE, {
        since: new Date(NOW_MS - 12 * MINUTE), // only the no-hash row
      })
      expect(records.map((r) => r.intentHash)).toEqual([rNoHash.intentHash])
      const strict = verifyFetchedRecords(records)
      expect(strict.ok).toBe(false)
      expect(strict.failures).toEqual([
        {
          intentHash: rNoHash.intentHash,
          intentKind: "order.note.add",
          at: rNoHash.at,
          reason: "missing_hash",
        },
      ])
      const tolerant = verifyFetchedRecords(records, { allowMissingHash: true })
      expect(tolerant).toMatchObject({ ok: true, missingHashCount: 1 })
    })
  })

  describe("matcher over a FETCHED trail (audit.trajectory.in_order, end-to-end)", () => {
    it("matches the run's trajectory with supersession chains resolved", async () => {
      const records = await reader.fetchRecords(ALPHA_SCOPE)
      const result = matchTrajectory(
        records,
        [
          { intentKind: "cart.item.add", decision: "EXECUTE" },
          { intentKind: "order.checkout.create", decision: "EXECUTE" },
          {
            intentKind: "order.cancel",
            decision: "REFUSE",
            where: (_payload, r) =>
              r.decision_basis.some(
                (b) => b.category === "ledger" && b.code === "replay_suppressed",
              ),
          },
        ],
        { mode: "IN_ORDER" },
      )
      expect(result.diff).toContain("audit trajectory matched (mode=IN_ORDER)")
      expect(result.ok).toBe(true)
      // The awaiting REQUEST_CONFIRMATION collapsed into its chain head.
      expect(result.observed.map((o) => o.decision)).not.toContain("REQUEST_CONFIRMATION")
      expect(result.supersession?.chains).toHaveLength(1)
    })
  })
})
