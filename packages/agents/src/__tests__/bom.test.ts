// T3-3 — AI-BOM mapping: the agent roster folds into the pack-bom gate via
// the upstream pack-health/PackManifest primitives. The bomDigest must cover
// the ENTIRE definition (budgets included) and must move when the roster
// drifts, so `ibx kernel pack-bom --verify-file` is fail-closed over agents.

import { describe, expect, it } from "vitest"

import {
  PIX_REMEDIATION_AGENT,
  agentBomPackId,
  agentConformanceReport,
  agentDefinitionDigest,
  agentPackManifest,
  generateAgentAiBom,
  type AgentDefinition,
} from "../index.js"

const GENERATED_AT = "2026-06-07T00:00:00.000Z"

function bomFor(def: AgentDefinition) {
  return generateAgentAiBom(def, {
    generatedAt: GENERATED_AT,
    kernelVersion: "1.3.0",
  })
}

describe("agent AI-BOM mapping", () => {
  it("maps the definition onto the PackManifest shape", () => {
    const manifest = agentPackManifest(PIX_REMEDIATION_AGENT)
    expect(manifest.packId).toBe("agent/pix-payment-failure-remediation")
    expect(manifest.contract).toBe("v0")
    expect(manifest.intents).toEqual(PIX_REMEDIATION_AGENT.declaredIntentKinds)
    expect(manifest.signals).toEqual(PIX_REMEDIATION_AGENT.trigger.eventKinds)
  })

  it("synthetic conformance passes for the registered draft", () => {
    const report = agentConformanceReport(PIX_REMEDIATION_AGENT)
    expect(report.passed).toBe(true)
    expect(report.summary.failed).toBe(0)
    expect(report.results.map((r) => r.id)).toEqual([
      "AGT-001",
      "AGT-002",
      "AGT-003",
      "AGT-004",
    ])
  })

  it("bomDigest is deterministic (same inputs → byte-identical)", () => {
    const a = bomFor(PIX_REMEDIATION_AGENT)
    const b = bomFor(PIX_REMEDIATION_AGENT)
    expect(a.bomDigest).toBe(b.bomDigest)
    expect(a.packId).toBe(agentBomPackId(PIX_REMEDIATION_AGENT))
    expect(a.intents).toEqual(PIX_REMEDIATION_AGENT.declaredIntentKinds)
  })

  it("bomDigest covers the FULL definition — a budget change re-baselines", () => {
    const base = bomFor(PIX_REMEDIATION_AGENT)
    const bumped = bomFor({
      ...PIX_REMEDIATION_AGENT,
      budgets: {
        ...PIX_REMEDIATION_AGENT.budgets,
        maxModelCallsPerTrigger:
          PIX_REMEDIATION_AGENT.budgets.maxModelCallsPerTrigger + 1,
      },
    })
    expect(bumped.bomDigest).not.toBe(base.bomDigest)
    // The carrier is the agent-definition tool ref's schemaDigest.
    expect(base.tools[0]?.schemaDigest).toBe(
      agentDefinitionDigest(PIX_REMEDIATION_AGENT),
    )
    expect(bumped.tools[0]?.schemaDigest).not.toBe(base.tools[0]?.schemaDigest)
  })

  it("roster drift propagates: an unregistered declared kind fails conformance and moves the digest", () => {
    const drifting = {
      ...PIX_REMEDIATION_AGENT,
      declaredIntentKinds: [
        "payment.pix.regenerate",
        "payment.kind.that.no.pack.serves",
      ],
    } as unknown as AgentDefinition
    const report = agentConformanceReport(drifting)
    expect(report.passed).toBe(false)
    expect(
      report.results.find((r) => r.id === "AGT-002")?.details,
    ).toContain("payment.kind.that.no.pack.serves")

    const bom = bomFor(drifting)
    expect(bom.conformance.passed).toBe(false)
    expect(bom.bomDigest).not.toBe(bomFor(PIX_REMEDIATION_AGENT).bomDigest)
  })

  it("agentDefinitionDigest is canonical — key order does not matter", () => {
    const reordered = JSON.parse(
      JSON.stringify(PIX_REMEDIATION_AGENT, [
        // Serialize with a shuffled key allowlist, then back — same digest.
        "sessionIdPrefix",
        "owner",
        "killSwitchKey",
        "budgets",
        "trigger",
        "declaredIntentKinds",
        "displayName",
        "version",
        "id",
        "maxModelCallsPerTrigger",
        "wallClockMsPerTrigger",
        "tokensPerDay",
        "cooldownSeconds",
        "subjects",
        "eventKinds",
      ]),
    ) as AgentDefinition
    expect(agentDefinitionDigest(reordered)).toBe(
      agentDefinitionDigest(PIX_REMEDIATION_AGENT),
    )
  })
})
