// Unit tests for createResumeDispatcherAdapter (F1 follow-up; re-expressed WS5).
//
// Coverage targets:
//   (a) happy-path non-kernel tool (handoff_to_human) invokes the handler with
//       the synthesized AgentContext
//   (b) a non-kernel handler throw is LOGGED + swallowed (audit-only outcome) —
//       does NOT throw into the subscriber loop
//   (c) an unhandled exception on the non-kernel / route-resolution path is
//       caught (subscriber-loop protection)
//   (d) WS5 (was audit-2026-05-24 P1-3): a deterministic-kernel-covered tool
//       (`add_to_cart`) routes to the kernel tier and invokes the underlying
//       @ibatexas/tools handler directly
//   (e) WS5: a kernel-direct parked envelope (non-`order.tool.propose` taxonomy
//       kind) routes to the kernel tier directly
//   (f) WS5 GOVERNANCE: a kernel-covered tool throw RE-THROWS (propagates) so
//       the defer-resolver DLQs + does NOT commit defer:resumed. See the
//       "governance note" below — this is the behavior the pre-WS5 outer
//       catch-all silently defeated.
//
// The adapter is fail-closed on the NON-kernel path: it MUST never throw into
// the `defer-resolver.ts` subscriber loop for a notification-tool failure, since
// one bad envelope would otherwise prevent every subsequent parked session in
// the same SCAN sweep from resuming. The KERNEL path is deliberately NOT
// fail-closed against throws — a money-settlement mutation failure must surface
// to the DLQ (audit-2026-05-25 I6); the defer-resolver's dispatch try/catch is
// what catches it and prevents the durable resume commit.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import {
  createResumeDispatcherAdapter,
  __testOnly__resolveResumeRoute,
} from "../adapters/resume-dispatcher.js"
import type { ResumedIntent } from "../subscribers/defer-resolver.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakeLogger {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  fatal: ReturnType<typeof vi.fn>
  trace: ReturnType<typeof vi.fn>
  child: ReturnType<typeof vi.fn>
  level: string
  silent: ReturnType<typeof vi.fn>
}

function makeFakeLogger(): FakeLogger {
  const child = vi.fn()
  const logger: FakeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child,
    level: "info",
    silent: vi.fn(),
  }
  child.mockReturnValue(logger)
  return logger
}

function buildToolProposeEnvelope(
  toolName: string,
  input: unknown = {},
  toolUseId = "tu_test",
  sessionId = "sess_test_01",
): IntentEnvelope {
  return buildEnvelope({
    kind: "order.tool.propose",
    payload: { toolName, input, toolUseId },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: `n_${Math.random().toString(36).slice(2)}`,
  }) as IntentEnvelope
}

function buildResumedIntent(envelope: IntentEnvelope): ResumedIntent {
  return {
    envelope,
    sessionId: envelope.actor.sessionId,
    originalIntentHash: envelope.intentHash,
  }
}

// ── (a) happy-path non-kernel tool ───────────────────────────────────────────

