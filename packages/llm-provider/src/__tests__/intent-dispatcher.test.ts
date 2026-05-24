// Unit tests for intent-dispatcher.ts (Task 02 — wire onToolIntent).
//
// Acceptance points exercised here (per docs/adjudicate-migration/tasks/02-wire-on-tool-intent.md):
//   - DETERMINISTIC_KERNEL_COVERAGE skips with reason "deterministic_kernel_covers"
//   - support.handoff (handoff_to_human) dispatches and the handler is called
//   - dispatch failures surface as { kind: "failed", error }
//   - ctx is passed through to the handler

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Channel, type AgentContext } from "@ibatexas/types"
import { buildEnvelope } from "@adjudicate/core"
import type { ToolIntent } from "../machine/types.js"
import {
  createIntentDispatcher,
  DETERMINISTIC_KERNEL_COVERAGE,
  type DispatchHandler,
  type DispatchResult,
} from "../intent-dispatcher.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

const ctx: AgentContext = {
  channel: Channel.WhatsApp,
  sessionId: "sess_01",
  customerId: "cust_01",
  userType: "customer",
}

function buildIntent(
  toolName: string,
  input: unknown = {},
  envelopeKind: string = "order.tool.propose",
): ToolIntent {
  const envelope = buildEnvelope({
    kind: envelopeKind,
    payload: { toolName, input, toolUseId: "tu_01" },
    actor: { principal: "llm", sessionId: ctx.sessionId },
    taint: "UNTRUSTED",
    nonce: `n_${Math.random().toString(36).slice(2)}`,
  })
  return {
    toolName,
    input,
    toolUseId: "tu_01",
    envelope: envelope as ToolIntent["envelope"],
  }
}

// Silent logger for predictable test output.
const silentLog = {
  warn: vi.fn(),
  error: vi.fn(),
}

beforeEach(() => {
  silentLog.warn.mockClear()
  silentLog.error.mockClear()
})

// ── DETERMINISTIC_KERNEL_COVERAGE ────────────────────────────────────────────

describe("DETERMINISTIC_KERNEL_COVERAGE", () => {
  it("includes the 7 tool names the kernel-executor handles directly", () => {
    // These match the deterministic mutation calls in kernel-executor.ts
    // (addItemToCart / processCheckout / cancelOrderAction / regeneratePixAction).
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("add_to_cart")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("update_cart")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("remove_from_cart")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("get_or_create_cart")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("create_checkout")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("cancel_order")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("regenerate_pix")).toBe(true)
  })

  it("also includes the canonical intent kinds (W5-3 — drift-corrected names)", () => {
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("order.item.add")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("order.item.update")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("order.item.remove")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("order.cart.ensure")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("order.checkout.create")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("order.cancel")).toBe(true)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("payment.pix.regenerate")).toBe(true)
  })

  it("does NOT include LLM-only mutating tools", () => {
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("handoff_to_human")).toBe(false)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("schedule_follow_up")).toBe(false)
    expect(DETERMINISTIC_KERNEL_COVERAGE.has("set_pix_details")).toBe(false)
  })
})

// ── Skip path ────────────────────────────────────────────────────────────────

describe("createIntentDispatcher — skip path", () => {
  it("skips intents the deterministic kernel covers (add_to_cart)", async () => {
    const handler = vi.fn<DispatchHandler>(async () => ({ touched: true }))
    const dispatch = createIntentDispatcher({
      handlers: new Map([["add_to_cart", handler]]),
      log: silentLog,
    })

    const result = await dispatch(buildIntent("add_to_cart"), ctx)

    expect(result).toEqual({
      kind: "skipped",
      reason: "deterministic_kernel_covers",
    })
    // CRITICAL: the handler must NOT be invoked — kernel already mutated.
    expect(handler).not.toHaveBeenCalled()
  })

  it("skips when intent.envelope.kind is a domain-specific kernel-covered kind", async () => {
    // Future shape (task 06 will introduce these). Dispatcher checks
    // envelope.kind first, then falls back to toolName.
    const handler = vi.fn<DispatchHandler>(async () => ({ touched: true }))
    const dispatch = createIntentDispatcher({
      handlers: new Map([["add_to_cart", handler]]),
      log: silentLog,
    })

    const intent = buildIntent("add_to_cart", {}, "order.item.add")
    const result = await dispatch(intent, ctx)

    expect(result.kind).toBe("skipped")
    expect(handler).not.toHaveBeenCalled()
  })

  it("skips other deterministic kernel-covered tools (create_checkout, cancel_order, regenerate_pix)", async () => {
    const handler = vi.fn<DispatchHandler>(async () => ({}))
    const dispatch = createIntentDispatcher({
      handlers: new Map([
        ["create_checkout", handler],
        ["cancel_order", handler],
        ["regenerate_pix", handler],
      ]),
      log: silentLog,
    })

    for (const name of ["create_checkout", "cancel_order", "regenerate_pix"]) {
      const result = await dispatch(buildIntent(name), ctx)
      expect(result.kind).toBe("skipped")
    }
    expect(handler).not.toHaveBeenCalled()
  })
})

