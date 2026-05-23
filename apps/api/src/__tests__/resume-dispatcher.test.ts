// Unit tests for createResumeDispatcherAdapter (F1 follow-up).
//
// Coverage targets (per the task brief):
//   (a) happy-path translation invokes the underlying dispatcher
//   (b) `kind: "failed"` doesn't throw
//   (c) unhandled exception inside adapter is caught
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

  it("logs at info when the dispatcher returns {kind: 'skipped'}", async () => {
    const dispatcher = vi.fn<IntentDispatcher>(async () => ({
      kind: "skipped" as const,
      reason: "deterministic_kernel_covers" as const,
    }))
    const adapter = createResumeDispatcherAdapter({ dispatcher })
    const resumed = buildResumedIntent(buildToolProposeEnvelope("add_to_cart"))

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()
    expect(log.info).toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it("warns and returns void when the parked envelope payload is not a ToolProposePayload", async () => {
    const dispatcher = vi.fn<IntentDispatcher>()
    const adapter = createResumeDispatcherAdapter({ dispatcher })

    // Build a parked envelope whose payload is a non-tool-propose shape
    // (e.g. a domain-specific kind under task 06's vocabulary).
    const envelope = buildEnvelope({
      kind: "order.checkout.create",
      // Deliberately omit `toolName` so translation returns null.
      payload: { cartId: "cart_x", paymentMethod: "pix" },
      actor: { principal: "llm", sessionId: "sess_y" },
      taint: "UNTRUSTED",
      nonce: "n_y",
    }) as IntentEnvelope
    const resumed = buildResumedIntent(envelope)

    await expect(adapter(resumed, log as never)).resolves.toBeUndefined()

    expect(dispatcher).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledOnce()
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
