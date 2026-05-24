// Tests for twilioAdjudicated — the kernel-gated Twilio egress wrapper.
//
// Covers the invariants the audit-2026-05-23 spec calls out plus standard
// safety cases (envelope construction per kind, idempotency-key → nonce,
// REFUSE on invalid payload, audit-emit failure non-blocking, real kernel
// called).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { AuditRecord, AuditSink } from "@adjudicate/core"
import {
  TWILIO_INTENT_KINDS,
  TwilioAdjudicateNeedsReviewError,
  TwilioAdjudicateRefusedError,
  twilioAdjudicated,
  __setTwilioClientForTests,
  type TwilioClientLike,
} from "../adjudicated.js"

// ── Fake Twilio SDK ──────────────────────────────────────────────────────
//
// We don't network. Instead we inject a hand-rolled client into the
// wrapper's module-level slot via __setTwilioClientForTests. Each
// method records its (input) call and returns a canned resource so the
// wrapper can be observed end-to-end.

function makeFakeTwilio(): {
  fake: TwilioClientLike
  calls: Array<{ method: string; args: unknown[] }>
} {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const fake: TwilioClientLike = {
    messages: {
      create: vi.fn((input: unknown) => {
        calls.push({ method: "messages.create", args: [input] })
        return Promise.resolve({ sid: "SM_fake_message" })
      }),
    },
  }
  return { fake, calls }
}

// In-memory audit sink — same helper used by medusa/stripe-adjudicated tests.
function createMemoryAuditSink(): {
  sink: AuditSink
  records: AuditRecord[]
} {
  const records: AuditRecord[] = []
  const sink: AuditSink = {
    async emit(record) {
      records.push(record)
    },
  }
  return { sink, records }
}

beforeEach(() => {
  process.env["TWILIO_ACCOUNT_SID"] = "AC_test_dummy"
  process.env["TWILIO_AUTH_TOKEN"] = "auth_test_dummy"
})

afterEach(() => {
  __setTwilioClientForTests(null)
  vi.clearAllMocks()
})

// ── TWILIO_INTENT_KINDS sanity ──────────────────────────────────────────

describe("TWILIO_INTENT_KINDS", () => {
  it("exposes twilio.message.send plus twilio.unknown", () => {
    expect(TWILIO_INTENT_KINDS).toHaveLength(2)
    expect(new Set(TWILIO_INTENT_KINDS).size).toBe(2)
    expect(TWILIO_INTENT_KINDS).toContain("twilio.message.send")
    expect(TWILIO_INTENT_KINDS).toContain("twilio.unknown")
  })
})

// ── Happy path: envelope construction + SDK dispatch ─────────────────────

describe("twilioAdjudicated.messages.create — EXECUTE", () => {
  it("builds a SYSTEM envelope with kind=twilio.message.send, dispatches SDK, emits audit", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    const result = await twilioAdjudicated.messages.create(
      {
        from: "whatsapp:+5511999990000",
        to: "whatsapp:+5511988887777",
        body: "Olá! Pedido confirmado.",
      },
      { sourceSubject: "test:send-text", auditSink: sink },
    )

    expect(result).toEqual({ sid: "SM_fake_message" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("messages.create")
    const input = calls[0]!.args[0] as {
      from: string
      to: string
      body: string
    }
    expect(input.from).toBe("whatsapp:+5511999990000")
    expect(input.to).toBe("whatsapp:+5511988887777")
    expect(input.body).toBe("Olá! Pedido confirmado.")

    // Audit record emitted with the right envelope shape.
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("twilio.message.send")
    expect(records[0]!.envelope.actor.principal).toBe("system")
    expect(records[0]!.envelope.taint).toBe("SYSTEM")
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })

  it("dispatches mediaUrl-only sends (no body) when mediaUrl array is present", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await twilioAdjudicated.messages.create(
      {
        from: "whatsapp:+5511999990000",
        to: "whatsapp:+5511988887777",
        mediaUrl: ["https://example.com/receipt.pdf"],
      },
      { sourceSubject: "test:send-media", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    const input = calls[0]!.args[0] as {
      from: string
      to: string
      body?: string
      mediaUrl: string[]
    }
    expect(input.body).toBeUndefined()
    expect(input.mediaUrl).toEqual(["https://example.com/receipt.pdf"])

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })

  it("dispatches body+mediaUrl sends (both present) and forwards both fields", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)

    await twilioAdjudicated.messages.create(
      {
        from: "whatsapp:+5511999990000",
        to: "whatsapp:+5511988887777",
        body: "Seu recibo:",
        mediaUrl: ["https://example.com/receipt.pdf"],
      },
      { sourceSubject: "test:send-both" },
    )

    expect(calls).toHaveLength(1)
    const input = calls[0]!.args[0] as {
      body: string
      mediaUrl: string[]
    }
    expect(input.body).toBe("Seu recibo:")
    expect(input.mediaUrl).toEqual(["https://example.com/receipt.pdf"])
  })

  it("forwards the (possibly REWRITE-rewritten) payload to the SDK", async () => {
    // The current inline policy does not REWRITE — but the wrapper MUST
    // read `env.payload` (not the input) so a future rewriter is honored.
    // We assert that by checking the SDK receives the exact same shape
    // we passed in (no in-place mutation, no field drops).
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)

    await twilioAdjudicated.messages.create(
      {
        from: "whatsapp:+1",
        to: "whatsapp:+2",
        body: "x",
      },
      { sourceSubject: "test:passthrough" },
    )

    expect(calls).toHaveLength(1)
    const input = calls[0]!.args[0] as {
      from: string
      to: string
      body: string
    }
    expect(input.from).toBe("whatsapp:+1")
    expect(input.to).toBe("whatsapp:+2")
    expect(input.body).toBe("x")
  })
})