// ── Execute path ─────────────────────────────────────────────────────────────

describe("createIntentDispatcher — execute path", () => {
  it("dispatches support.handoff and the handler is called with payload + ctx", async () => {
    const handler = vi.fn<DispatchHandler>(async () => ({
      success: true,
      estimatedWaitMinutes: 5,
      message: "Atendente notificado.",
    }))
    const dispatch = createIntentDispatcher({
      handlers: new Map([["handoff_to_human", handler]]),
      log: silentLog,
    })

    const input = { sessionId: "sess_01", reason: "complex_question" }
    const result = await dispatch(buildIntent("handoff_to_human", input), ctx)

    expect(result.kind).toBe("executed")
    expect((result as { kind: "executed"; result: unknown }).result).toEqual({
      success: true,
      estimatedWaitMinutes: 5,
      message: "Atendente notificado.",
    })
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(input, ctx)
  })

  it("dispatches schedule_follow_up", async () => {
    const handler = vi.fn<DispatchHandler>(async () => ({
      success: true,
      message: "Lembrete agendado.",
    }))
    const dispatch = createIntentDispatcher({
      handlers: new Map([["schedule_follow_up", handler]]),
      log: silentLog,
    })

    const input = { delayHours: 24, reason: "cart_save" }
    const result = await dispatch(buildIntent("schedule_follow_up", input), ctx)

    expect(result.kind).toBe("executed")
    expect(handler).toHaveBeenCalledWith(input, ctx)
  })

  it("passes ctx through unchanged to the handler", async () => {
    let observedCtx: AgentContext | null = null
    const handler: DispatchHandler = async (_input, c) => {
      observedCtx = c
      return null
    }
    const dispatch = createIntentDispatcher({
      handlers: new Map([["handoff_to_human", handler]]),
      log: silentLog,
    })

    await dispatch(buildIntent("handoff_to_human"), ctx)

    expect(observedCtx).toBe(ctx)
  })
})

// ── Failure path ─────────────────────────────────────────────────────────────

describe("createIntentDispatcher — failure path", () => {
  it("wraps handler errors as { kind: 'failed', error }", async () => {
    const boom = new Error("NATS publish failed")
    const handler: DispatchHandler = async () => {
      throw boom
    }
    const dispatch = createIntentDispatcher({
      handlers: new Map([["handoff_to_human", handler]]),
      log: silentLog,
    })

    const result = await dispatch(buildIntent("handoff_to_human"), ctx)

    expect(result.kind).toBe("failed")
    expect((result as { kind: "failed"; error: Error }).error).toBe(boom)
  })

  it("normalizes non-Error throws to Error instances", async () => {
    const handler: DispatchHandler = async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string failure"
    }
    const dispatch = createIntentDispatcher({
      handlers: new Map([["handoff_to_human", handler]]),
      log: silentLog,
    })

    const result = await dispatch(buildIntent("handoff_to_human"), ctx)

    expect(result.kind).toBe("failed")
    const failed = result as { kind: "failed"; error: Error }
    expect(failed.error).toBeInstanceOf(Error)
    expect(failed.error.message).toBe("string failure")
  })

  it("returns failed (not silent success) when no handler is registered for an LLM-only tool", async () => {
    // Bypass-detection: if the dispatcher is wired but the handler binding is
    // missing, the responder must NOT claim "intent_registered" success.
    const dispatch = createIntentDispatcher({
      handlers: new Map(), // empty — no bindings
      log: silentLog,
    })

    const result = await dispatch(buildIntent("handoff_to_human"), ctx)

    expect(result.kind).toBe("failed")
    expect((result as { kind: "failed"; error: Error }).error.message).toContain(
      "no handler for tool",
    )
  })
})

// ── Coverage override (for tests + future extensibility) ────────────────────

describe("createIntentDispatcher — coverage override", () => {
  it("respects a custom coverage set (allowing reorder to be dispatched)", async () => {
    // Empty coverage → nothing is skipped; every intent reaches a handler.
    const handler = vi.fn<DispatchHandler>(async () => ({ ok: true }))
    const dispatch = createIntentDispatcher({
      handlers: new Map([["add_to_cart", handler]]),
      coverage: new Set<string>(),
      log: silentLog,
    })

    const result = await dispatch(buildIntent("add_to_cart"), ctx)

    expect(result.kind).toBe("executed")
    expect(handler).toHaveBeenCalledOnce()
  })
})

// ── Return-type smoke ───────────────────────────────────────────────────────

describe("DispatchResult discriminated union", () => {
  it("kind narrows the result shape", async () => {
    const handler: DispatchHandler = async () => ({ value: 42 })
    const dispatch = createIntentDispatcher({
      handlers: new Map([["handoff_to_human", handler]]),
      log: silentLog,
    })

    const result: DispatchResult = await dispatch(
      buildIntent("handoff_to_human"),
      ctx,
    )

    // Compile-time check: this only compiles if the union types are correct.
    if (result.kind === "executed") {
      expect(result.result).toEqual({ value: 42 })
    } else {
      throw new Error("expected executed")
    }
  })
})
