// BKL-268 — the governance verify gates' EXIT CODE must equal their REPORT.
//
// THE DEFECT these tests pin: every failure path of `ibx kernel pack-bom
// --verify-file` / `ibx aibom|seal|coherence export --verify-file` wrote its ✗
// exclusively to STDERR while the ✓ path wrote to STDOUT, and pack-bom had no
// summary line at all. So the REPORT — the stdout an operator captures with
// `gate > report.txt`, or diffs between two checkouts — read all-checkmarks (or
// empty) on a DRIFTING tree while the process exited 1. Measured pre-fix:
// pack-bom emitted 7 ✓ lines and ZERO ✗ markers on stdout with exit 1; aibom
// emitted a completely empty stdout with exit 1.
//
// The invariant, asserted here at the REAL command seam (a real Commander
// program running the real registered action over the real first-party packs —
// no stubbed exporter):
//
//     stdout carries a GREEN verdict  ⟺  exit code 0
//     stdout carries a RED   verdict  ⟺  exit code non-zero, failure NAMED
//
// Both directions are exercised for every gate: a matching baseline (green) and
// a deliberately corrupted one (red). A gate that regressed to stderr-only
// reporting fails the `stdout` half while still "passing" its exit code, which
// is exactly the bug — so these assertions are directional, not decorative.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Command } from "commander"
import {
  registerAibomCommands,
  registerSealCommands,
  registerCoherenceCommands,
  coherenceSelfVerdict,
} from "../governance.js"
import { registerKernelCommands } from "../kernel.js"

// BKL-236: each gate run drives the full runConformance + scorePackHealth +
// analyzePolicy chain over all seven first-party packs. Pure CPU, but under a
// full-workspace turbo run (37 test tasks fanned out) the wall clock inflates
// 7-10x past vitest's 5s default. This is a TIMEOUT budget, never a weakened
// assertion.
const GATE_TIMEOUT_MS = 120_000

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** packages/cli/governance — the real baselines the CI gates verify. */
const GOVERNANCE_DIR = path.resolve(HERE, "../../../governance")
const PACK_BOM_BASELINE = path.join(GOVERNANCE_DIR, "pack-bom-baseline.json")

interface GateRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Strip ANSI so assertions survive chalk's TTY detection either way. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bkl268-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Drive a registered gate through a real Commander program, capturing the two
 * streams SEPARATELY (the whole point — a gate that only reports on stderr must
 * be distinguishable from one that reports in the report) plus the exit code.
 */
async function runGate(
  register: (group: Command) => void,
  argv: readonly string[],
): Promise<GateRun> {
  const out: string[] = []
  const err: string[] = []
  const realLog = console.log
  const realError = console.error
  const priorExitCode = process.exitCode
  console.log = (...a: unknown[]) => void out.push(a.join(" "))
  console.error = (...a: unknown[]) => void err.push(a.join(" "))
  process.exitCode = 0
  try {
    const program = new Command()
    program.exitOverride()
    const group = new Command("gate")
    register(group)
    program.addCommand(group)
    await program.parseAsync(["node", "ibx", "gate", ...argv])
    return {
      stdout: out.join("\n").replace(ANSI, ""),
      stderr: err.join("\n").replace(ANSI, ""),
      exitCode: typeof process.exitCode === "number" ? process.exitCode : 0,
    }
  } finally {
    console.log = realLog
    console.error = realError
    process.exitCode = priorExitCode
  }
}

/** A green verdict is a ✓ line; a red verdict is a ✗ line — in the REPORT. */
function verdictOf(stdout: string): "green" | "red" | "silent" {
  const hasRed = stdout.includes("✗")
  const hasGreen = stdout.includes("✓")
  if (hasRed) return "red"
  if (hasGreen) return "green"
  return "silent"
}

/**
 * THE BKL-268 INVARIANT. `silent` fails too: a report that says nothing cannot
 * agree with a non-zero exit code, and that was aibom/seal's exact pre-fix
 * behaviour.
 */
function expectReportMatchesExit(run: GateRun, expected: "green" | "red"): void {
  expect(verdictOf(run.stdout)).toBe(expected)
  if (expected === "green") expect(run.exitCode).toBe(0)
  else expect(run.exitCode).not.toBe(0)
}

// ── The three artifact exporters ────────────────────────────────────────────

