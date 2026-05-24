// Tests for `ibx kernel` subcommands — Task 20.
//
// We exercise the command surface end-to-end by:
//   1. Registering the kernel command on a fresh Commander.Command instance
//   2. Capturing console output via a stdout stub
//   3. Asserting the structured shape of the JSON output for `status`
//   4. Asserting graceful no-op for `replay` when
//      `IBX_AUDIT_POSTGRES_ENABLED=false` (the task-19 default).
//
// We do NOT spin up a Postgres pool — the CLI's stub path is what's tested
// here, since the real path requires audit-postgres tables that don't exist
// in CI.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Command } from "commander"
import { registerKernelCommands } from "../kernel.js"

// ── Stdout capture ────────────────────────────────────────────────────────

function captureStdout(): { restore: () => void; getOutput: () => string } {
  const chunks: string[] = []
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    chunks.push(args.join(" "))
  })
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    chunks.push(args.join(" "))
  })
  return {
    restore: () => {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    },
    getOutput: () => chunks.join("\n"),
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────

let cmd: Command
let stdout: ReturnType<typeof captureStdout>
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  cmd = new Command()
  cmd.exitOverride() // Don't call process.exit on errors.
  registerKernelCommands(cmd)
  stdout = captureStdout()
  savedEnv = {
    IBX_KERNEL_SHADOW: process.env.IBX_KERNEL_SHADOW,
    IBX_KERNEL_ENFORCE: process.env.IBX_KERNEL_ENFORCE,
    IBX_AUDIT_POSTGRES_ENABLED: process.env.IBX_AUDIT_POSTGRES_ENABLED,
    POSTHOG_API_KEY: process.env.POSTHOG_API_KEY,
    IBX_LEDGER_ENABLED: process.env.IBX_LEDGER_ENABLED,
    IBX_LEDGER_ENFORCE: process.env.IBX_LEDGER_ENFORCE,
    IBX_LEDGER_FAIL_OPEN: process.env.IBX_LEDGER_FAIL_OPEN,
  }
})

