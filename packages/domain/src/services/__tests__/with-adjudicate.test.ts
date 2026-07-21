// with-adjudicate.test.ts — unit tests for the service-method kernel chokepoint.
//
// Target: packages/domain/src/services/__shared__/with-adjudicate.ts
//
// The helper wraps every mutating service method around the pure kernel:
//   1. adjudicate(envelope, state, policy) → 6-valued Decision
//   2. best-effort audit emission (fire-and-forget; failure logged, not fatal)
//   3. branch:
//        EXECUTE → executor(envelope.payload)
//        REWRITE → executor(decision.rewritten.payload)
//        REFUSE / DEFER / REQUEST_CONFIRMATION / ESCALATE → no executor
//
// Strategy: the kernel's `adjudicate` is MOCKED so we control the exact
// Decision returned per branch (the approach the file's docblock invites:
// "Cover EXECUTE/REWRITE/REFUSE/etc decision branches with a mocked kernel").
// The audit/decision builders from @adjudicate/core stay REAL so the audit
// record assertions exercise the genuine build path.

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  buildEnvelope,
  decisionExecute,
  decisionRewrite,
  decisionRefuse,
  decisionDefer,
  decisionRequestConfirmation,
  decisionEscalate,
  refuse,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core"

// ── Mock the pure kernel so we drive each Decision branch directly ─────────

const mockAdjudicate = vi.hoisted(() => vi.fn())

vi.mock("@adjudicate/core/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@adjudicate/core/kernel")>()
  return { ...actual, adjudicate: mockAdjudicate }
})

// ── Import target after the mock is registered ─────────────────────────────

import {
  withAdjudicate,
  expectExecute,
  CommandRefusedError,
  type AdjudicatedResult,
} from "../__shared__/with-adjudicate.js"
import { STRUCTURAL_REJECTION_CODE } from "../__shared__/envelope-structural-gate.js"

// ── Fixtures ───────────────────────────────────────────────────────────────

interface TestPayload {
  readonly value: number
}

function makeEnvelope(value = 1) {
  return buildEnvelope({
    kind: "test.kind" as const,
    payload: { value } satisfies TestPayload,
    nonce: "nonce-fixed",
    actor: { principal: "user", sessionId: "user:test" },
    taint: "UNTRUSTED",
  })
}

// Policy is unused at runtime because `adjudicate` is mocked — pass a stand-in.
const dummyPolicy = {} as never
const dummyState = {}

function makeSink(): AuditSink & { emit: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn().mockResolvedValue(undefined) } as never
}

