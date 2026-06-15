// T1b-3 — `ibx kernel replay` as a CI gate: seeded-drift tests over the full
// exit-code contract, the `--ci` fail-closed legs, the agent-namespace
// exclusion, `--seed-file` golden-vector seeding, and `--update-golden`
// regeneration.
//
// Exit-code contract under test (see replayExitCode in ../kernel.ts):
//   0 — clean (every record reproduced its historical decision)
//   1 — errors (unreliable run: pack coverage gaps, --ci vacuous-gate refusals)
//   2 — drift detected (sound run, policy diverged)
//
// We exercise the command surface end-to-end (Commander + runReplay) with a
// fake `pg.Client` (vi.mock) so the audit-postgres path runs against
// in-memory fixtures. Adjudication is REAL — the first-party packs resolve in
// the workspace and `adjudicate()` runs against the empty replay state, which
// is exactly what the live gate does. The committed golden-vector file
// doubles as a fixture, so this suite ALSO fails locally when policy drifts
// from `governance/replay-golden-vectors.json` without regeneration —
// mirroring the PR gate.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Command } from "commander"
import { registerKernelCommands, AGENT_SESSION_ID_PREFIX } from "../kernel.js"

const GOLDEN_FILE = new URL(
  "../../../governance/replay-golden-vectors.json",
  import.meta.url,
).pathname

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

// ── Fake pg client ────────────────────────────────────────────────────────

const pgFake = vi.hoisted(() => ({
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
        query: (sql: string, params?: unknown[]) => Promise<unknown>
      }
      self.connect = vi.fn(async () => undefined)
      self.end = vi.fn(async () => undefined)
      self.query = vi.fn(async (sql: string, params?: unknown[]) => {
        pgFake.capturedSql.push(sql)
        pgFake.capturedParams.push(params ?? [])
        // Only the window SELECT consumes rows; DDL + INSERTs ignore them.
        return { rows: sql.startsWith("SELECT") ? pgFake.rows : [] }
      })
      return self
    }),
  },
}))

// ── Fixtures ──────────────────────────────────────────────────────────────

interface GoldenVector {
  note?: string
  envelope: {
    version: number
    kind: string
    payload: unknown
    createdAt: string
    nonce: string
    actor: { principal: string; sessionId: string }
    taint: string
    intentHash: string
  }
  decision: { kind: string; basis?: Array<Record<string, unknown>> } & Record<
    string,
    unknown
  >
}

async function loadGoldenVectors(): Promise<GoldenVector[]> {
  const file = JSON.parse(await readFile(GOLDEN_FILE, "utf-8")) as {
    vectors: GoldenVector[]
  }
  return file.vectors
}

/** Writer-shaped intent_audit row from an (envelope, decision) pair. */
function rowFor(
  envelope: GoldenVector["envelope"],
  decision: GoldenVector["decision"],
  overrides?: { session_id?: string; recorded_at?: string },
): Record<string, unknown> {
  const refusal =
    decision.kind === "REFUSE"
      ? (decision.refusal as { kind?: string; code?: string } | undefined)
      : undefined
  return {
    intent_hash: envelope.intentHash,
    session_id: overrides?.session_id ?? envelope.actor.sessionId,
    kind: envelope.kind,
    principal: envelope.actor.principal,
    taint: envelope.taint,
    decision_kind: decision.kind,
    refusal_kind: refusal?.kind ?? null,
    refusal_code: refusal?.code ?? null,
    decision_basis: (decision.basis ?? []).map(
      (b) => `${String(b.category)}:${String(b.code)}`,
    ),
    resource_version: null,
    envelope_jsonb: JSON.stringify(envelope),
    decision_jsonb: JSON.stringify(decision),
    recorded_at: overrides?.recorded_at ?? new Date().toISOString(),
    duration_ms: 1,
    partition_month: new Date().toISOString().slice(0, 7),
    record_version: 2,
    plan_jsonb: null,
    nonce: envelope.nonce,
    supersedes_jsonb: null,
    kernel_identity_jsonb: null,
    policy_version: null,
    kernel_version: null,
    audit_hash: null,
    signature_jsonb: null,
    metadata_jsonb: null,
  }
}

