// Unit tests for the resume-side kernel dispatcher (audit-2026-05-24 P1-3).
//
// What the dispatcher promises:
//   1. For each of the four kernel-covered tools (add_to_cart,
//      create_checkout, cancel_order, regenerate_pix), invokes the
//      underlying @ibatexas/tools function with the parked envelope's
//      input. Both envelope shapes — LLM-proposed (kind:
//      `order.tool.propose`) and kernel-direct (e.g. `order.checkout.create`)
//      — route to the same tool function.
//   2. Returns `{kind: "executed", toolName, result}` on success.
//   3. Returns `{kind: "failed", toolName, error}` when the tool throws.
//      Never re-throws — the adapter contract is fail-closed.
//   4. Returns `{kind: "unsupported", envelopeKind}` for envelopes not on
//      the kernel-covered surface (e.g. handoff_to_human / random
//      future kinds). The adapter caller logs and skips.

import { describe, it, expect, vi } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  dispatchResumedKernelEnvelope,
  __testOnly__resumeIdentity,
} from "../resume-kernel-dispatcher.js"
import {
  KERNEL_INTENT_KIND_ADD_ITEM,
  KERNEL_INTENT_KIND_CHECKOUT,
  KERNEL_INTENT_KIND_CANCEL,
  KERNEL_INTENT_KIND_PIX_REGENERATE,
} from "../kernel-executor-envelopes.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

function llmEnvelope(
  toolName: string,
  input: unknown = {},
  sessionId = "sess_test",
): IntentEnvelope {
  return buildEnvelope({
    kind: "order.tool.propose",
    payload: { toolName, input, toolUseId: "tu_test" },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "n_test",
  }) as IntentEnvelope
}

function kernelDirectEnvelope(
  kind: string,
  payload: unknown,
  sessionId = "sess_test",
): IntentEnvelope {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "system", sessionId },
    taint: "SYSTEM",
    nonce: "n_kernel",
  }) as IntentEnvelope
}

// ── (1) Routing identity ─────────────────────────────────────────────────────

describe("resume-kernel-dispatcher — routing identity", () => {
  it("maps `order.item.add` to add_to_cart", () => {
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_ADD_ITEM, {
      cartId: "c1",
    })
    expect(__testOnly__resumeIdentity(env)).toBe("add_to_cart")
  })

  it("maps `order.checkout.create` to create_checkout", () => {
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_CHECKOUT, {
      cartId: "c1",
    })
    expect(__testOnly__resumeIdentity(env)).toBe("create_checkout")
  })

  it("maps `order.cancel` to cancel_order", () => {
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_CANCEL, {
      orderId: "o1",
    })
    expect(__testOnly__resumeIdentity(env)).toBe("cancel_order")
  })

  it("maps `payment.pix.regenerate` to regenerate_pix", () => {
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_PIX_REGENERATE, {
      orderId: "o1",
    })
    expect(__testOnly__resumeIdentity(env)).toBe("regenerate_pix")
  })

  it("reads `order.tool.propose` payload.toolName", () => {
    const env = llmEnvelope("create_checkout", { cartId: "c1" })
    expect(__testOnly__resumeIdentity(env)).toBe("create_checkout")
  })

  it("returns null for kinds with no resume route", () => {
    const env = kernelDirectEnvelope("totally.unknown.kind", {})
    expect(__testOnly__resumeIdentity(env)).toBeNull()
  })

  it("returns null when payload has no toolName for `order.tool.propose`", () => {
    const env = buildEnvelope({
      kind: "order.tool.propose",
      payload: { somethingElse: 1 },
      actor: { principal: "llm", sessionId: "sess_test" },
      taint: "UNTRUSTED",
      nonce: "n_test",
    }) as IntentEnvelope
    expect(__testOnly__resumeIdentity(env)).toBeNull()
  })
})

// ── (2) Dispatch — happy paths ───────────────────────────────────────────────

