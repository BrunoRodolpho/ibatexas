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

// ── ibx kernel divergence ─────────────────────────────────────────────────

describe("ibx kernel divergence (stub mode)", () => {
  it("no-ops with structured TODO when no telemetry is wired", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    delete process.env.POSTHOG_API_KEY
    await cmd.parseAsync(["divergence", "--since=24h"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("TODO para o operador")
    expect(out).toContain("BASIS_ONLY")
    expect(out).toContain("DECISION_KIND")
    expect(out).toContain("PAYLOAD_REWRITE")
  })

  it("renders placeholder summary when audit-postgres is enabled", async () => {
    process.env.IBX_AUDIT_POSTGRES_ENABLED = "true"
    delete process.env.POSTHOG_API_KEY
    await cmd.parseAsync(["divergence"], { from: "user" })
    const out = stdout.getOutput()
    expect(out).toContain("formato stub")
    expect(out).toContain("BASIS_ONLY")
  })
})
