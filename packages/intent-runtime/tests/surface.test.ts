/**
 * Surface test — confirms @adjudicate/intent-runtime re-exports the public API
 * apps/api depends on. If any of these imports fails, apps/api's Phase L flip
 * will break.
 */

import { describe, expect, it } from "vitest"
import {
  runOrchestrator,
  createDefaultContext,
  isCheckoutState,
  orderPolicyBundle,
  orderTaintPolicy,
} from "../src/index.js"
import { runOrchestrator as rootOrchestrator } from "../src/engine/orchestrator.js"
import { orderMachine } from "../src/adapters/xstate/index.js"

describe("@adjudicate/intent-runtime — public surface", () => {
  it("exports runOrchestrator as a function", () => {
    expect(runOrchestrator).toBeTypeOf("function")
  })

  it("root export and subpath export are the same function", () => {
    expect(runOrchestrator).toBe(rootOrchestrator)
  })

  it("exports createDefaultContext", () => {
    expect(createDefaultContext).toBeTypeOf("function")
    const ctx = createDefaultContext("whatsapp", null)
    expect(ctx.channel).toBe("whatsapp")
    expect(ctx.customerId).toBe(null)
  })

  it("exports isCheckoutState", () => {
    expect(isCheckoutState).toBeTypeOf("function")
    // Matches XState top-level string or object with "checkout" key
    expect(isCheckoutState("checkout")).toBe(true)
    expect(isCheckoutState({ checkout: "confirming" })).toBe(true)
    expect(isCheckoutState("ordering")).toBe(false)
  })

  it("exports orderMachine via adapters/xstate subpath", () => {
    expect(orderMachine).toBeTruthy()
  })

  it("exports orderPolicyBundle with all the required pieces", () => {
    expect(orderPolicyBundle.stateGuards.length).toBeGreaterThan(0)
    expect(orderPolicyBundle.authGuards.length).toBeGreaterThan(0)
    expect(orderPolicyBundle.taint.minimumFor("order.tool.propose")).toBe(
      "UNTRUSTED",
    )
    expect(orderPolicyBundle.taint.minimumFor("payment.send")).toBe("TRUSTED")
    expect(orderPolicyBundle.default).toBe("REFUSE")
  })

  it("orderTaintPolicy is the same instance as orderPolicyBundle.taint", () => {
    expect(orderTaintPolicy).toBe(orderPolicyBundle.taint)
  })
})