function makeLog() {
  return { warn: vi.fn(), error: vi.fn() }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("withAdjudicate — kernel chokepoint", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("EXECUTE branch", () => {
    it("runs the executor with envelope.payload and returns { decision, result }", async () => {
      mockAdjudicate.mockReturnValue(decisionExecute([]))
      const envelope = makeEnvelope(7)
      const executor = vi.fn().mockResolvedValue({ ok: "applied" })

      const out = await withAdjudicate(
        envelope,
        dummyState,
        dummyPolicy,
        executor,
      )

      expect(out.decision.kind).toBe("EXECUTE")
      expect(out.result).toEqual({ ok: "applied" })
      // The ORIGINAL payload is what runs on EXECUTE (not a rewrite).
      expect(executor).toHaveBeenCalledTimes(1)
      expect(executor).toHaveBeenCalledWith({ value: 7 })
    })

    it("emits exactly one audit record carrying the real envelope hash + decision", async () => {
      mockAdjudicate.mockReturnValue(decisionExecute([]))
      const envelope = makeEnvelope(3)
      const sink = makeSink()

      await withAdjudicate(
        envelope,
        dummyState,
        dummyPolicy,
        vi.fn().mockResolvedValue("r"),
        { auditSink: sink },
      )

      expect(sink.emit).toHaveBeenCalledTimes(1)
      const record = sink.emit.mock.calls[0]![0]
      expect(record.intentHash).toBe(envelope.intentHash)
      expect(record.decision.kind).toBe("EXECUTE")
      expect(typeof record.durationMs).toBe("number")
      expect(record.durationMs).toBeGreaterThanOrEqual(0)
    })

    it("threads policyVersion + kernelIdentity into the audit record when supplied", async () => {
      mockAdjudicate.mockReturnValue(decisionExecute([]))
      const sink = makeSink()

      await withAdjudicate(
        makeEnvelope(),
        dummyState,
        dummyPolicy,
        vi.fn().mockResolvedValue("r"),
        {
          auditSink: sink,
          policyVersion: "pack-test@1.2.3",
          kernelIdentity: { id: "kernel-x", version: "9.9.9" },
        },
      )

      const record = sink.emit.mock.calls[0]![0]
      expect(record.policyVersion).toBe("pack-test@1.2.3")
      expect(record.kernelIdentity).toEqual({ id: "kernel-x", version: "9.9.9" })
    })

    it("does not swallow executor errors — domain throws propagate", async () => {
      mockAdjudicate.mockReturnValue(decisionExecute([]))
      const boom = new Error("ConcurrencyError")
      const executor = vi.fn().mockRejectedValue(boom)

      await expect(
        withAdjudicate(makeEnvelope(), dummyState, dummyPolicy, executor),
      ).rejects.toThrow("ConcurrencyError")
    })
  })

  describe("REWRITE branch", () => {
    it("runs the executor with the REWRITTEN payload, not the original", async () => {
      const original = makeEnvelope(1)
      const rewritten = makeEnvelope(42) // sanitized/normalized substitute
      mockAdjudicate.mockReturnValue(
        decisionRewrite(rewritten, "normalized", []),
      )
      const executor = vi.fn().mockResolvedValue({ ok: "rewritten" })

      const out = await withAdjudicate(
        original,
        dummyState,
        dummyPolicy,
        executor,
      )

      expect(out.decision.kind).toBe("REWRITE")
      expect(out.result).toEqual({ ok: "rewritten" })
      // Load-bearing: the rewritten payload (value: 42) runs, NOT value: 1.
      expect(executor).toHaveBeenCalledTimes(1)
      expect(executor).toHaveBeenCalledWith({ value: 42 })
    })
  })

  describe("non-EXECUTE branches do NOT run the executor", () => {
    const cases: { name: string; decision: Decision }[] = [
      {
        name: "REFUSE",
        decision: decisionRefuse(
          refuse("BUSINESS_RULE", "test.blocked", "Operação não permitida."),
          [],
        ),
      },
      {
        name: "DEFER",
        decision: decisionDefer("payment.webhook", 30_000, []),
      },
      {
        name: "REQUEST_CONFIRMATION",
        decision: decisionRequestConfirmation("Confirmar?", []),
      },
      {
        name: "ESCALATE",
        decision: decisionEscalate("human", "needs review", []),
      },
    ]

    for (const { name, decision } of cases) {
      it(`${name}: returns the decision, leaves result undefined, executor not called`, async () => {
        mockAdjudicate.mockReturnValue(decision)
        const executor = vi.fn().mockResolvedValue("should-not-run")
        const sink = makeSink()

        const out = await withAdjudicate(
          makeEnvelope(),
          dummyState,
          dummyPolicy,
          executor,
          { auditSink: sink },
        )

        expect(out.decision.kind).toBe(name)
        expect(out.result).toBeUndefined()
        expect(executor).not.toHaveBeenCalled()
        // Audit still fires on a refused decision (governance trail).
        expect(sink.emit).toHaveBeenCalledTimes(1)
      })
    }
  })

  describe("audit emission is best-effort", () => {
    it("no auditSink configured: nothing emitted, mutation still runs", async () => {
      mockAdjudicate.mockReturnValue(decisionExecute([]))
      const executor = vi.fn().mockResolvedValue("r")

      const out = await withAdjudicate(
        makeEnvelope(),
        dummyState,
        dummyPolicy,
        executor,
      )

      expect(out.decision.kind).toBe("EXECUTE")
      expect(out.result).toBe("r")
      expect(executor).toHaveBeenCalledTimes(1)
    })

    it("a rejecting sink does not fail the mutation; the error is logged", async () => {
      mockAdjudicate.mockReturnValue(decisionExecute([]))
      const log = makeLog()
      const sink = {
        emit: vi.fn().mockRejectedValue(new Error("sink down")),
      } as never

      const out = await withAdjudicate(
        makeEnvelope(),
        dummyState,
        dummyPolicy,
        vi.fn().mockResolvedValue("r"),
        { auditSink: sink, log },
      )

      expect(out.decision.kind).toBe("EXECUTE")
      // Flush the fire-and-forget .catch() so the error log runs.
      await new Promise((r) => setImmediate(r))
      expect(log.error).toHaveBeenCalledTimes(1)
      expect(String(log.error.mock.calls[0]![0])).toContain("audit emit failed")
    })

    it("an un-canonicalizable decision makes record-build fail; logged, still branches", async () => {
      // A non-finite timeoutMs cannot be canonical-JSON-encoded, so the real
      // buildAuditRecord throws — exercising the build-failure catch. The
      // mutation branch (DEFER here) must still proceed.
      const badDecision: Decision = {
        kind: "DEFER",
        signal: "payment.webhook",
        timeoutMs: Infinity,
        basis: [],
      }
      mockAdjudicate.mockReturnValue(badDecision)
      const log = makeLog()
      const executor = vi.fn().mockResolvedValue("x")
      const sink = makeSink()

      const out = await withAdjudicate(
        makeEnvelope(),
        dummyState,
        dummyPolicy,
        executor,
        { auditSink: sink, log },
      )

      expect(log.error).toHaveBeenCalledTimes(1)
      expect(String(log.error.mock.calls[0]![0])).toContain(
        "audit record build failed",
      )
      // Build failed, so emit never ran, but the decision still flows through.
      expect(sink.emit).not.toHaveBeenCalled()
      expect(out.decision.kind).toBe("DEFER")
      expect(executor).not.toHaveBeenCalled()
    })
  })
})