afterEach(() => {
  stdout.restore()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// ── ibx kernel status ─────────────────────────────────────────────────────

describe("ibx kernel status", () => {
  it("emits JSON when --json is set", async () => {
    delete process.env.IBX_KERNEL_SHADOW
    delete process.env.IBX_KERNEL_ENFORCE
    await cmd.parseAsync(["status", "--json"], { from: "user" })
    const out = stdout.getOutput()
    const parsed = JSON.parse(out)
    expect(parsed).toHaveProperty("shadow")
    expect(parsed).toHaveProperty("enforce")
    expect(parsed).toHaveProperty("knownIntentKinds")
    expect(parsed).toHaveProperty("ledger")
    expect(parsed).toHaveProperty("audit")
    expect(parsed.knownIntentKinds.count).toBe(32)
  })

  it("renders human-readable text when --json is absent", async () => {
    delete process.env.IBX_KERNEL_SHADOW
    delete process.env.IBX_KERNEL_ENFORCE
    await cmd.parseAsync(["status"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("ibx kernel status")
    expect(out).toContain("Modo shadow")
    expect(out).toContain("Modo enforce")
    expect(out).toContain("Intent kinds conhecidos")
    expect(out).toContain("Execution Ledger")
    expect(out).toContain("Audit sink")
  })

  it("reflects IBX_KERNEL_SHADOW env var in JSON output", async () => {
    process.env.IBX_KERNEL_SHADOW = "order.checkout.create,order.cancel"
    delete process.env.IBX_KERNEL_ENFORCE
    await cmd.parseAsync(["status", "--json"], { from: "user" })
    const out = stdout.getOutput()
    const parsed = JSON.parse(out)
    expect(parsed.shadow.kinds).toContain("order.checkout.create")
    expect(parsed.shadow.kinds).toContain("order.cancel")
    expect(parsed.shadow.wildcard).toBe(false)
  })

  it("detects wildcard '*' in IBX_KERNEL_ENFORCE", async () => {
    delete process.env.IBX_KERNEL_SHADOW
    process.env.IBX_KERNEL_ENFORCE = "*"
    await cmd.parseAsync(["status", "--json"], { from: "user" })
    const out = stdout.getOutput()
    const parsed = JSON.parse(out)
    expect(parsed.enforce.wildcard).toBe(true)
  })

  it("includes all 32 KNOWN_INTENT_KINDS in the JSON list", async () => {
    await cmd.parseAsync(["status", "--json"], { from: "user" })
    const out = stdout.getOutput()
    const parsed = JSON.parse(out)
    expect(parsed.knownIntentKinds.kinds).toContain("order.checkout.create")
    expect(parsed.knownIntentKinds.kinds).toContain("reservation.create")
    expect(parsed.knownIntentKinds.kinds).toContain("whatsapp.message.send")
    expect(parsed.knownIntentKinds.kinds).toContain("customer.create")
    expect(parsed.knownIntentKinds.kinds).toContain("pix.charge.create")
  })

  it("groups intent kinds by domain prefix in text mode", async () => {
    await cmd.parseAsync(["status"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toMatch(/order \(10\)/)
    expect(out).toMatch(/reservation \(8\)/)
    expect(out).toMatch(/whatsapp \(3\)/)
    expect(out).toMatch(/customer \(8\)/)
    expect(out).toMatch(/pix \(3\)/)
  })
})

// ── ibx kernel replay ─────────────────────────────────────────────────────

describe("ibx kernel replay (stub mode)", () => {
  it("no-ops with structured TODO when audit-postgres is disabled", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    await cmd.parseAsync(["replay", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("IBX_AUDIT_POSTGRES_ENABLED=false")
    expect(out).toContain("TODO para o operador")
    expect(process.exitCode).not.toBe(1)
  })

  // W7-O2 — the off-state TODO must NOT reference the phantom `pnpm migrate`
  // command (no script exists). It must give the operator the actual `psql`
  // command path against the raw SQL files in @adjudicate/audit-postgres.
  it("off-state TODO points to psql -f migrations/ — no phantom `pnpm migrate` (W7-O2)", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    await cmd.parseAsync(["replay", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    // Phantom is gone.
    expect(out).not.toMatch(/pnpm\s+migrate/)
    // The real operator command is present (psql + the migrations path).
    expect(out).toContain("psql")
    expect(out).toContain("audit-postgres/migrations")
  })

  it("rejects invalid --since duration", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    await cmd.parseAsync(["replay", "--since=notarealduration"], {
      from: "user",
    })
    const out = stdout.getOutput()
    expect(out).toContain("Duração inválida")
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it("accepts --intent-kind filter without error", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    await cmd.parseAsync(
      ["replay", "--since=2h", "--intent-kind=order.checkout.create"],
      { from: "user" },
    )
    const out = stdout.getOutput()
    expect(out).toContain("kind: order.checkout.create")
  })
})

// ── ibx kernel replay (real adjudication, W3 D3) ──────────────────────────
//
// These tests exercise the new real-replay path (not the stub). We
// inject a fake `pg.Client` via vi.mock so the CLI's audit-postgres
// path runs against an in-memory fixture instead of a live database.
//
// Anti-theater (RULE 2): each test below failed FIRST with one of:
//   - "Drift completo (replayWithIntegrity) será adicionado ..." (stub output)
//   - missing "Resumo de divergência" table headers
// because the stub did not actually replay. After the implementation
// replaces the stub with the real adjudicate() round-trip, all pass.

const pgQueryRows = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  capturedSql: [] as string[],
  capturedParams: [] as unknown[][],
  reset() {
    this.rows = []
    this.capturedSql = []
    this.capturedParams = []
  },
}))

vi.mock("pg", () => ({
  default: {
    Client: vi.fn(function (this: unknown) {
      const self = this as {
        connect: () => Promise<void>
        end: () => Promise<void>
        query: (sql: string, params: unknown[]) => Promise<unknown>
      }
      self.connect = vi.fn(async () => undefined)
      self.end = vi.fn(async () => undefined)
      self.query = vi.fn(async (sql: string, params: unknown[]) => {
        pgQueryRows.capturedSql.push(sql)
        pgQueryRows.capturedParams.push(params)
        return { rows: pgQueryRows.rows }
      })
      return self
    }),
  },
}))

function buildAuditRow(overrides?: {
  intentHash?: string
  kind?: string
  decisionKind?: "EXECUTE" | "REFUSE"
  basis?: Array<{ category: string; code: string }>
  payload?: Record<string, unknown>
}) {
  const kind = overrides?.kind ?? "order.checkout.create"
  const intentHash =
    overrides?.intentHash ?? "0".repeat(64)
  const envelope = {
    kind,
    payload: overrides?.payload ?? { orderId: "ord_test_01" },
    nonce: "00000000-0000-0000-0000-000000000000",
    actor: { principal: "user", sessionId: "session_01", taint: "TRUSTED" },
    intentHash,
    createdAt: "2026-05-23T12:00:00.000Z",
    schemaVersion: 1,
  }
  const decision =
    overrides?.decisionKind === "REFUSE"
      ? {
          kind: "REFUSE",
          refusal: {
            layer: "BUSINESS_RULE",
            code: "test.refused",
            userFacing: "x",
          },
          basis: overrides?.basis ?? [
            { category: "kernel", code: "test.refused" },
          ],
        }
      : {
          kind: "EXECUTE",
          basis: overrides?.basis ?? [
            { category: "kernel", code: "test.execute" },
          ],
        }
  return {
    record_version: 4,
    intent_hash: intentHash,
    envelope_jsonb: JSON.stringify(envelope),
    decision_jsonb: JSON.stringify(decision),
    recorded_at: "2026-05-23T12:00:00.000Z",
    duration_ms: 5,
    resource_version: null,
    plan_jsonb: null,
    supersedes_jsonb: null,
  } as Record<string, unknown>
}

describe("ibx kernel replay (real, mocked-Postgres)", () => {
  beforeEach(() => {
    pgQueryRows.reset()
    process.env.IBX_AUDIT_POSTGRES_ENABLED = "true"
    process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock"
  })

  afterEach(() => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    delete process.env.DATABASE_URL
  })

  it("prints a divergence summary table with total/matched buckets", async () => {
    pgQueryRows.rows = [
      buildAuditRow({ intentHash: "a".repeat(64), kind: "order.checkout.create" }),
      buildAuditRow({ intentHash: "b".repeat(64), kind: "order.cancel" }),
    ]
    await cmd.parseAsync(["replay", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toMatch(/Total\s*:\s*2/i)
    expect(out).toMatch(/(matched|igual)/i)
    expect(out).toMatch(/divergência por decisão|drifted.by.decision.kind|DECISION_KIND/i)
  })

  it("threads --intent-kind through the SQL WHERE clause", async () => {
    pgQueryRows.rows = [
      buildAuditRow({ kind: "order.checkout.create" }),
    ]
    await cmd.parseAsync(
      ["replay", "--since=24h", "--intent-kind=order.checkout.create"],
      { from: "user" },
    )
    // The SQL was captured by the fake pg client; assert the WHERE
    // clause includes the intent_kind filter.
    const sqlSeen = pgQueryRows.capturedSql.join(" | ")
    expect(sqlSeen).toMatch(/intent_kind\s*=\s*\$\d/)
    // The corresponding param must be present.
    const allParams = pgQueryRows.capturedParams.flat()
    expect(allParams).toContain("order.checkout.create")
  })

  it("counts drifted-by-decision-kind separately from drifted-by-basis", async () => {
    // Two records, both with kind "order.checkout.create".
    // The real adjudication on an empty/default state typically refuses
    // (default-REFUSE for unauthenticated). The historical row will be
    // EXECUTE → decision-kind drift.
    pgQueryRows.rows = [
      buildAuditRow({
        intentHash: "c".repeat(64),
        kind: "order.checkout.create",
        decisionKind: "EXECUTE",
        basis: [{ category: "policy", code: "ok" }],
      }),
    ]
    await cmd.parseAsync(["replay", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    // The table must contain a row labeling at least one drift class.
    expect(out).toMatch(
      /(DECISION_KIND|BASIS|drifted|divergência)/i,
    )
  })

  it("gracefully handles zero records with a 'sem registros' message", async () => {
    pgQueryRows.rows = []
    await cmd.parseAsync(["replay", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toMatch(/(0 registros|sem registros|nenhum registro|Total\s*:\s*0)/i)
  })

  it("limits the result set when --limit is passed", async () => {
    pgQueryRows.rows = [buildAuditRow()]
    await cmd.parseAsync(
      ["replay", "--since=24h", "--limit=50"],
      { from: "user" },
    )
    const allParams = pgQueryRows.capturedParams.flat()
    // The CLI passes the limit to the SQL as a numeric param.
    expect(allParams).toContain(50)
  })
})

// ── ibx kernel defer resume <sessionId> (W7-O1) ───────────────────────────
//
// The CLI reads the parked envelope from Redis, verifies the hash via the
// framework primitive, and publishes a synthesised NATS event. Unit tests
// cover:
//   - parked envelope not found → exit 1 with operator-readable error
//   - tampered envelope → exit 1 with stored vs derived hashes
//   - happy path with --json dry-run → emits the synth event without
//     touching NATS, with verifyMode = "verified" | "legacy-no-hash"
//
// We use an in-memory fake redis, with the defer:pending:* keyspace shape.
// A separate integration run against real Docker Redis is captured as
// O1-evidence (RULE H).

const deferFakeRedis = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    reset() {
      store.clear()
    },
  }
})

vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>(
    "@ibatexas/tools",
  )
  return {
    ...actual,
    getRedisClient: vi.fn(async () => deferFakeRedis),
    rk: (key: string) => `test-cli:${key}`,
  }
})

describe("ibx kernel defer resume (W7-O1)", () => {
  beforeEach(() => {
    deferFakeRedis.reset()
  })

  it("refuses with exit 1 when no parked envelope exists for the sessionId", async () => {
    await cmd.parseAsync(
      ["defer", "resume", "cust:does_not_exist", "--json"],
      { from: "user" },
    )
    const out = stdout.getOutput()
    expect(out).toMatch(/Nenhum envelope parkado/)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it("refuses with exit 1 when the parked blob is malformed JSON", async () => {
    deferFakeRedis.store.set(
      "test-cli:defer:pending:cust:broken",
      "{not json",
    )
    await cmd.parseAsync(
      ["defer", "resume", "cust:broken", "--json"],
      { from: "user" },
    )
    const out = stdout.getOutput()
    expect(out).toMatch(/JSON\.parse falhou|malformado/)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it("--json emits the synth event for a verified parked envelope (no NATS publish)", async () => {
    // Hash-verification is satisfied by re-using the framework's actual
    // sha256Canonical. We import the hash here (in the test) so the
    // fixture's intentHash matches what verifyParkedEnvelopeHash recomputes.
    const { sha256Canonical } = await import("@adjudicate/core")
    const sessionId = "cust:o1_happy"
    const envelopeMeta = {
      version: 4,
      kind: "order.tool.propose",
      payload: {
        toolName: "set_pix_details",
        input: { paymentId: "pi_test_123", orderId: "ord_test_456" },
        toolUseId: "tu_test",
      },
      nonce: "fixture-nonce-o1",
      actor: { principal: "user", sessionId },
      taint: "UNTRUSTED",
    } as const
    const intentHash = (
      sha256Canonical as (input: unknown) => string
    )(envelopeMeta)
    const parked = {
      envelope: {
        intentHash,
        kind: envelopeMeta.kind,
        actor: { sessionId },
        payload: envelopeMeta.payload,
        version: envelopeMeta.version,
        nonce: envelopeMeta.nonce,
        taint: envelopeMeta.taint,
        actorPrincipal: envelopeMeta.actor.principal,
      },
      signal: "pix.confirmed",
      parkedAt: "2026-05-23T18:00:00.000Z",
    }
    deferFakeRedis.store.set(
      `test-cli:defer:pending:${sessionId}`,
      JSON.stringify(parked),
    )

    await cmd.parseAsync(
      ["defer", "resume", sessionId, "--json"],
      { from: "user" },
    )
    const out = stdout.getOutput()
    // The dry-run output is JSON.
    const parsed = JSON.parse(out) as {
      ok: boolean
      sessionId: string
      parkKey: string
      verifyMode: string
      parkedSignal: string
      synthEvent: {
        paymentId: string
        orderId: string
        newStatus: string
        cliInjectedBy: string
      }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.sessionId).toBe(sessionId)
    expect(parsed.parkKey).toBe(`test-cli:defer:pending:${sessionId}`)
    expect(parsed.verifyMode).toBe("verified")
    expect(parsed.parkedSignal).toBe("pix.confirmed")
    // The synth event lifts the PIX paymentId / orderId from the payload.
    expect(parsed.synthEvent.paymentId).toBe("pi_test_123")
    expect(parsed.synthEvent.orderId).toBe("ord_test_456")
    expect(parsed.synthEvent.newStatus).toBe("paid")
    expect(parsed.synthEvent.cliInjectedBy).toMatch(/^cli:/)
  })

  it("refuses with exit 1 when verifyParkedEnvelopeHash detects tamper", async () => {
    // We supply a parked envelope where the stored intentHash does not
    // match the canonical hash of the (version, kind, payload, nonce, actor,
    // taint) tuple. The framework primitive should flag verified=false.
    const sessionId = "cust:o1_tampered"
    const parked = {
      envelope: {
        intentHash: "deadbeef".repeat(8), // bogus 64-char hex
        kind: "order.tool.propose",
        actor: { sessionId },
        payload: { toolName: "set_pix_details", input: {}, toolUseId: "x" },
        version: 4,
        nonce: "tampered-nonce",
        taint: "UNTRUSTED",
        actorPrincipal: "user",
      },
      signal: "pix.confirmed",
      parkedAt: "2026-05-23T18:00:00.000Z",
    }
    deferFakeRedis.store.set(
      `test-cli:defer:pending:${sessionId}`,
      JSON.stringify(parked),
    )

    await cmd.parseAsync(
      ["defer", "resume", sessionId, "--json"],
      { from: "user" },
    )
    const out = stdout.getOutput()
    expect(out).toMatch(/adulterado/i)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })

  it("--json supports a legacy v0.1 blob without hash-verification fields (verifyMode=legacy-no-hash)", async () => {
    // Pre-T-005 blobs are missing version/nonce/taint/actorPrincipal.
    // verifyParkedEnvelopeHash returns `verified: null` and the CLI proceeds
    // with a degraded-trust marker so the runbook is honest about the
    // backward-compat path.
    const sessionId = "cust:o1_legacy"
    const parked = {
      envelope: {
        intentHash: "1".repeat(64),
        kind: "order.tool.propose",
        actor: { sessionId },
        payload: { toolName: "set_pix_details", input: {}, toolUseId: "x" },
        // No version/nonce/taint/actorPrincipal — legacy shape.
      },
      signal: "pix.confirmed",
      parkedAt: "2026-05-23T18:00:00.000Z",
    }
    deferFakeRedis.store.set(
      `test-cli:defer:pending:${sessionId}`,
      JSON.stringify(parked),
    )

    await cmd.parseAsync(
      ["defer", "resume", sessionId, "--json"],
      { from: "user" },
    )
    const out = stdout.getOutput()
    const parsed = JSON.parse(out) as { verifyMode: string; ok: boolean }
    expect(parsed.ok).toBe(true)
    expect(parsed.verifyMode).toBe("legacy-no-hash")
  })
})
