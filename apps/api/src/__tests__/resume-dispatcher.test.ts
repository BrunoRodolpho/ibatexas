// Unit tests for createResumeDispatcherAdapter (F1 follow-up; re-expressed WS5;
// ACT-071 order.tool.propose shim retired).
//
// Coverage targets (all on the surviving kernel-covered taxonomy-kind path):
//   (a) a kernel-direct parked envelope (kind IS the taxonomy mutation kind)
//       routes to the @ibatexas/tools handler with the payload as input
//   (b) an unresolvable parked kind warns + returns void (no route to retry)
//   (c) GOVERNANCE: a kernel-covered tool throw RE-THROWS (propagates) so the
//       defer-resolver DLQs + does NOT commit defer:resumed (audit-2026-05-25 I6)
//   (d) the I6 customerId hoist threads actor.sessionId into the ctx for a
//       user-principal park
//   (e) route classification: the four PIX-deferrable kinds resolve to their
//       handler; an unknown kind → null
//
// Every surviving resume route is a destructive PIX-settlement mutation, so a
// tool throw ALWAYS re-throws to the DLQ (audit-2026-05-25 I6); the
// defer-resolver's dispatch try/catch is what catches it and prevents the
// durable resume commit. The ONLY warn-and-void path is an unresolvable parked
// kind (nothing to retry). The pre-WS5 `order.tool.propose` compat shim (a
// payload.toolName alias table + payload.input extraction + a non-kernel
// notification tier) was retired in ACT-071 — those tests went with it.

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

function buildResumedIntent(envelope: IntentEnvelope): ResumedIntent {
  return {
    envelope,
    sessionId: envelope.actor.sessionId,
    originalIntentHash: envelope.intentHash,
  }
}

// ── Kernel-direct routing ─────────────────────────────────────────────────────

describe("createResumeDispatcherAdapter — kernel-direct routing", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
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

// ── GOVERNANCE: kernel-covered throw RE-THROWS to the DLQ path ─────────────────

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
  // lost). WS5 restores the documented contract: kernel-covered failures
  // PROPAGATE out of the adapter.
  it("re-throws when a kernel-covered tool throws (so defer-resolver DLQs + does not commit)", async () => {
    const createCheckout = vi.fn(async () => {
      throw new Error("medusa unavailable")
    })
    const adapter = createResumeDispatcherAdapter({
      tools: { createCheckout: createCheckout as never },
    })

    // Kernel-direct parked envelope: kind IS the taxonomy kind.
    const envelope = buildEnvelope({
      kind: "order.checkout.create",
      payload: { cartId: "c1", paymentMethod: "pix" },
      actor: { principal: "system", sessionId: "sess_rethrow" },
      taint: "SYSTEM",
      nonce: "n_rethrow",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

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

// ── Route resolution (pure) ──────────────────────────────────────────────────

describe("resolveResumeRoute — kind classification", () => {
  it("resolves the four PIX-deferrable taxonomy kinds to their tool handler", () => {
    const kernelKinds: Array<[string, string]> = [
      ["order.item.add", "add_to_cart"],
      ["order.checkout.create", "create_checkout"],
      ["order.cancel", "cancel_order"],
      ["payment.pix.regenerate", "regenerate_pix"],
    ]
    for (const [kind, toolName] of kernelKinds) {
      const env = buildEnvelope({
        kind,
        payload: {},
        actor: { principal: "system", sessionId: "s" },
        taint: "SYSTEM",
        nonce: `n_${kind}`,
      }) as IntentEnvelope
      expect(__testOnly__resolveResumeRoute(env)?.toolName).toBe(toolName)
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