// ── Idempotency key → envelope nonce ─────────────────────────────────────

describe("twilioAdjudicated — idempotency key", () => {
  it("sets envelope.nonce to the supplied idempotencyKey", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      {
        sourceSubject: "test:idem",
        auditSink: sink,
        idempotencyKey: "key-from-caller",
      },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.nonce).toBe("key-from-caller")
  })

  it("two calls with the same idempotencyKey + payload produce identical intentHash", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    const meta = {
      sourceSubject: "test:replay",
      auditSink: sink,
      idempotencyKey: "stable-replay-key",
    } as const

    await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      meta,
    )
    await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      meta,
    )
    await Promise.resolve()

    expect(records).toHaveLength(2)
    expect(records[0]!.envelope.intentHash).toBe(records[1]!.envelope.intentHash)
  })

  it("generates a non-empty nonce when no idempotencyKey is supplied", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      { sourceSubject: "test:no-idem", auditSink: sink },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(typeof records[0]!.envelope.nonce).toBe("string")
    expect(records[0]!.envelope.nonce.length).toBeGreaterThan(0)
  })
})

// ── REFUSE on invalid payload ────────────────────────────────────────────

describe("twilioAdjudicated — REFUSE on invalid payload", () => {
  it("REFUSEs when `from` is empty", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await expect(
      twilioAdjudicated.messages.create(
        { from: "", to: "whatsapp:+2", body: "x" },
        { sourceSubject: "test:empty-from", auditSink: sink },
      ),
    ).rejects.toBeInstanceOf(TwilioAdjudicateRefusedError)

    expect(calls).toHaveLength(0)
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("REFUSE")
  })

  it("REFUSEs when `to` is empty", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await expect(
      twilioAdjudicated.messages.create(
        { from: "whatsapp:+1", to: "   ", body: "x" },
        { sourceSubject: "test:empty-to", auditSink: sink },
      ),
    ).rejects.toBeInstanceOf(TwilioAdjudicateRefusedError)

    expect(calls).toHaveLength(0)
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("REFUSE")
  })

  it("REFUSEs when both body and mediaUrl are empty/missing", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    let captured: TwilioAdjudicateRefusedError | null = null
    try {
      await twilioAdjudicated.messages.create(
        { from: "whatsapp:+1", to: "whatsapp:+2" },
        { sourceSubject: "test:empty-content", auditSink: sink },
      )
    } catch (err) {
      captured = err as TwilioAdjudicateRefusedError
    }

    expect(captured).not.toBeNull()
    expect(captured?.code).toBe("twilio.message.empty")
    expect(captured?.userFacing).toMatch(/conteúdo/)
    expect(calls).toHaveLength(0)

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("REFUSE")
  })

  it("EXECUTEs when body is empty but mediaUrl is non-empty", async () => {
    const { fake, calls } = makeFakeTwilio()
    __setTwilioClientForTests(fake)

    await twilioAdjudicated.messages.create(
      {
        from: "whatsapp:+1",
        to: "whatsapp:+2",
        mediaUrl: ["https://example.com/x.jpg"],
      },
      { sourceSubject: "test:media-only" },
    )

    expect(calls).toHaveLength(1)
  })
})

