// T3-3 — registry integrity. This suite IS the boot-time fail-closed call
// until the T3-2 trigger-bridge worker lands: `assertAgentRosterIntegrity()`
// runs here against the real composed registry + the real registered policy
// kinds, exactly as the worker boot will invoke it.

import { describe, expect, it } from "vitest"

import {
  AGENT_REGISTRY,
  AgentDefinitionSchema,
  PIX_REMEDIATION_AGENT,
  agentSessionId,
  assertAgentRosterIntegrity,
  expectedSessionIdPrefix,
  registeredPolicyKinds,
} from "../index.js"

describe("AGENT_REGISTRY", () => {
  it("boot-time fail-closed: assertAgentRosterIntegrity() passes on the real roster", () => {
    expect(() => assertAgentRosterIntegrity()).not.toThrow()
  })

  it("every entry is schema-valid and unique", () => {
    const ids = new Set<string>()
    for (const def of AGENT_REGISTRY) {
      expect(AgentDefinitionSchema.safeParse(def).success).toBe(true)
      expect(ids.has(def.id)).toBe(false)
      ids.add(def.id)
    }
  })

  it("first entry is the PIX remediation draft at Stage 0", () => {
    expect(AGENT_REGISTRY[0]).toBe(PIX_REMEDIATION_AGENT)
    expect(PIX_REMEDIATION_AGENT.id).toBe("pix-payment-failure-remediation")
    expect(PIX_REMEDIATION_AGENT.autonomyStage).toBe(0)
  })

  it("PIX draft declares only pack-served kinds (pack-payments + platform PIX pack)", () => {
    const kinds = registeredPolicyKinds()
    for (const kind of PIX_REMEDIATION_AGENT.declaredIntentKinds) {
      expect(kinds.has(kind)).toBe(true)
    }
    expect(PIX_REMEDIATION_AGENT.declaredIntentKinds).toEqual([
      "payment.pix.regenerate",
      "pix.charge.refund",
    ])
  })

  it("sessionIdPrefix is exactly agent:<id>@<version> (D-017)", () => {
    expect(PIX_REMEDIATION_AGENT.sessionIdPrefix).toBe(
      expectedSessionIdPrefix(
        PIX_REMEDIATION_AGENT.id,
        PIX_REMEDIATION_AGENT.version,
      ),
    )
    expect(PIX_REMEDIATION_AGENT.sessionIdPrefix).toBe(
      "agent:pix-payment-failure-remediation@0.1.0",
    )
  })

  it("agentSessionId composes the D-017 shape agent:<id>@<ver>:entity:<entityId>", () => {
    expect(agentSessionId(PIX_REMEDIATION_AGENT, "pay_123")).toBe(
      "agent:pix-payment-failure-remediation@0.1.0:entity:pay_123",
    )
    expect(() => agentSessionId(PIX_REMEDIATION_AGENT, "")).toThrow()
  })

  it("registeredPolicyKinds() unions the composed packs with the platform PIX pack", () => {
    const kinds = registeredPolicyKinds()
    // Composed first-party representative…
    expect(kinds.has("order.checkout.create")).toBe(true)
    expect(kinds.has("payment.pix.regenerate")).toBe(true)
    // …plus the @adjudicate/pack-payments-pix wire kinds.
    expect(kinds.has("pix.charge.create")).toBe(true)
    expect(kinds.has("pix.charge.refund")).toBe(true)
  })
})