function syntheticEnvelope(
  kind: string,
  sessionId = "golden:replay-baseline",
): GoldenVector["envelope"] {
  return {
    version: 2,
    kind,
    payload: { probe: true },
    createdAt: "2026-06-12T00:00:00.000Z",
    nonce: `test-${kind}`,
    actor: { principal: "user", sessionId },
    taint: "TRUSTED",
    intentHash: "a".repeat(64),
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────

let cmd: Command
let stdout: ReturnType<typeof captureStdout>
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  cmd = new Command()
  cmd.exitOverride()
  registerKernelCommands(cmd)
  stdout = captureStdout()
  pgFake.reset()
  savedEnv = {
    IBX_AUDIT_POSTGRES_ENABLED: process.env.IBX_AUDIT_POSTGRES_ENABLED,
    DATABASE_URL: process.env.DATABASE_URL,
  }
  process.env.IBX_AUDIT_POSTGRES_ENABLED = "true"
  process.env.DATABASE_URL = "postgres://mock:mock@localhost/mock"
})

afterEach(() => {
  stdout.restore()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  // Every leg of the exit-code contract sets process.exitCode; never leak it
  // into the test runner's own exit status.
  process.exitCode = 0
})

function parseJsonOut(): Record<string, unknown> {
  return JSON.parse(stdout.getOutput()) as Record<string, unknown>
}

// ── Exit-code contract (seeded drift) ─────────────────────────────────────

