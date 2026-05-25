// Unit tests for createResumeDispatcherAdapter (F1 follow-up).
//
// Coverage targets:
//   (a) happy-path translation invokes the underlying dispatcher
//   (b) `kind: "failed"` doesn't throw
//   (c) unhandled exception inside adapter is caught
//   (d) audit-2026-05-24 P1-3: `kind: "skipped"` invokes the resume-side
//       kernel dispatcher (closes the "task 22" silent-drop gap).
//   (e) audit-2026-05-24 P1-3: kernel-direct envelopes (non-`order.tool.propose`
//       kinds) route to the resume-side kernel dispatcher directly.
//
// The adapter is fail-closed: it MUST never throw into the
// `defer-resolver.ts` subscriber loop, since one bad envelope would
// otherwise prevent every subsequent parked session in the same SCAN
// sweep from resuming.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core"
import type { IntentDispatcher } from "@ibatexas/llm-provider"
import { createResumeDispatcherAdapter } from "../adapters/resume-dispatcher.js"
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

// ── (a) happy-path translation invokes the underlying dispatcher ─────────────

describe("createResumeDispatcherAdapter — happy path", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  it("translates a parked ToolProposeEnvelope into ToolIntent and invokes the dispatcher", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "executed" as const,
      result: { success: true },
    }))

    const adapter = createResumeDispatcherAdapter({ dispatcher })
    const envelope = buildToolProposeEnvelope(
      "handoff_to_human",
      { sessionId: "sess_x", reason: "complex" },
      "tu_h1",
      "sess_x",
    )
    const resumed = buildResumedIntent(envelope)

    await adapter(resumed, log as never)

    expect(dispatcher).toHaveBeenCalledOnce()
    const [toolIntent, ctx] = (dispatcher as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    expect(toolIntent).toMatchObject({
      toolName: "handoff_to_human",
      input: { sessionId: "sess_x", reason: "complex" },
      toolUseId: "tu_h1",
    })
    expect(ctx).toEqual({
      sessionId: "sess_x",
      channel: "whatsapp",
      userType: "customer",
    })
    expect(log.info).toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("passes the envelope through onto ToolIntent.envelope", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "executed" as const,
      result: null,
    }))

    const adapter = createResumeDispatcherAdapter({ dispatcher })
    const envelope = buildToolProposeEnvelope("schedule_follow_up")
    const resumed = buildResumedIntent(envelope)

    await adapter(resumed, log as never)

    const [toolIntent] = (dispatcher as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(
      (toolIntent as { envelope?: { intentHash: string } }).envelope
        ?.intentHash,
    ).toBe(envelope.intentHash)
  })

  it("logs at info on executed and does not throw", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "executed" as const,
      result: { ok: 1 },
    }))
    const adapter = createResumeDispatcherAdapter({ dispatcher })

    await expect(
      adapter(
        buildResumedIntent(buildToolProposeEnvelope("handoff_to_human")),
        log as never,
      ),
    ).resolves.toBeUndefined()

    expect(log.info).toHaveBeenCalled()
  })
})

// ── (b) `kind: "failed"` doesn't throw ───────────────────────────────────────

