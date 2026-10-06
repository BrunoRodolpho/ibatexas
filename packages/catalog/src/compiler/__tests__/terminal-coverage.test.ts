// LE2-016 — pass 4: terminal coverage.
//
// The two rules that matter most here are the PACK-WIDE ones: they are
// coverage statements over a whole capability set, which no per-object check
// and no stricter type could ever see.

import { describe, expect, it } from "vitest"

import { CAPABILITY_DEFINITIONS } from "../../capability-definitions/definitions.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import { runTerminalCoveragePass } from "../passes/terminal-coverage.js"

const CHAIN = [
  { phase: "state", name: "requireCartIdForCartOps" },
  { phase: "business", name: "executeCartOps" },
] as const

function chat(overrides: Record<string, unknown> = {}): CapabilityDefinition {
  return {
    kind: "order.cart.ensure",
    pack: "ibatexas/pack-orders",
    mutating: true,
    tier: "chat",
    surfaces: ["chat"],
    auth: "guest",
    legacyNames: ["get_or_create_cart"],
    description: "Garantir um carrinho ativo.",
    guardRefs: CHAIN,
    refusalCode: "order.default.deny",
    ...overrides,
  } as unknown as CapabilityDefinition
}

describe("terminal-coverage — the chain/floor coupling", () => {
  it("FAILS on a guard chain with no refusal floor", () => {
    const { refusalCode: _dropped, ...withoutFloor } = chat() as unknown as Record<
      string,
      unknown
    >
    const [d] = runTerminalCoveragePass([
      withoutFloor as unknown as CapabilityDefinition,
    ]).diagnostics
    expect(d).toMatchObject({
      pass: "terminal-coverage",
      rule: "missing-refusal-terminal",
      severity: "error",
      object: "capability:order.cart.ensure",
      field: "refusalCode",
    })
    expect(d?.message).toContain("EXECUTE / CONFIRM / ESCALATE / DEFER")
  })

  it("FAILS on a refusal floor with no chain — REFUSE as the ONLY terminal", () => {
    const [d] = runTerminalCoveragePass([chat({ guardRefs: [] })]).diagnostics
    expect(d).toMatchObject({
      rule: "refusal-terminal-without-chain",
      field: "guardRefs",
    })
    expect(d?.message).toContain("dead capability")
  })

  it('FAILS on a `phase: "taint"` guard ref — a terminal source that cannot exist', () => {
    // `GuardPhase` admits "taint" for GuardFireStats symmetry, so the type
    // system accepts this; a Pack's taint slot is a single TaintPolicy value,
    // not a Guard[] array, so nothing can resolve it.
    const [d] = runTerminalCoveragePass([
      chat({ guardRefs: [...CHAIN, { phase: "taint", name: "redactPii" }] }),
    ]).diagnostics
    expect(d).toMatchObject({
      rule: "unreachable-guard-phase",
      field: "guardRefs[2].phase",
      reference: "taint",
    })
    expect(d?.message).toContain("TaintPolicy")
  })

  it("does not treat an identity-tier capability's absent terminals as a hole", () => {
    const identity = {
      kind: "order.reorder",
      pack: "ibatexas/pack-orders",
      mutating: true,
      tier: "identity",
    } as CapabilityDefinition
    expect(runTerminalCoveragePass([identity]).diagnostics).toEqual([])
  })
})

describe("terminal-coverage — pack-wide coverage (what no per-object check can see)", () => {
  it("FAILS when one Pack's capabilities declare different refusal floors", () => {
    const result = runTerminalCoveragePass([
      chat(),
      chat({ kind: "order.cancel", refusalCode: "payment.default.deny" }),
    ])
    const [d] = result.diagnostics.filter(
      (x) => x.rule === "divergent-pack-refusal-terminal",
    )
    expect(d).toMatchObject({
      object: "pack:ibatexas/pack-orders",
      field: "refusalCode",
    })
    // Both codes and their claimant kinds are named — sorted, so the message
    // is byte-stable across runs.
    expect(d?.message).toContain('"order.default.deny" (order.cart.ensure)')
    expect(d?.message).toContain('"payment.default.deny" (order.cancel)')
    expect(d?.message).toContain("exactly one PolicyBundle.default")
  })

  it("FAILS when one Pack's capabilities declare different guard chains", () => {
    const [d] = runTerminalCoveragePass([
      chat(),
      chat({ kind: "order.cancel", guardRefs: [CHAIN[0]] }),
    ]).diagnostics.filter((x) => x.rule === "divergent-pack-guard-chain")
    expect(d).toMatchObject({ object: "pack:ibatexas/pack-orders", field: "guardRefs" })
    expect(d?.message).toContain("pack-wide by construction")
  })

  it("does NOT fire across DIFFERENT packs — each Pack has its own floor", () => {
    expect(
      runTerminalCoveragePass([
        chat(),
        chat({
          kind: "payment.method.set",
          pack: "ibatexas/pack-payments",
          refusalCode: "payment.default.deny",
          guardRefs: [{ phase: "business", name: "executeAll" }],
        }),
      ]).diagnostics,
    ).toEqual([])
  })
})

describe("terminal-coverage — the real catalog is the control", () => {
  it("passes clean: every Pack has one floor and one chain", () => {
    expect(runTerminalCoveragePass(CAPABILITY_DEFINITIONS).diagnostics).toEqual([])
  })

  it("examined every declared terminal (a vacuous gate is not a gate)", () => {
    expect(runTerminalCoveragePass(CAPABILITY_DEFINITIONS).checked).toBeGreaterThan(
      CAPABILITY_DEFINITIONS.length * 2,
    )
  })
})
