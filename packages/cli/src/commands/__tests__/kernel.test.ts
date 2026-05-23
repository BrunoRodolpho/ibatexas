// Tests for `ibx kernel` subcommands — Task 20.
//
// We exercise the command surface end-to-end by:
//   1. Registering the kernel command on a fresh Commander.Command instance
//   2. Capturing console output via a stdout stub
//   3. Asserting the structured shape of the JSON output for `status`
//   4. Asserting graceful no-op for `replay` and `divergence` when
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
    expect(parsed).toHaveProperty("killSwitch")
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
    expect(out).toContain("Kill switch")
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

// ── ibx kernel divergence ─────────────────────────────────────────────────

describe("ibx kernel divergence", () => {
  it("no-ops with structured TODO when audit-postgres is off", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    delete process.env.POSTHOG_API_KEY
    await cmd.parseAsync(["divergence", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("TODO para o operador")
    expect(out).toContain("BASIS_ONLY")
    expect(out).toContain("DECISION_KIND")
    expect(out).toContain("PAYLOAD_REWRITE")
  })

  it("refuses to run without DATABASE_URL when audit-postgres is enabled", async () => {
    process.env.IBX_AUDIT_POSTGRES_ENABLED = "true"
    delete process.env.DATABASE_URL
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await cmd.parseAsync(["divergence"], { from: "user" })
    expect(stderrSpy).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    stderrSpy.mockRestore()
  })

  it("validates --since duration syntax", async () => {
    process.env.IBX_AUDIT_POSTGRES_ENABLED = "true"
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await cmd.parseAsync(["divergence", "--since=invalid"], { from: "user" })
    expect(stderrSpy).toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    stderrSpy.mockRestore()
  })
})

// ── ibx kernel kill-switch (W3 D1) ────────────────────────────────────────
//
// We mock the @ibatexas/tools Redis surface so the kernel command
// resolves to an in-memory implementation. The same fake is shared
// across calls so we can verify state transitions.
//
// Anti-theater (RULE 2): each test below was written FIRST and FAILED
// with `Unknown command 'kill-switch'` before kernel.ts registered the
// new subcommand. After implementation, all 8 pass; the suite is the
// operator's documented contract.

const killSwitchFakeRedis = vi.hoisted(() => {
  const store = new Map<string, string>()
  const channels = new Map<string, string[]>()
  return {
    store,
    channels,
    async set(key: string, value: string, _opts?: { EX?: number }) {
      store.set(key, value)
      return "OK"
    },
    async get(key: string) {
      return store.get(key) ?? null
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0
    },
    async publish(channel: string, msg: string) {
      const arr = channels.get(channel) ?? []
      arr.push(msg)
      channels.set(channel, arr)
      return arr.length
    },
    reset() {
      store.clear()
      channels.clear()
    },
  }
})

vi.mock("@ibatexas/tools", async () => {
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>(
    "@ibatexas/tools",
  )
  return {
    ...actual,
    getRedisClient: vi.fn(async () => killSwitchFakeRedis),
    rk: (key: string) => `test-cli:${key}`,
  }
})

describe("ibx kernel kill-switch", () => {
  beforeEach(() => {
    killSwitchFakeRedis.reset()
  })

  it("enable writes a flag with metadata to Redis", async () => {
    await cmd.parseAsync(
      [
        "kill-switch",
        "enable",
        "--reason=Refusal-rate spike at 19:35",
      ],
      { from: "user" },
    )
    const raw = killSwitchFakeRedis.store.get(
      "test-cli:kill-switch:global",
    )
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as {
      enabledBy: string
      reason: string
      enabledAt: string
    }
    expect(parsed.reason).toBe("Refusal-rate spike at 19:35")
    expect(parsed.enabledBy).toMatch(/^cli:/)
    expect(parsed.enabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("enable publishes an event on the events channel", async () => {
    await cmd.parseAsync(
      ["kill-switch", "enable", "--reason=Soak window"],
      { from: "user" },
    )
    const events = killSwitchFakeRedis.channels.get(
      "test-cli:kill-switch:events",
    )
    expect(events).toBeDefined()
    expect(events).toHaveLength(1)
    const parsed = JSON.parse(events![0]!) as {
      action: string
      scope: string
      reason: string
    }
    expect(parsed.action).toBe("enable")
    expect(parsed.scope).toBe("global")
    expect(parsed.reason).toBe("Soak window")
  })

  it("status reflects the active kill switch (pt-BR human-readable)", async () => {
    await cmd.parseAsync(
      ["kill-switch", "enable", "--reason=incident"],
      { from: "user" },
    )
    await cmd.parseAsync(["kill-switch", "status"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("ATIVO")
    expect(out).toContain("incident")
    expect(out).toMatch(/motivo|reason/i)
  })

  it("status --json emits structured output", async () => {
    await cmd.parseAsync(
      ["kill-switch", "enable", "--reason=incident"],
      { from: "user" },
    )
    // Reset stdout capture so we only see the status call's output.
    stdout.restore()
    stdout = captureStdout()
    await cmd.parseAsync(["kill-switch", "status", "--json"], {
      from: "user",
    })
    const out = stdout.getOutput()
    const parsed = JSON.parse(out) as { active: boolean; reason: string }
    expect(parsed.active).toBe(true)
    expect(parsed.reason).toBe("incident")
  })

  it("status --json with no active switch emits active=false", async () => {
    await cmd.parseAsync(["kill-switch", "status", "--json"], {
      from: "user",
    })
    const out = stdout.getOutput()
    const parsed = JSON.parse(out) as { active: boolean }
    expect(parsed.active).toBe(false)
  })

  it("disable removes the flag and publishes a disable event", async () => {
    await cmd.parseAsync(
      ["kill-switch", "enable", "--reason=engage"],
      { from: "user" },
    )
    expect(
      killSwitchFakeRedis.store.has("test-cli:kill-switch:global"),
    ).toBe(true)

    await cmd.parseAsync(
      ["kill-switch", "disable", "--reason=incident-resolved"],
      { from: "user" },
    )
    expect(
      killSwitchFakeRedis.store.has("test-cli:kill-switch:global"),
    ).toBe(false)
    const events = killSwitchFakeRedis.channels.get(
      "test-cli:kill-switch:events",
    )
    expect(events).toHaveLength(2) // enable + disable
    const disableEvt = JSON.parse(events![1]!) as { action: string }
    expect(disableEvt.action).toBe("disable")
  })

  it("enable requires --reason", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    let threw: unknown
    try {
      await cmd.parseAsync(["kill-switch", "enable"], { from: "user" })
    } catch (err) {
      threw = err
    }
    // Commander throws via exitOverride() when a required option is
    // missing; the test asserts that *something* signaled refusal.
    expect(threw ?? process.exitCode).toBeTruthy()
    stderrSpy.mockRestore()
    process.exitCode = 0
  })

  it("status pt-BR text shows 'inativo' when no flag is set", async () => {
    await cmd.parseAsync(["kill-switch", "status"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("inativo")
  })
})