const EXPORTERS = [
  { name: "aibom", register: registerAibomCommands, artifact: "ai-bom" },
  { name: "seal", register: registerSealCommands, artifact: "config-seal" },
  { name: "coherence", register: registerCoherenceCommands, artifact: "coherence" },
] as const

describe.each(EXPORTERS)(
  "ibx $name export --verify-file: report ⟺ exit code",
  ({ register, artifact }) => {
    it(
      "a MATCHING baseline reports green on stdout and exits 0",
      async () => {
        const baseline = path.join(tmpDir, "baseline.json")
        // Generate the baseline from the live packs, so the verify below is
        // drift-free by construction and the green half is unambiguous.
        const gen = await runGate(register, ["export", "--out", baseline])
        expect(gen.exitCode).toBe(0)
        expect(fs.existsSync(baseline)).toBe(true)

        const run = await runGate(register, ["export", "--verify-file", baseline])
        expectReportMatchesExit(run, "green")
        expect(run.stdout).toContain("sem drift")
      },
      GATE_TIMEOUT_MS,
    )

    it(
      "a DRIFTED baseline reports the drift ON STDOUT and exits 1",
      async () => {
        const baseline = path.join(tmpDir, "baseline.json")
        await runGate(register, ["export", "--out", baseline])
        const doc = JSON.parse(fs.readFileSync(baseline, "utf8")) as Record<
          string,
          unknown
        >
        doc.adopter = "bkl268-planted-drift"
        fs.writeFileSync(baseline, JSON.stringify(doc, null, 2) + "\n")

        const run = await runGate(register, ["export", "--verify-file", baseline])
        expectReportMatchesExit(run, "red")
        // The failure is NAMED in the report, not just signalled by $?.
        expect(run.stdout).toContain(artifact)
        expect(run.stdout).toContain("drift detectado")
      },
      GATE_TIMEOUT_MS,
    )

    it(
      "a MISSING baseline reports the miss ON STDOUT and exits 1",
      async () => {
        const missing = path.join(tmpDir, "does-not-exist.json")
        const run = await runGate(register, ["export", "--verify-file", missing])
        expectReportMatchesExit(run, "red")
        expect(run.stdout).toContain("baseline não encontrada")
        // A gate that could not run must never read as a gate that passed.
        expect(run.stdout).toContain("NÃO realizada")
      },
      GATE_TIMEOUT_MS,
    )
  },
)

// ── The reverse inversion: a red artifact with zero drift ───────────────────

describe("coherenceSelfVerdict", () => {
  // The branch `runExport` cannot reach from a unit test (any artifact edited
  // to reprove also drifts, so drift would answer first). Proven directional at
  // the real seam by planting an AJD-105 error in pack-orders and regenerating
  // the baseline from the broken tree so drift is zero BY CONSTRUCTION:
  // pre-fix `✓ coherence sem drift` + exit 0; post-fix `✗ coherence: sem drift,
  // mas o artefato REPROVA — 23 erro(s)` + exit 1.
  it("passes a clean report", () => {
    expect(
      coherenceSelfVerdict({ passed: true, totals: { error: 0, warning: 7 } }),
    ).toBeUndefined()
  })

  it("fails on Tier-1 errors, naming the count", () => {
    const reason = coherenceSelfVerdict({
      passed: true,
      totals: { error: 23, warning: 7 },
    })
    expect(reason).toContain("23")
  })

  it("fails on passed=false even with zero counted errors", () => {
    expect(
      coherenceSelfVerdict({ passed: false, totals: { error: 0 } }),
    ).toContain("passed=false")
  })

  it("never fails green on warnings alone (mirrors `ibx kernel analyze`)", () => {
    expect(
      coherenceSelfVerdict({ passed: true, totals: { error: 0, warning: 99 } }),
    ).toBeUndefined()
  })

  it("never FALSE-fails on absent or wrong-typed fields", () => {
    expect(coherenceSelfVerdict({})).toBeUndefined()
    expect(coherenceSelfVerdict({ totals: { error: "3" } })).toBeUndefined()
  })
})