// ── FE-T04: structural boundary gate ────────────────────────────────────────
//
// The command-service chokepoint's twin of the customer-plane gateway's gate
// (apps/api/src/routes/__shared__/customer-intent-gateway.ts) — same
// `isStructurallyMalformed` predicate, same `STRUCTURAL_REJECTION_CODE`,
// reused via `@ibatexas/domain`'s public export. Runs BEFORE `adjudicate()`,
// so these tests assert the mocked kernel is never even called for a
// malformed value.

describe("withAdjudicate — structural boundary gate (FE-T04)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("REFUSEs a value that is not envelope-shaped at all, before adjudicate() runs", async () => {
    const executor = vi.fn().mockResolvedValue("should-not-run")
    const sink = makeSink()

    const out = await withAdjudicate(
      { totally: "not an envelope" } as unknown as IntentEnvelope<string, unknown>,
      dummyState,
      dummyPolicy,
      executor,
      { auditSink: sink },
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(out.decision.kind === "REFUSE" && out.decision.refusal.code).toBe(
      STRUCTURAL_REJECTION_CODE,
    )
    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
    expect(out.result).toBeUndefined()
  })

  it("REFUSEs a well-formed envelope missing a required field (nonce)", async () => {
    const wellFormed = makeEnvelope(1)
    const { nonce: _dropped, ...missingNonce } =
      wellFormed as unknown as Record<string, unknown>
    const executor = vi.fn()

    const out = await withAdjudicate(
      missingNonce as unknown as IntentEnvelope<string, unknown>,
      dummyState,
      dummyPolicy,
      executor,
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })

  it("REFUSEs an envelope carrying an extra, undeclared key", async () => {
    const withExtraKey = { ...makeEnvelope(1), notPartOfTheSchema: "sneaky" }
    const executor = vi.fn()

    const out = await withAdjudicate(
      withExtraKey as unknown as IntentEnvelope<string, unknown>,
      dummyState,
      dummyPolicy,
      executor,
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(mockAdjudicate).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })

  it("records a tamper-evident SYSTEM-actor audit record for the structural rejection", async () => {
    const sink = makeSink()

    await withAdjudicate(
      { nope: true } as unknown as IntentEnvelope<string, unknown>,
      dummyState,
      dummyPolicy,
      vi.fn(),
      { auditSink: sink },
    )

    expect(sink.emit).toHaveBeenCalledTimes(1)
    const record = sink.emit.mock.calls[0]![0]
    const blob = JSON.stringify(record)
    expect(blob).toContain(STRUCTURAL_REJECTION_CODE)
    expect(blob).toContain("system")
    expect(blob).toContain("structural_rejected")
  })

  it("a rejecting sink does not throw — logged, decision still returned", async () => {
    const log = makeLog()
    const sink = { emit: vi.fn().mockRejectedValue(new Error("sink down")) } as never

    const out = await withAdjudicate(
      { nope: true } as unknown as IntentEnvelope<string, unknown>,
      dummyState,
      dummyPolicy,
      vi.fn(),
      { auditSink: sink, log },
    )

    expect(out.decision.kind).toBe("REFUSE")
    await new Promise((r) => setImmediate(r))
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(String(log.error.mock.calls[0]![0])).toContain(
      "structural-rejection audit emit failed",
    )
  })

  it("does NOT affect a well-formed envelope — falls through to adjudicate() unchanged (byte-identical positive control)", async () => {
    mockAdjudicate.mockReturnValue(decisionExecute([]))
    const executor = vi.fn().mockResolvedValue("ok")

    const out = await withAdjudicate(makeEnvelope(5), dummyState, dummyPolicy, executor)

    expect(mockAdjudicate).toHaveBeenCalledTimes(1)
    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toBe("ok")
    expect(executor).toHaveBeenCalledWith({ value: 5 })
  })
})