describe("ibx kernel replay exit codes (seeded drift, T1b-3)", () => {
  it("exit 0 — the committed golden vectors reproduce current policy (clean)", async () => {
    // Regression mirror of the PR gate: if a policy/guard change lands
    // without `--update-golden`, this test goes red locally.
    const vectors = await loadGoldenVectors()
    expect(vectors.length).toBeGreaterThan(0)
    pgFake.rows = vectors.map((v) => rowFor(v.envelope, v.decision))
    await cmd.parseAsync(["replay", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("clean")
    expect(out.exitCode).toBe(0)
    expect(out.scanned).toBe(vectors.length)
    expect((out.report as { matched: number }).matched).toBe(vectors.length)
    // A clean run never touches process.exitCode (default success).
    expect(process.exitCode ?? 0).toBe(0)
  })

  it("exit 2 — a historical decision the current policy no longer produces is drift", async () => {
    const vectors = await loadGoldenVectors()
    const v = vectors[0]!
    // Forge the historical decision to EXECUTE-with-foreign-basis: empty-state
    // adjudication can never reproduce it → DECISION_KIND drift.
    pgFake.rows = [
      rowFor(v.envelope, {
        kind: "EXECUTE",
        basis: [{ category: "policy", code: "ok" }],
      }),
    ]
    await cmd.parseAsync(["replay", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("drift")
    expect(out.exitCode).toBe(2)
    const report = out.report as { driftedByDecisionKind: number; errors: number }
    expect(report.driftedByDecisionKind).toBeGreaterThanOrEqual(1)
    expect(report.errors).toBe(0)
    expect(process.exitCode).toBe(2)
  })

  it("exit 1 — a record whose kind has no installed pack is an error, not silence", async () => {
    const env = syntheticEnvelope("unknown.kind.zzz")
    pgFake.rows = [rowFor(env, { kind: "EXECUTE", basis: [] })]
    await cmd.parseAsync(["replay", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("errors")
    expect(out.exitCode).toBe(1)
    expect((out.report as { errors: number }).errors).toBe(1)
    expect(process.exitCode).toBe(1)
  })

  it("errors take precedence over drift (a partially-errored scan never exits 2)", async () => {
    const vectors = await loadGoldenVectors()
    const v = vectors[0]!
    pgFake.rows = [
      rowFor(v.envelope, { kind: "EXECUTE", basis: [{ category: "policy", code: "ok" }] }),
      rowFor(syntheticEnvelope("unknown.kind.zzz"), { kind: "EXECUTE", basis: [] }),
    ]
    await cmd.parseAsync(["replay", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("errors")
    expect(out.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
  })
})

// ── --ci fail-closed legs ─────────────────────────────────────────────────

describe("ibx kernel replay --ci (vacuous-gate protection)", () => {
  it("hard-fails (exit 1) when IBX_AUDIT_POSTGRES_ENABLED is unset", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    await cmd.parseAsync(["replay", "--ci", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("audit-postgres-disabled")
    expect(out.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
  })

  it("without --ci the unset flag stays a soft no-op (exit 0) — operator stub", async () => {
    delete process.env.IBX_AUDIT_POSTGRES_ENABLED
    await cmd.parseAsync(["replay", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("audit-postgres-disabled")
    expect(out.exitCode).toBe(0)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it("hard-fails (exit 1) on an empty window — zero records certify nothing", async () => {
    pgFake.rows = []
    await cmd.parseAsync(["replay", "--ci", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("vacuous-empty-window")
    expect(out.exitCode).toBe(1)
    expect(out.scanned).toBe(0)
    expect(process.exitCode).toBe(1)
  })

  it("without --ci an empty window stays exit 0 (operator mode)", async () => {
    pgFake.rows = []
    await cmd.parseAsync(["replay", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("clean")
    expect(out.scanned).toBe(0)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it("documents the empty-state/vacuous-window limitation in the output", async () => {
    pgFake.rows = []
    await cmd.parseAsync(["replay", "--ci", "--json"], { from: "user" })
    const out = parseJsonOut()
    const limitations = out.limitations as string[]
    expect(limitations.some((l) => /estado VAZIO/i.test(l))).toBe(true)
    expect(limitations.some((l) => /gate vácuo/i.test(l))).toBe(true)
  })
})

// ── Agent-namespace exclusion ─────────────────────────────────────────────

describe("ibx kernel replay agent-namespace exclusion (Stage-0 forward-protection)", () => {
  it("excludes 'agent:'-prefixed session_id rows from the scan set", async () => {
    const vectors = await loadGoldenVectors()
    const v = vectors[0]!
    pgFake.rows = [
      rowFor(v.envelope, v.decision), // real row (session 'golden:…')
      rowFor(v.envelope, v.decision, { session_id: "agent:pix-remediation:run-1" }),
      rowFor(v.envelope, v.decision, { session_id: "agent:pix-remediation:run-2" }),
    ]
    await cmd.parseAsync(["replay", "--since=24h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.scanned).toBe(1)
    expect(out.excludedAgentRows).toBe(2)
    expect(out.agentSessionPrefix).toBe(AGENT_SESSION_ID_PREFIX)
    expect((out.report as { total: number }).total).toBe(1)
    expect(out.exitCode).toBe(0)
  })

  it("pushes the exclusion into SQL too (NOT LIKE 'agent:%' — LIMIT safety)", async () => {
    pgFake.rows = []
    await cmd.parseAsync(["replay", "--json"], { from: "user" })
    const sqlSeen = pgFake.capturedSql.join(" | ")
    expect(sqlSeen).toMatch(/session_id\s+NOT\s+LIKE\s+\$\d/)
    expect(pgFake.capturedParams.flat()).toContain(`${AGENT_SESSION_ID_PREFIX}%`)
  })

  it("an all-agent window in --ci mode is vacuous (exit 1), not green", async () => {
    const vectors = await loadGoldenVectors()
    const v = vectors[0]!
    pgFake.rows = [
      rowFor(v.envelope, v.decision, { session_id: "agent:shadow:run-1" }),
    ]
    await cmd.parseAsync(["replay", "--ci", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("vacuous-empty-window")
    expect(out.excludedAgentRows).toBe(1)
    expect(process.exitCode).toBe(1)
  })
})

// ── --seed-file (CI golden-vector seeding) ────────────────────────────────

describe("ibx kernel replay --seed-file", () => {
  it("seeds every committed golden vector via the canonical INSERT + ensures the partition", async () => {
    const vectors = await loadGoldenVectors()
    pgFake.rows = [] // fetch is mocked; we assert the write side
    await cmd.parseAsync(
      ["replay", "--json", `--seed-file=${GOLDEN_FILE}`],
      { from: "user" },
    )
    const inserts = pgFake.capturedSql.filter((s) =>
      s.includes("INSERT INTO intent_audit"),
    )
    expect(inserts.length).toBe(vectors.length)
    const partitionDdl = pgFake.capturedSql.filter((s) =>
      s.includes("PARTITION OF intent_audit FOR VALUES"),
    )
    expect(partitionDdl.length).toBeGreaterThanOrEqual(1)
    const out = parseJsonOut()
    expect(out.seededVectors).toBe(vectors.length)
  })

  it("a seeded-but-unreadable window still hard-fails --ci (no silent misconfig)", async () => {
    pgFake.rows = []
    await cmd.parseAsync(
      ["replay", "--ci", "--json", `--seed-file=${GOLDEN_FILE}`],
      { from: "user" },
    )
    const out = parseJsonOut()
    expect(out.status).toBe("vacuous-empty-window")
    expect(out.seededVectors).toBeGreaterThan(0)
    expect(process.exitCode).toBe(1)
  })

  it("refuses a golden vector authored in the agent namespace (would never replay)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-golden-"))
    const file = join(dir, "bad-golden.json")
    try {
      await writeFile(
        file,
        JSON.stringify({
          vectors: [
            {
              envelope: syntheticEnvelope("order.cancel", "agent:rogue"),
              decision: { kind: "EXECUTE", basis: [] },
            },
          ],
        }),
        "utf-8",
      )
      await cmd.parseAsync(["replay", "--json", `--seed-file=${file}`], {
        from: "user",
      })
      const out = parseJsonOut()
      expect(out.status).toBe("failed")
      expect(String(out.error)).toMatch(/namespace de agente/)
      expect(process.exitCode).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("refuses an empty vectors file (a seed of nothing is a vacuous gate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-golden-"))
    const file = join(dir, "empty-golden.json")
    try {
      await writeFile(file, JSON.stringify({ vectors: [] }), "utf-8")
      await cmd.parseAsync(["replay", "--json", `--seed-file=${file}`], {
        from: "user",
      })
      const out = parseJsonOut()
      expect(out.status).toBe("failed")
      expect(process.exitCode).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── --update-golden (regeneration after intended policy change) ───────────

describe("ibx kernel replay --update-golden", () => {
  it("re-materializes stale decisions from the current packs and is idempotent", async () => {
    const vectors = await loadGoldenVectors()
    const dir = await mkdtemp(join(tmpdir(), "ibx-golden-"))
    const file = join(dir, "golden.json")
    try {
      // Stale copy: real envelope, forged decision.
      await writeFile(
        file,
        JSON.stringify({
          vectors: [
            {
              note: vectors[0]!.note,
              envelope: vectors[0]!.envelope,
              decision: { kind: "EXECUTE", basis: [{ category: "stale", code: "stale" }] },
            },
          ],
        }),
        "utf-8",
      )
      await cmd.parseAsync(["replay", `--update-golden=${file}`, "--json"], {
        from: "user",
      })
      let out = parseJsonOut()
      expect(out.status).toBe("golden-updated")
      expect(out.changed).toBe(1)
      expect(process.exitCode ?? 0).toBe(0)

      const rewritten = JSON.parse(await readFile(file, "utf-8")) as {
        vectors: GoldenVector[]
      }
      // The decision now matches the committed golden (same envelope, same
      // empty-state adjudication recipe).
      expect(rewritten.vectors[0]!.decision).toEqual(vectors[0]!.decision)

      // Second run: no changes (determinism).
      stdout.restore()
      stdout = captureStdout()
      await cmd.parseAsync(["replay", `--update-golden=${file}`, "--json"], {
        from: "user",
      })
      out = parseJsonOut()
      expect(out.changed).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("exits 1 when a vector's kind has no installed pack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ibx-golden-"))
    const file = join(dir, "golden.json")
    try {
      await writeFile(
        file,
        JSON.stringify({
          vectors: [
            {
              envelope: syntheticEnvelope("unknown.kind.zzz"),
              decision: { kind: "EXECUTE", basis: [] },
            },
          ],
        }),
        "utf-8",
      )
      await cmd.parseAsync(["replay", `--update-golden=${file}`, "--json"], {
        from: "user",
      })
      const out = parseJsonOut()
      expect(out.status).toBe("errors")
      expect(out.missingPacks).toEqual(["unknown.kind.zzz"])
      expect(process.exitCode).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── --json structure ──────────────────────────────────────────────────────

describe("ibx kernel replay --json", () => {
  it("emits a single machine-readable document with window/report/exitCode", async () => {
    const vectors = await loadGoldenVectors()
    pgFake.rows = [rowFor(vectors[0]!.envelope, vectors[0]!.decision)]
    await cmd.parseAsync(["replay", "--since=2h", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.command).toBe("kernel.replay")
    expect(out.ci).toBe(false)
    expect(out.window).toMatchObject({ since: "2h" })
    expect(out.intentKind).toBeNull()
    expect(typeof out.exitCode).toBe("number")
    expect(out.report).toHaveProperty("total")
    expect(out.report).toHaveProperty("matched")
    expect(Array.isArray(out.limitations)).toBe(true)
  })

  it("invalid --since yields structured exit-1 JSON, not a stack trace", async () => {
    await cmd.parseAsync(["replay", "--since=banana", "--json"], { from: "user" })
    const out = parseJsonOut()
    expect(out.status).toBe("invalid-args")
    expect(out.exitCode).toBe(1)
    expect(process.exitCode).toBe(1)
  })
})
