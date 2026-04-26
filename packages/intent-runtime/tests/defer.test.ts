import { describe, expect, it } from "vitest"
import { adjudicate } from "@ibx/intent-kernel"
import { buildEnvelope } from "@ibx/intent-core"
import {
  orderPolicyBundle,
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFER_TIMEOUT_MS,
} from "../src/policies/order-policies.js"

// Minimal OrderContext shape — tests only exercise the fields the guards touch.
function ctx(
  overrides: Partial<{
    customerId: string | null
    isAuthenticated: boolean
    items: ReadonlyArray<{ quantity: number }>
    fulfillment: "delivery" | "pickup" | null
    paymentMethod: "pix" | "card" | "cash" | null
    paymentStatus: string | null
    channel: "whatsapp" | "web"
  }> = {},
) {
  return {
    ctx: {
      channel: overrides.channel ?? "whatsapp",
      customerId: overrides.customerId ?? "cust_1",
      isAuthenticated: overrides.isAuthenticated ?? true,
      isNewCustomer: false,
      cartId: "cart_1",
      items: overrides.items ?? [{ quantity: 1 }],
      totalInCentavos: 8900,
      fulfillment: overrides.fulfillment ?? "delivery",
      deliveryCep: "01001-000",
      paymentMethod: overrides.paymentMethod ?? "pix",
      paymentStatus: overrides.paymentStatus ?? null,
    },
  } as never
}

function confirmIntent() {
  return buildEnvelope({
    kind: "order.confirm",
    payload: { orderId: "ord_1" },
    actor: { principal: "llm", sessionId: "s-1" },
    taint: "TRUSTED",
    createdAt: "2026-04-23T12:00:00.000Z",
  })
}

describe("Phase M — DEFER producer for pending PIX", () => {
  it("returns DEFER when payment is PIX and status is pending", () => {
    const decision = adjudicate(confirmIntent(), ctx(), orderPolicyBundle)
    expect(decision.kind).toBe("DEFER")
    if (decision.kind !== "DEFER") return
    expect(decision.signal).toBe(PIX_CONFIRMATION_SIGNAL)
    expect(decision.timeoutMs).toBe(PIX_DEFER_TIMEOUT_MS)
  })

  it("does NOT DEFER when payment is already confirmed", () => {
    const decision = adjudicate(
      confirmIntent(),
      ctx({ paymentStatus: "confirmed" }),
      orderPolicyBundle,
    )
    expect(decision.kind).not.toBe("DEFER")
  })

  it("does NOT DEFER when payment method is card (non-PIX)", () => {
    const decision = adjudicate(
      confirmIntent(),
      ctx({ paymentMethod: "card" }),
      orderPolicyBundle,
    )
    expect(decision.kind).not.toBe("DEFER")
  })

  it("DEFER decision carries structured basis with reason + signal metadata", () => {
    const decision = adjudicate(confirmIntent(), ctx(), orderPolicyBundle)
    if (decision.kind !== "DEFER") throw new Error("expected DEFER")
    const stateBasis = decision.basis.find((b) => b.category === "state")
    expect(stateBasis).toBeTruthy()
    expect(stateBasis?.detail).toMatchObject({
      reason: "pix_pending",
      waitFor: PIX_CONFIRMATION_SIGNAL,
      timeoutMs: PIX_DEFER_TIMEOUT_MS,
    })
  })
})