describe("resume-kernel-dispatcher — dispatch (EXECUTE)", () => {
  it("invokes addToCart for an `order.item.add` kernel-direct envelope", async () => {
    const addToCart = vi.fn(async () => ({
      success: true,
      cart: { items: [], total: 0 },
    }))
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_ADD_ITEM, {
      cartId: "cart_42",
      variantId: "var_99",
      quantity: 2,
    })

    const result = await dispatchResumedKernelEnvelope(
      env,
      "sess_a",
      { addToCart: addToCart as never },
    )

    expect(result.kind).toBe("executed")
    if (result.kind === "executed") {
      expect(result.toolName).toBe("add_to_cart")
    }
    expect(addToCart).toHaveBeenCalledOnce()
    const [input, ctx] = (addToCart as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(input).toEqual({
      cartId: "cart_42",
      variantId: "var_99",
      quantity: 2,
    })
    expect(ctx).toMatchObject({
      sessionId: "sess_a",
      channel: "whatsapp",
      userType: "customer",
    })
  })

  it("invokes createCheckout for an LLM-proposed `create_checkout` envelope", async () => {
    const createCheckout = vi.fn(async () => ({
      success: true,
      paymentMethod: "pix",
      orderId: "ord_1",
      message: "ok",
    }))
    const env = llmEnvelope("create_checkout", {
      cartId: "cart_1",
      paymentMethod: "pix",
    })

    const result = await dispatchResumedKernelEnvelope(
      env,
      "sess_b",
      { createCheckout: createCheckout as never },
    )

    expect(result.kind).toBe("executed")
    if (result.kind === "executed") {
      expect(result.toolName).toBe("create_checkout")
      expect((result.result as { orderId: string }).orderId).toBe("ord_1")
    }
    expect(createCheckout).toHaveBeenCalledOnce()
    const [input] = (createCheckout as ReturnType<typeof vi.fn>).mock.calls[0]!
    // LLM-proposed path: input comes from payload.input.
    expect(input).toEqual({ cartId: "cart_1", paymentMethod: "pix" })
  })

  it("invokes cancelOrder for an `order.cancel` kernel-direct envelope", async () => {
    const cancelOrder = vi.fn(async () => ({
      success: true,
      message: "Pedido cancelado.",
    }))
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_CANCEL, {
      orderId: "ord_42",
    })

    const result = await dispatchResumedKernelEnvelope(
      env,
      "sess_c",
      { cancelOrder: cancelOrder as never },
    )

    expect(result.kind).toBe("executed")
    expect(cancelOrder).toHaveBeenCalledOnce()
    const [input] = (cancelOrder as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(input).toEqual({ orderId: "ord_42" })
  })

  it("invokes regeneratePix for a `payment.pix.regenerate` kernel-direct envelope", async () => {
    const regeneratePix = vi.fn(async () => ({
      success: true,
      message: "PIX regenerado.",
      pixCopyPaste: "00020126…",
    }))
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_PIX_REGENERATE, {
      orderId: "ord_42",
    })

    const result = await dispatchResumedKernelEnvelope(
      env,
      "sess_d",
      { regeneratePix: regeneratePix as never },
    )

    expect(result.kind).toBe("executed")
    expect(regeneratePix).toHaveBeenCalledOnce()
  })
})

// ── (3) Dispatch — REFUSE / unsupported routing ──────────────────────────────

describe("resume-kernel-dispatcher — REFUSE (unsupported envelopes)", () => {
  it("returns `unsupported` for an envelope kind with no resume route", async () => {
    const addToCart = vi.fn()
    const env = kernelDirectEnvelope("future.unknown.kind", {})

    const result = await dispatchResumedKernelEnvelope(env, "sess_e", {
      addToCart: addToCart as never,
    })

    expect(result.kind).toBe("unsupported")
    if (result.kind === "unsupported") {
      expect(result.envelopeKind).toBe("future.unknown.kind")
    }
    expect(addToCart).not.toHaveBeenCalled()
  })

  it("returns `unsupported` for an LLM-proposed envelope with no toolName", async () => {
    const env = buildEnvelope({
      kind: "order.tool.propose",
      payload: { input: {} },
      actor: { principal: "llm", sessionId: "sess_e" },
      taint: "UNTRUSTED",
      nonce: "n_e",
    }) as IntentEnvelope

    const result = await dispatchResumedKernelEnvelope(env, "sess_e")
    expect(result.kind).toBe("unsupported")
  })
})

// ── (4) Dispatch — failure swallowing ────────────────────────────────────────

describe("resume-kernel-dispatcher — failed (tool threw)", () => {
  it("returns `failed` with the error when addToCart throws (no re-throw)", async () => {
    const addToCart = vi.fn(async () => {
      throw new Error("medusa unavailable")
    })
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_ADD_ITEM, {
      cartId: "c",
    })

    const result = await dispatchResumedKernelEnvelope(env, "sess_f", {
      addToCart: addToCart as never,
    })

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.toolName).toBe("add_to_cart")
      expect(result.error.message).toBe("medusa unavailable")
    }
  })

  it("wraps non-Error throws into Error before returning failed", async () => {
    const createCheckout = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "string-throw"
    })
    const env = kernelDirectEnvelope(KERNEL_INTENT_KIND_CHECKOUT, {
      cartId: "c",
    })

    const result = await dispatchResumedKernelEnvelope(env, "sess_g", {
      createCheckout: createCheckout as never,
    })

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.error).toBeInstanceOf(Error)
      expect(result.error.message).toBe("string-throw")
    }
  })
})