describe("createResumeDispatcherAdapter — non-kernel happy path", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  it("routes a parked handoff_to_human propose envelope to the handler with the synthesized ctx", async () => {
    const handoffToHuman = vi.fn(async () => ({ ok: true }))

    const adapter = createResumeDispatcherAdapter({
      tools: { handoffToHuman: handoffToHuman as never },
    })
    const envelope = buildToolProposeEnvelope(
      "handoff_to_human",
      { sessionId: "sess_x", reason: "complex" },
      "tu_h1",
      "sess_x",
    )
    const resumed = buildResumedIntent(envelope)

    await adapter(resumed, log as never)

    expect(handoffToHuman).toHaveBeenCalledOnce()
    // handoff_to_human reads only the input payload (ctx unused upstream).
    const [input] = (handoffToHuman as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(input).toEqual({ sessionId: "sess_x", reason: "complex" })
    expect(log.info).toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("synthesizes {sessionId, channel: whatsapp, userType: customer} for a ctx-consuming non-kernel tool", async () => {
    const scheduleFollowUp = vi.fn(async () => ({ success: true, message: "ok" }))
    const adapter = createResumeDispatcherAdapter({
      tools: { scheduleFollowUp: scheduleFollowUp as never },
    })
    const envelope = buildToolProposeEnvelope(
      "schedule_follow_up",
      { delayHours: 2 },
      "tu_s1",
      "sess_sched",
    )
    const resumed = buildResumedIntent(envelope)

    await adapter(resumed, log as never)

    expect(scheduleFollowUp).toHaveBeenCalledOnce()
    const [, ctx] = (scheduleFollowUp as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(ctx).toEqual({
      sessionId: "sess_sched",
      channel: "whatsapp",
      userType: "customer",
    })
  })

  it("logs at info on success and does not throw", async () => {
    const handoffToHuman = vi.fn(async () => ({ ok: 1 }))
    const adapter = createResumeDispatcherAdapter({
      tools: { handoffToHuman: handoffToHuman as never },
    })

    await expect(
      adapter(
        buildResumedIntent(buildToolProposeEnvelope("handoff_to_human")),
        log as never,
      ),
    ).resolves.toBeUndefined()

    expect(log.info).toHaveBeenCalled()
  })
})

// ── (b) non-kernel handler throw is logged + swallowed ────────────────────────

describe("createResumeDispatcherAdapter — non-kernel fail-closed", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  it("logs and returns void when a non-kernel handler throws (audit-only outcome)", async () => {
    const handoffToHuman = vi.fn(async () => {
      throw new Error("handler exploded")
    })
    const adapter = createResumeDispatcherAdapter({
      tools: { handoffToHuman: handoffToHuman as never },
    })
    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("handoff_to_human"),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(handoffToHuman).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledOnce()
    const [, msg] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(msg)).toContain("audit-only outcome")
  })

  it("[WS5] routes a deterministic-kernel-covered tool (add_to_cart) to the kernel tier", async () => {
    // Pre-WS5 the intent-dispatcher reported `skipped` for
    // DETERMINISTIC_KERNEL_COVERAGE tools and the adapter handed off to the
    // resume-side kernel dispatcher. WS5 collapses that into a single resume
    // table: add_to_cart resolves to the kernel tier and invokes the tool.
    const addToCart = vi.fn(async () => ({
      success: true,
      cart: { items: [], total: 0 },
    }))
    const adapter = createResumeDispatcherAdapter({
      tools: { addToCart: addToCart as never },
    })
    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("add_to_cart", {
        cartId: "c1",
        variantId: "v1",
        quantity: 1,
      }),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(addToCart).toHaveBeenCalledOnce()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalled()
  })

  it("[WS5] routes a kernel-direct parked envelope (non-`order.tool.propose`) to the kernel tier", async () => {
    const createCheckout = vi.fn(async () => ({
      success: true,
      paymentMethod: "pix",
      orderId: "ord_1",
      message: "ok",
    }))
    const adapter = createResumeDispatcherAdapter({
      tools: { createCheckout: createCheckout as never },
    })

    // A kernel-executor-style parked envelope: kind IS the taxonomy kind, the
    // payload is the input directly — no toolName field.
    const envelope = buildEnvelope({
      kind: "order.checkout.create",
      payload: { cartId: "cart_x", paymentMethod: "pix" },
      actor: { principal: "system", sessionId: "sess_y" },
      taint: "SYSTEM",
      nonce: "n_y",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(createCheckout).toHaveBeenCalledOnce()
    const [input] = (createCheckout as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(input).toEqual({ cartId: "cart_x", paymentMethod: "pix" })
  })

  it("[WS5] warns when a parked envelope has no resume dispatch route", async () => {
    const adapter = createResumeDispatcherAdapter()

    const envelope = buildEnvelope({
      kind: "future.kind.we.dont.know",
      payload: { x: 1 },
      actor: { principal: "system", sessionId: "sess_y" },
      taint: "SYSTEM",
      nonce: "n_y",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(log.warn).toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })
})

// ── (f) WS5 GOVERNANCE: kernel-covered throw RE-THROWS to the DLQ path ────────

describe("createResumeDispatcherAdapter — kernel-tier re-throw (I6 / WS5)", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  // GOVERNANCE: this is the behavior the pre-WS5 adapter SILENTLY DEFEATED.
  // The resume-side kernel dispatcher always re-threw on a kernel-covered tool
  // failure (audit-2026-05-25 I6) so the defer-resolver's dispatch try/catch
  // would DLQ the resume and NOT commit `defer:resumed` — making the
  // destructive PIX-settlement mutation retryable. But the pre-WS5 adapter
  // wrapped that re-throw inside its catastrophic outer catch-all, which
  // swallowed it and returned void — so defer-resolver saw success and
  // committed the resume after a FAILED money mutation (PIX captured, action
  // lost). The pre-WS5 unit test even asserted `resolves.toBeUndefined()` on a
  // kernel throw, encoding the bug. WS5 restores the documented contract:
  // kernel-covered failures PROPAGATE out of the adapter.
  it("re-throws when a kernel-covered tool throws (so defer-resolver DLQs + does not commit)", async () => {
    const createCheckout = vi.fn(async () => {
      throw new Error("medusa unavailable")
    })
    const adapter = createResumeDispatcherAdapter({
      tools: { createCheckout: createCheckout as never },
    })

    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("create_checkout", {
        cartId: "c1",
        paymentMethod: "pix",
      }),
    )

    await expect(adapter(resumed, log as never)).rejects.toThrow(
      "medusa unavailable",
    )

    expect(createCheckout).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalled()
    const [, msg] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(msg)).toContain("kernel-covered resume tool threw")
  })

  it("threads customerId from a user-principal actor into the kernel-tier ctx (I6)", async () => {
    const cancelOrder = vi.fn(async () => ({ success: true }))
    const adapter = createResumeDispatcherAdapter({
      tools: { cancelOrder: cancelOrder as never },
    })

    // Customer-initiated park: actor.principal = "user", sessionId = customerId.
    const envelope = buildEnvelope({
      kind: "order.cancel",
      payload: { orderId: "ord_9" },
      actor: { principal: "user", sessionId: "cust_777" },
      taint: "UNTRUSTED",
      nonce: "n_cancel",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await adapter(resumed, log as never)

    expect(cancelOrder).toHaveBeenCalledOnce()
    const [, ctx] = (cancelOrder as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(ctx).toMatchObject({
      sessionId: "cust_777",
      channel: "whatsapp",
      userType: "customer",
      customerId: "cust_777",
    })
  })
})

// ── (c) unhandled exception on the non-kernel path is caught ──────────────────

describe("createResumeDispatcherAdapter — non-kernel exception swallowing", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  it("does not throw when a non-kernel tool fn is malformed and throws synchronously", async () => {
    // A non-kernel "handler" that throws synchronously (not a rejected
    // promise) — the catch-all must absorb it so the subscriber loop survives.
    const scheduleFollowUp = vi.fn(() => {
      throw new Error("sync boom")
    })
    const adapter = createResumeDispatcherAdapter({
      tools: { scheduleFollowUp: scheduleFollowUp as never },
    })
    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("schedule_follow_up"),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalled()
  })

  it("works even when no logger is provided (silent fail-closed on non-kernel)", async () => {
    const handoffToHuman = vi.fn(async () => {
      throw new Error("silent boom")
    })
    const adapter = createResumeDispatcherAdapter({
      tools: { handoffToHuman: handoffToHuman as never },
    })

    await expect(
      adapter(buildResumedIntent(buildToolProposeEnvelope("handoff_to_human"))),
    ).resolves.toBeUndefined()
  })

  it("does not throw when a propose envelope carries a non-string toolName (no route)", async () => {
    // A parked envelope whose payload claims a toolName that is actually a
    // non-string. resolveResumeRoute returns null; the adapter warns + voids.
    const adapter = createResumeDispatcherAdapter()

    const envelope = buildEnvelope({
      kind: "order.tool.propose",
      payload: { toolName: 42, input: {}, toolUseId: "x" },
      actor: { principal: "llm", sessionId: "sess_h" },
      taint: "UNTRUSTED",
      nonce: "n_h",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
  })
})

// ── Route resolution (pure) ──────────────────────────────────────────────────

describe("resolveResumeRoute — tier classification", () => {
  it("classifies the four kernel-covered kinds + their tool-name aliases as kernel tier", () => {
    const kernelKinds = [
      "order.item.add",
      "order.checkout.create",
      "order.cancel",
      "payment.pix.regenerate",
    ]
    for (const kind of kernelKinds) {
      const env = buildEnvelope({
        kind,
        payload: {},
        actor: { principal: "system", sessionId: "s" },
        taint: "SYSTEM",
        nonce: `n_${kind}`,
      }) as IntentEnvelope
      expect(__testOnly__resolveResumeRoute(env)?.tier).toBe("kernel")
    }
    const aliases = [
      "add_to_cart",
      "create_checkout",
      "cancel_order",
      "regenerate_pix",
    ]
    for (const toolName of aliases) {
      const env = buildToolProposeEnvelope(toolName)
      expect(__testOnly__resolveResumeRoute(env)?.tier).toBe("kernel")
    }
  })

  it("classifies handoff / schedule / set_pix as non-kernel tier", () => {
    for (const toolName of [
      "handoff_to_human",
      "schedule_follow_up",
      "set_pix_details",
    ]) {
      const env = buildToolProposeEnvelope(toolName)
      expect(__testOnly__resolveResumeRoute(env)?.tier).toBe("non_kernel")
    }
  })

  it("returns null for an unknown kind", () => {
    const env = buildEnvelope({
      kind: "totally.unknown.kind",
      payload: {},
      actor: { principal: "system", sessionId: "s" },
      taint: "SYSTEM",
      nonce: "n_u",
    }) as IntentEnvelope
    expect(__testOnly__resolveResumeRoute(env)).toBeNull()
  })
})

// ── Adapter construction defaults ────────────────────────────────────────────

describe("createResumeDispatcherAdapter — defaults", () => {
  it("uses the live @ibatexas/tools handlers when none are injected (no-route smoke)", async () => {
    // Smoke test only — we don't want to fire a live handler. An envelope with
    // no resume route exercises the default path without any tool I/O.
    const log = makeFakeLogger()
    const adapter = createResumeDispatcherAdapter()
    const envelope = buildEnvelope({
      kind: "no.such.kind",
      payload: {},
      actor: { principal: "system", sessionId: "s" },
      taint: "SYSTEM",
      nonce: "n_def",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalled()
  })
})