// ── Audit sink failure non-blocking ─────────────────────────────────────

describe("twilioAdjudicated — audit fail-open", () => {
  it("does not propagate audit sink errors to the caller", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const failingSink: AuditSink = {
      async emit() {
        throw new Error("nats broker down")
      },
    }
    const errorLog = vi.fn()

    const result = await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      {
        sourceSubject: "test:audit-fail",
        auditSink: failingSink,
        log: { error: errorLog },
      },
    )

    expect(result).toEqual({ sid: "SM_fake_message" })
    // Give the fire-and-forget emit a microtask to settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLog).toHaveBeenCalled()
  })

  it("works without an audit sink", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)

    const result = await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      { sourceSubject: "test:no-sink" },
    )
    expect(result).toEqual({ sid: "SM_fake_message" })
  })
})

// ── REQUEST_CONFIRMATION / ESCALATE — typed error structural test ───────

describe("twilioAdjudicated — needs-review error class", () => {
  // Like medusaAdjudicated / stripeAdjudicated, the inline policy never
  // emits REQUEST_CONFIRMATION / ESCALATE today. The error class is
  // still tested structurally so adopters can read `prompt` / `to` /
  // `reason` off the thrown error.
  it("carries REQUEST_CONFIRMATION decision payload through the error class", () => {
    const confirmDecision = {
      kind: "REQUEST_CONFIRMATION" as const,
      prompt: "Confirm this WhatsApp blast?",
      basis: [],
    }
    const err = new TwilioAdjudicateNeedsReviewError(confirmDecision)
    expect(err.decision).toBe(confirmDecision)
    expect(err.message).toContain("Confirm this WhatsApp blast?")
  })

  it("carries ESCALATE decision payload through the error class", () => {
    const escalateDecision = {
      kind: "ESCALATE" as const,
      to: "human" as const,
      reason: "Outbound message volume exceeds threshold",
      basis: [],
    }
    const escErr = new TwilioAdjudicateNeedsReviewError(escalateDecision)
    expect(escErr.decision).toBe(escalateDecision)
    expect(escErr.message).toContain("Outbound message volume")
  })
})

// ── REFUSE surfaces pt-BR userFacing ────────────────────────────────────

describe("twilioAdjudicated — REFUSE refusal copy", () => {
  it("attaches pt-BR userFacing copy to TwilioAdjudicateRefusedError", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)

    let captured: TwilioAdjudicateRefusedError | null = null
    try {
      await twilioAdjudicated.messages.create(
        { from: "", to: "whatsapp:+2", body: "x" },
        { sourceSubject: "test:refuse-msg" },
      )
    } catch (err) {
      captured = err as TwilioAdjudicateRefusedError
    }
    expect(captured).not.toBeNull()
    expect(captured?.code).toBe("twilio.message.invalid_phone")
    expect(captured?.userFacing).toMatch(/remetente|destinatário/)
  })
})

// ── Reason / sessionId formatting ───────────────────────────────────────

describe("twilioAdjudicated — meta.reason in sessionId", () => {
  it("appends the reason to actor.sessionId for audit-grep ergonomics", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      {
        sourceSubject: "whatsapp:sendText",
        reason: "send-text",
        auditSink: sink,
      },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.actor.sessionId).toBe(
      "whatsapp:sendText:twilio.message.send:send-text",
    )
  })

  it("falls back to bare kind in sessionId when no reason is supplied", async () => {
    const { fake } = makeFakeTwilio()
    __setTwilioClientForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await twilioAdjudicated.messages.create(
      { from: "whatsapp:+1", to: "whatsapp:+2", body: "x" },
      { sourceSubject: "whatsapp:sendText", auditSink: sink },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.actor.sessionId).toBe(
      "whatsapp:sendText:twilio.message.send",
    )
  })
})
