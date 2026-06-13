// T3-3 — drift-gate fixtures. The required negative: a declared kind not in
// any pack FAILS, plus the prefix/uniqueness/schema legs. Fixtures are built
// as raw objects (cast) because agentRosterDrift must catch registries
// composed from non-literal sources — the zod parse alone can't be the only
// line of defense.

import { describe, expect, it } from "vitest"

import {
  PIX_REMEDIATION_AGENT,
  agentRosterDrift,
  assertAgentRosterIntegrity,
  registeredPolicyKinds,
  type AgentDefinition,
} from "../index.js"

function draft(overrides: Partial<AgentDefinition>): AgentDefinition {
  return { ...PIX_REMEDIATION_AGENT, ...overrides } as AgentDefinition
}

describe("agentRosterDrift", () => {
  it("clean roster → zero findings", () => {
    expect(agentRosterDrift()).toEqual([])
  })

  it("FIXTURE: a declared kind not served by any pack fails the gate", () => {
    const bad = draft({
      declaredIntentKinds: [
        "payment.pix.regenerate",
        "payment.kind.that.no.pack.serves",
      ] as unknown as AgentDefinition["declaredIntentKinds"],
    })
    const findings = agentRosterDrift([bad])
    expect(
      findings.some(
        (f) =>
          f.code === "kind_not_registered" &&
          f.detail.includes("payment.kind.that.no.pack.serves"),
      ),
    ).toBe(true)
    expect(() => assertAgentRosterIntegrity([bad])).toThrow(/kind_not_registered/)
  })

  it("sessionIdPrefix ↔ registry inconsistency fails (both drift codes fire)", () => {
    const bad = draft({
      sessionIdPrefix: "agent:some-other-agent@9.9.9",
    })
    const findings = agentRosterDrift([bad])
    expect(findings.some((f) => f.code === "session_prefix_mismatch")).toBe(true)
    // The schema superRefine also catches it on re-validation.
    expect(findings.some((f) => f.code === "schema_invalid")).toBe(true)
  })

  it("a prefix outside the agent: namespace fails schema re-validation", () => {
    const bad = draft({ sessionIdPrefix: "shadow:pix@0.1.0" })
    const findings = agentRosterDrift([bad])
    expect(findings.some((f) => f.code === "session_prefix_mismatch")).toBe(true)
  })

  it("duplicate ids / session prefixes / kill-switch keys fail", () => {
    const findings = agentRosterDrift([
      PIX_REMEDIATION_AGENT,
      draft({}), // identical copy → all three duplicate codes
    ])
    expect(findings.some((f) => f.code === "duplicate_agent_id")).toBe(true)
    expect(findings.some((f) => f.code === "duplicate_session_prefix")).toBe(true)
    expect(findings.some((f) => f.code === "duplicate_kill_switch_key")).toBe(true)
  })

  it("schema-invalid entry (extra field) is caught by re-validation", () => {
    const bad = {
      ...PIX_REMEDIATION_AGENT,
      surpriseField: "not-in-schema",
    } as unknown as AgentDefinition
    const findings = agentRosterDrift([bad])
    expect(findings.some((f) => f.code === "schema_invalid")).toBe(true)
  })

  it("injected kind universe is honored (gate is pure)", () => {
    const tiny = new Set(["payment.pix.regenerate"])
    const findings = agentRosterDrift([PIX_REMEDIATION_AGENT], tiny)
    // pix.charge.refund is not in the tiny universe → drift.
    expect(
      findings.some(
        (f) =>
          f.code === "kind_not_registered" &&
          f.detail.includes("pix.charge.refund"),
      ),
    ).toBe(true)
    // And the real universe stays green.
    expect(agentRosterDrift([PIX_REMEDIATION_AGENT], registeredPolicyKinds())).toEqual([])
  })
})