describe("CommandRefusedError — pt-BR message resolution", () => {
  it("REFUSE → uses refusal.userFacing", () => {
    const decision = decisionRefuse(
      refuse("STATE", "order.shipped", "Esse pedido já foi enviado."),
      [],
    )
    const err = new CommandRefusedError(decision)
    expect(err.name).toBe("CommandRefusedError")
    expect(err.message).toBe("Esse pedido já foi enviado.")
    expect(err.decision).toBe(decision)
    expect(err).toBeInstanceOf(Error)
  })

  it("ESCALATE → uses reason", () => {
    const err = new CommandRefusedError(
      decisionEscalate("supervisor", "valor acima do limite", []),
    )
    expect(err.message).toBe("valor acima do limite")
  })

  it("REQUEST_CONFIRMATION → uses prompt", () => {
    const err = new CommandRefusedError(
      decisionRequestConfirmation("Confirmar reembolso?", []),
    )
    expect(err.message).toBe("Confirmar reembolso?")
  })

  it("DEFER → builds the pt-BR awaiting-signal message from the signal", () => {
    const err = new CommandRefusedError(
      decisionDefer("payment.webhook", 1000, []),
    )
    expect(err.message).toBe("Operação aguardando sinal: payment.webhook")
  })

  it("default (e.g. EXECUTE passed in) → generic pt-BR refusal copy", () => {
    const err = new CommandRefusedError(decisionExecute([]))
    expect(err.message).toBe("Operação não permitida.")
  })
})

describe("expectExecute", () => {
  it("returns the result on EXECUTE", () => {
    const outcome: AdjudicatedResult<string> = {
      decision: decisionExecute([]),
      result: "applied",
    }
    expect(expectExecute(outcome)).toBe("applied")
  })

  it("returns the result on REWRITE", () => {
    const outcome: AdjudicatedResult<number> = {
      decision: decisionRewrite(makeEnvelope(), "normalized", []),
      result: 99,
    }
    expect(expectExecute(outcome)).toBe(99)
  })

  it("throws CommandRefusedError carrying the decision on a REFUSE outcome", () => {
    const decision = decisionRefuse(
      refuse("AUTH", "auth.required", "Faça login para continuar."),
      [],
    )
    const outcome: AdjudicatedResult<string> = { decision }

    try {
      expectExecute(outcome)
      expect.unreachable("expectExecute should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(CommandRefusedError)
      expect((err as CommandRefusedError).message).toBe(
        "Faça login para continuar.",
      )
      expect((err as CommandRefusedError).decision).toBe(decision)
    }
  })

  it("throws the unreachable-guard error when EXECUTE carries no result", () => {
    const outcome: AdjudicatedResult<string> = {
      decision: decisionExecute([]),
      result: undefined,
    }
    expect(() => expectExecute(outcome)).toThrow(
      "EXECUTE/REWRITE branch returned undefined result",
    )
  })
})