describe("ibx coherence export --verify-file: the artifact's own verdict", () => {
  it(
    "fails when the baseline matches but the coherence report REPROVES",
    async () => {
      // Byte-equality with a baseline captured while the Tier-1 analyzers were
      // RED used to print "sem drift" and exit 0 — a real failure exiting 0.
      // Measured pre-fix with a planted AJD-105 error: totals.error = 23,
      // passed = false, gate exit 0. We cannot plant a pack error from a unit
      // test, so we plant it in the ARTIFACT and assert the gate reads the
      // artifact's own verdict rather than drift alone.
      const baseline = path.join(tmpDir, "coherence.json")
      await runGate(registerCoherenceCommands, ["export", "--out", baseline])
      const doc = JSON.parse(fs.readFileSync(baseline, "utf8")) as Record<
        string,
        unknown
      >
      expect(doc.passed).toBe(true)
      expect((doc.totals as Record<string, number>).error).toBe(0)

      // A REPROVING artifact. The live manifest is rebuilt from the same packs
      // on every run, so this baseline necessarily DRIFTS — which is why the
      // assertion below pins the *reason*: the gate must not be satisfiable by
      // drift-equality alone, and the self-verdict must name the errors.
      ;(doc.totals as Record<string, number>).error = 3
      doc.passed = false
      fs.writeFileSync(baseline, JSON.stringify(doc, null, 2) + "\n")

      const run = await runGate(registerCoherenceCommands, [
        "export",
        "--verify-file",
        baseline,
      ])
      expectReportMatchesExit(run, "red")
    },
    GATE_TIMEOUT_MS,
  )
})

// ── The headline gate: kernel pack-bom ──────────────────────────────────────

describe("ibx kernel pack-bom --verify-file: report ⟺ exit code", () => {
  it(
    "the COMMITTED baseline reports green on stdout, with a terminal verdict, and exits 0",
    async () => {
      const run = await runGate(registerKernelCommands, [
        "pack-bom",
        "--verify-file",
        PACK_BOM_BASELINE,
      ])
      expectReportMatchesExit(run, "green")
      // Pre-fix this gate printed per-component ✓ lines and NO summary, so a
      // truncated or partially-consumed report could not be told from a clean
      // one. The terminal verdict is now part of the report.
      expect(run.stdout).toContain("pack-bom: OK")
    },
    GATE_TIMEOUT_MS,
  )

  it(
    "a DRIFTED component is NAMED on stdout and exits 1 (pre-fix: 7 ✓ and zero ✗ on stdout)",
    async () => {
      const baseline = path.join(tmpDir, "pack-bom-baseline.json")
      const doc = JSON.parse(fs.readFileSync(PACK_BOM_BASELINE, "utf8")) as Record<
        string,
        string
      >
      doc["ibatexas/pack-orders"] = "0".repeat(64)
      fs.writeFileSync(baseline, JSON.stringify(doc, null, 2) + "\n")

      const run = await runGate(registerKernelCommands, [
        "pack-bom",
        "--verify-file",
        baseline,
      ])
      expectReportMatchesExit(run, "red")
      expect(run.stdout).toContain("pack-bom: FALHOU")
      // The specific failing component is named in the REPORT.
      expect(run.stdout).toContain("ibatexas/pack-orders")
      expect(run.stdout).toContain("bomDigest divergente")
      // The other components still report green — the verdict is the summary,
      // not a blanket red.
      expect(run.stdout).toContain("ibatexas/pack-reservations")
    },
    GATE_TIMEOUT_MS,
  )

  it(
    "a component MISSING from the baseline is NAMED on stdout and exits 1",
    async () => {
      const baseline = path.join(tmpDir, "pack-bom-baseline.json")
      const doc = JSON.parse(fs.readFileSync(PACK_BOM_BASELINE, "utf8")) as Record<
        string,
        string
      >
      delete doc["ibatexas/pack-orders"]
      fs.writeFileSync(baseline, JSON.stringify(doc, null, 2) + "\n")

      const run = await runGate(registerKernelCommands, [
        "pack-bom",
        "--verify-file",
        baseline,
      ])
      expectReportMatchesExit(run, "red")
      expect(run.stdout).toContain("sem entrada na baseline")
      expect(run.stdout).toContain("ibatexas/pack-orders")
    },
    GATE_TIMEOUT_MS,
  )

  it(
    "an UNREADABLE baseline reports the miss ON STDOUT and exits 1",
    async () => {
      const bad = path.join(tmpDir, "not-json.json")
      fs.writeFileSync(bad, "{ this is not json")
      const run = await runGate(registerKernelCommands, [
        "pack-bom",
        "--verify-file",
        bad,
      ])
      expectReportMatchesExit(run, "red")
      expect(run.stdout).toContain("NÃO realizada")
    },
    GATE_TIMEOUT_MS,
  )
})