describe("createResumeDispatcherAdapter — fail-closed", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  it("logs and returns void when the underlying dispatcher returns {kind: 'failed'}", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "failed" as const,
      error: new Error("handler exploded"),
    }))
    const adapter = createResumeDispatcherAdapter({ dispatcher })
    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("handoff_to_human"),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalledOnce()
    const [, msg] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(msg)).toContain("dispatcher returned failed")
  })

  it("[P1-3] invokes the resume-side kernel dispatcher when dispatcher returns {kind: 'skipped'}", async () => {
    // Pre-P1-3 the adapter logged "dispatch skipped — deterministic kernel
    // covers it" and returned void; the underlying mutation was silently
    // dropped on the resume path (the "task 22" gap). Post-P1-3 the
    // skipped branch routes to the kernel dispatcher which invokes the
    // tool directly.
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "skipped" as const,
      reason: "deterministic_kernel_covers" as const,
    }))
    const addToCart = vi.fn(async () => ({
      success: true,
      cart: { items: [], total: 0 },
    }))
    const adapter = createResumeDispatcherAdapter({
      dispatcher,
      kernelDispatcherDeps: { addToCart: addToCart as never },
    })
    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("add_to_cart", {
        cartId: "c1",
        variantId: "v1",
        quantity: 1,
      }),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    // The dispatcher classifies as skipped, then the kernel dispatcher fires.
    expect(dispatcher).toHaveBeenCalledOnce()
    expect(addToCart).toHaveBeenCalledOnce()
    expect(log.error).not.toHaveBeenCalled()
    // Success log was emitted.
    expect(log.info).toHaveBeenCalled()
  })

  it("[P1-3] routes a kernel-direct parked envelope (non-`order.tool.propose`) to the kernel dispatcher", async () => {
    const dispatcher = vi.fn<IntentDispatcher>()
    const createCheckout = vi.fn(async () => ({
      success: true,
      paymentMethod: "pix",
      orderId: "ord_1",
      message: "ok",
    }))
    const adapter = createResumeDispatcherAdapter({
      dispatcher,
      kernelDispatcherDeps: { createCheckout: createCheckout as never },
    })

    // A kernel-executor-style parked envelope: kind is the taxonomy kind,
    // payload is the input directly — no toolName field. Pre-P1-3 this
    // produced a "payload is not a ToolProposePayload" warn-and-return;
    // post-P1-3 it routes through the kernel dispatcher.
    const envelope = buildEnvelope({
      kind: "order.checkout.create",
      payload: { cartId: "cart_x", paymentMethod: "pix" },
      actor: { principal: "system", sessionId: "sess_y" },
      taint: "SYSTEM",
      nonce: "n_y",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    // The IntentDispatcher is NOT invoked (translation returned null).
    expect(dispatcher).not.toHaveBeenCalled()
    // The kernel dispatcher IS invoked.
    expect(createCheckout).toHaveBeenCalledOnce()
    const [input] = (createCheckout as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(input).toEqual({ cartId: "cart_x", paymentMethod: "pix" })
  })

  it("[P1-3] warns when a parked envelope has no kernel-covered resume route", async () => {
    const dispatcher = vi.fn<IntentDispatcher>()
    const adapter = createResumeDispatcherAdapter({ dispatcher })

    // An envelope kind we have no resume route for. The kernel dispatcher
    // returns `unsupported`; the adapter logs a warning and returns void.
    const envelope = buildEnvelope({
      kind: "future.kind.we.dont.know",
      payload: { x: 1 },
      actor: { principal: "system", sessionId: "sess_y" },
      taint: "SYSTEM",
      nonce: "n_y",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(dispatcher).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("[P1-3] logs error and returns void when the resume kernel tool throws", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "skipped" as const,
      reason: "deterministic_kernel_covers" as const,
    }))
    const createCheckout = vi.fn(async () => {
      throw new Error("medusa unavailable")
    })
    const adapter = createResumeDispatcherAdapter({
      dispatcher,
      kernelDispatcherDeps: { createCheckout: createCheckout as never },
    })

    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("create_checkout", {
        cartId: "c1",
        paymentMethod: "pix",
      }),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(createCheckout).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalled()
    const [, msg] = (log.error as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(msg)).toContain("kernel-covered resume tool threw")
  })
})

// ── (c) unhandled exception inside adapter is caught ─────────────────────────

describe("createResumeDispatcherAdapter — exception swallowing", () => {
  let log: FakeLogger

  beforeEach(() => {
    log = makeFakeLogger()
  })

  it("catches and logs an unexpected throw from the underlying dispatcher", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => {
      throw new Error("dispatcher impl threw — should never escape adapter")
    })
    const adapter = createResumeDispatcherAdapter({ dispatcher })
    const resumed = buildResumedIntent(
      buildToolProposeEnvelope("handoff_to_human"),
    )

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalled()
    const [errMeta] = (log.error as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) =>
        String(call[1] ?? "").includes("unexpected exception inside adapter"),
    ) ?? [null]
    expect(errMeta).not.toBeNull()
  })

  it("works even when no logger is provided (silent fail-closed)", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => {
      throw new Error("silent boom")
    })
    const adapter = createResumeDispatcherAdapter({ dispatcher })

    await expect(
      adapter(buildResumedIntent(buildToolProposeEnvelope("handoff_to_human"))),
    ).resolves.toBeUndefined()
  })

  it("does not throw when translation explodes on a hostile envelope", async () => {
    // A parked envelope whose payload claims to have a toolName field that
    // is actually a non-string. The translation rejects it and the adapter
    // logs + returns void.
    const dispatcher = vi.fn<IntentDispatcher>()
    const adapter = createResumeDispatcherAdapter({ dispatcher })

    const envelope = buildEnvelope({
      kind: "order.tool.propose",
      // toolName: 42 — not a string. The translation MUST reject it.
      payload: { toolName: 42, input: {}, toolUseId: "x" },
      actor: { principal: "llm", sessionId: "sess_h" },
      taint: "UNTRUSTED",
      nonce: "n_h",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(dispatcher).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })
})

// ── Adapter construction defaults ────────────────────────────────────────────

describe("createResumeDispatcherAdapter — defaults", () => {
  it("uses the default intent-dispatcher when none is injected", async () => {
    // Smoke test only — we don't want to actually fire handoff_to_human
    // (it would hit NATS). The default handler set covers
    // handoff_to_human / schedule_follow_up / set_pix_details; passing a
    // non-existent tool name forces the dispatcher into its no-handler
    // path which returns {kind: "failed"} synchronously without I/O.
    const log = makeFakeLogger()
    const adapter = createResumeDispatcherAdapter()
    const envelope = buildToolProposeEnvelope("definitely_not_a_handler")
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(log.error).toHaveBeenCalled()
  })
})
