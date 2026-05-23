// Tests for stripeAdjudicated — the kernel-gated Stripe egress wrapper.
//
// Covers the invariants the W7 P5 spec calls out plus standard safety
// cases (envelope construction per kind, idempotency-key → nonce →
// header propagation, default-REFUSE on unknown kind, audit-emit
// failure non-blocking, allowlist env override, real kernel called).

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
  STRIPE_INTENT_KINDS,
  StripeAdjudicateNeedsReviewError,
  StripeAdjudicateRefusedError,
  stripeAdjudicated,
  __setStripeClientForTests,
} from "../adjudicated.js"

// ── Fake Stripe SDK ──────────────────────────────────────────────────────
//
// We don't network. Instead we inject a hand-rolled client into the
// wrapper's module-level slot via __setStripeClientForTests. Each
// method records its (params, options) call and returns a canned
// resource so the wrapper can be observed end-to-end.

function makeFakeStripe() {
  const calls: Array<{
    method: string
    args: unknown[]
  }> = []

  function record<R>(method: string, returnValue: R) {
    return (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve(returnValue) as unknown
    }
  }

  const fake = {
    paymentIntents: {
      create: vi.fn(record("paymentIntents.create", { id: "pi_new", object: "payment_intent" })),
      confirm: vi.fn(record("paymentIntents.confirm", { id: "pi_confirmed", object: "payment_intent" })),
      update: vi.fn(record("paymentIntents.update", { id: "pi_updated", object: "payment_intent" })),
      cancel: vi.fn(record("paymentIntents.cancel", { id: "pi_canceled", object: "payment_intent" })),
    },
    refunds: {
      create: vi.fn(record("refunds.create", { id: "re_new", object: "refund" })),
    },
    customers: {
      create: vi.fn(record("customers.create", { id: "cus_new", object: "customer" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(record("checkout.sessions.create", { id: "cs_new", object: "checkout.session" })),
      },
    },
  }

  return { fake, calls }
}

// In-memory audit sink — same helper used by medusa-adjudicated tests.
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
  process.env["STRIPE_SECRET_KEY"] = "sk_test_dummy"
  delete process.env["IBX_STRIPE_ALLOWED_KINDS"]
})

afterEach(() => {
  __setStripeClientForTests(null)
  vi.clearAllMocks()
})

// ── STRIPE_INTENT_KINDS sanity ──────────────────────────────────────────

describe("STRIPE_INTENT_KINDS", () => {
  it("exposes the 7 mapped kinds plus stripe.unknown", () => {
    expect(STRIPE_INTENT_KINDS).toHaveLength(8)
    expect(new Set(STRIPE_INTENT_KINDS).size).toBe(8)
    expect(STRIPE_INTENT_KINDS).toContain("stripe.unknown")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.payment_intent.create")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.payment_intent.confirm")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.payment_intent.update")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.payment_intent.cancel")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.refund.create")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.customer.create")
    expect(STRIPE_INTENT_KINDS).toContain("stripe.checkout_session.create")
  })
})

// ── Per-kind happy path: envelope construction + SDK dispatch ────────────

describe("stripeAdjudicated.paymentIntents.create — EXECUTE", () => {
  it("builds a SYSTEM envelope with kind=stripe.payment_intent.create, dispatches SDK, emits audit", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    const result = await stripeAdjudicated.paymentIntents.create(
      {
        amount: 8900,
        currency: "brl",
        payment_method_types: ["pix"],
        metadata: { orderId: "order_01" },
      },
      { sourceSubject: "test:pi.create", auditSink: sink },
    )

    expect(result).toEqual({ id: "pi_new", object: "payment_intent" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("paymentIntents.create")
    // Stripe SDK call signature: (params, options?).
    const params = calls[0]!.args[0] as { amount: number; currency: string }
    expect(params.amount).toBe(8900)
    expect(params.currency).toBe("brl")

    // Audit record emitted with the right envelope shape.
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.payment_intent.create")
    expect(records[0]!.envelope.actor.principal).toBe("system")
    expect(records[0]!.envelope.taint).toBe("SYSTEM")
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })
})

describe("stripeAdjudicated.paymentIntents.confirm — EXECUTE", () => {
  it("dispatches confirm with (id, params, options) and emits the confirm kind", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.paymentIntents.confirm(
      "pi_test123",
      {
        payment_method_data: { type: "pix" } as never,
      },
      { sourceSubject: "test:pi.confirm", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("paymentIntents.confirm")
    expect(calls[0]!.args[0]).toBe("pi_test123")

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.payment_intent.confirm")
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })
})

describe("stripeAdjudicated.paymentIntents.update — EXECUTE", () => {
  it("dispatches update and emits the update kind", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.paymentIntents.update(
      "pi_test123",
      { metadata: { cartId: "cart_01" } },
      { sourceSubject: "test:pi.update", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("paymentIntents.update")
    expect(calls[0]!.args[0]).toBe("pi_test123")

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.payment_intent.update")
  })
})

describe("stripeAdjudicated.paymentIntents.cancel — EXECUTE", () => {
  it("dispatches cancel with default empty params when none supplied", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.paymentIntents.cancel("pi_stale", {
      sourceSubject: "test:pi.cancel",
      auditSink: sink,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("paymentIntents.cancel")
    expect(calls[0]!.args[0]).toBe("pi_stale")

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.payment_intent.cancel")
  })
})

describe("stripeAdjudicated.refunds.create — EXECUTE", () => {
  it("dispatches refunds.create and emits the refund kind", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.refunds.create(
      { payment_intent: "pi_refund_target", amount: 1000 },
      { sourceSubject: "test:refund.create", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("refunds.create")

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.refund.create")
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })
})

describe("stripeAdjudicated.customers.create — EXECUTE", () => {
  it("dispatches customers.create and emits the customer kind", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.customers.create(
      { email: "customer@example.com" },
      { sourceSubject: "test:customer.create", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("customers.create")

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.customer.create")
  })
})

describe("stripeAdjudicated.checkout.sessions.create — EXECUTE", () => {
  it("dispatches checkout.sessions.create and emits the checkout-session kind", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [{ price: "price_01", quantity: 1 }],
      },
      { sourceSubject: "test:checkout.create", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("checkout.sessions.create")

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("stripe.checkout_session.create")
  })
})

// ── Idempotency key → envelope nonce → SDK options ───────────────────────

describe("stripeAdjudicated — idempotency key", () => {
  it("sets envelope.nonce to the supplied idempotencyKey", async () => {
    const { fake } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
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

  it("forwards idempotencyKey to the Stripe SDK as options.idempotencyKey", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      {
        sourceSubject: "test:idem-fwd",
        idempotencyKey: "key-pass-through",
      },
    )

    expect(calls).toHaveLength(1)
    // Stripe SDK signature: (params, options?). options.idempotencyKey
    // becomes the Stripe-Idempotency-Key header.
    const opts = calls[0]!.args[1] as { idempotencyKey: string }
    expect(opts.idempotencyKey).toBe("key-pass-through")
  })

  it("two calls with the same idempotencyKey + payload produce identical intentHash", async () => {
    const { fake } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    const args = {
      sourceSubject: "test:replay",
      auditSink: sink,
      idempotencyKey: "stable-replay-key",
    } as const

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      args,
    )
    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      args,
    )
    await Promise.resolve()

    expect(records).toHaveLength(2)
    expect(records[0]!.envelope.intentHash).toBe(records[1]!.envelope.intentHash)
  })

  it("generates a non-empty nonce when no idempotencyKey is supplied", async () => {
    const { fake } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      { sourceSubject: "test:no-idem", auditSink: sink },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(typeof records[0]!.envelope.nonce).toBe("string")
    expect(records[0]!.envelope.nonce.length).toBeGreaterThan(0)
  })

  it("does not forward an options object when no idempotencyKey is supplied", async () => {
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      { sourceSubject: "test:no-opts" },
    )

    expect(calls).toHaveLength(1)
    // When no idempotencyKey is supplied the SDK call gets undefined as
    // the options arg (so the Stripe client falls back to its defaults).
    expect(calls[0]!.args[1]).toBeUndefined()
  })
})

// ── Allowlist via IBX_STRIPE_ALLOWED_KINDS env ───────────────────────────

describe("stripeAdjudicated — IBX_STRIPE_ALLOWED_KINDS", () => {
  it("REFUSEs when a kind is omitted from the allowlist", async () => {
    process.env["IBX_STRIPE_ALLOWED_KINDS"] = "stripe.payment_intent.confirm"
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await expect(
      stripeAdjudicated.paymentIntents.create(
        { amount: 100, currency: "brl" },
        { sourceSubject: "test:disallowed", auditSink: sink },
      ),
    ).rejects.toBeInstanceOf(StripeAdjudicateRefusedError)

    // SDK must NOT have been called.
    expect(calls).toHaveLength(0)

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("REFUSE")
  })

  it("EXECUTEs when the kind is present in the allowlist", async () => {
    process.env["IBX_STRIPE_ALLOWED_KINDS"] = "stripe.payment_intent.create,stripe.payment_intent.update"
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const { sink, records } = createMemoryAuditSink()

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      { sourceSubject: "test:allowed", auditSink: sink },
    )

    expect(calls).toHaveLength(1)
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })

  it("treats empty / whitespace IBX_STRIPE_ALLOWED_KINDS as no override (default = all allowed)", async () => {
    process.env["IBX_STRIPE_ALLOWED_KINDS"] = "   "
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      { sourceSubject: "test:empty-allowlist" },
    )

    expect(calls).toHaveLength(1)
  })

  it("ignores unknown values in the allowlist (typo-resistant)", async () => {
    process.env["IBX_STRIPE_ALLOWED_KINDS"] =
      "stripe.payment_intent.create,stripe.nonsense.kind"
    const { fake, calls } = makeFakeStripe()
    __setStripeClientForTests(fake as never)

    await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      { sourceSubject: "test:typo" },
    )
    expect(calls).toHaveLength(1)

    // The valid known-kind is still allowed; the typo is silently dropped.
    await expect(
      stripeAdjudicated.refunds.create(
        { payment_intent: "pi_x" },
        { sourceSubject: "test:typo-2" },
      ),
    ).rejects.toBeInstanceOf(StripeAdjudicateRefusedError)
  })
})

// ── Audit sink failure non-blocking ─────────────────────────────────────

describe("stripeAdjudicated — audit fail-open", () => {
  it("does not propagate audit sink errors to the caller", async () => {
    const { fake } = makeFakeStripe()
    __setStripeClientForTests(fake as never)
    const failingSink: AuditSink = {
      async emit() {
        throw new Error("nats broker down")
      },
    }
    const errorLog = vi.fn()

    const result = await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      {
        sourceSubject: "test:audit-fail",
        auditSink: failingSink,
        log: { error: errorLog },
      },
    )

    expect(result).toEqual({ id: "pi_new", object: "payment_intent" })
    // Give the fire-and-forget emit a microtask to settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLog).toHaveBeenCalled()
  })

  it("works without an audit sink", async () => {
    const { fake } = makeFakeStripe()
    __setStripeClientForTests(fake as never)

    const result = await stripeAdjudicated.paymentIntents.create(
      { amount: 100, currency: "brl" },
      { sourceSubject: "test:no-sink" },
    )
    expect(result).toEqual({ id: "pi_new", object: "payment_intent" })
  })
})

// ── REQUEST_CONFIRMATION / ESCALATE — typed error structural test ───────

describe("stripeAdjudicated — needs-review error class", () => {
  // Like medusaAdjudicated, the inline policy never emits
  // REQUEST_CONFIRMATION / ESCALATE today. The error class is still
  // tested structurally so adopters can read `prompt` / `to` / `reason`
  // off the thrown error.
  it("carries REQUEST_CONFIRMATION decision payload through the error class", () => {
    const confirmDecision = {
      kind: "REQUEST_CONFIRMATION" as const,
      prompt: "Confirm this PSP charge?",
      basis: [],
    }
    const err = new StripeAdjudicateNeedsReviewError(confirmDecision)
    expect(err.decision).toBe(confirmDecision)
    expect(err.message).toContain("Confirm this PSP charge?")
  })

  it("carries ESCALATE decision payload through the error class", () => {
    const escalateDecision = {
      kind: "ESCALATE" as const,
      to: "human" as const,
      reason: "PSP charge exceeds policy cap",
      basis: [],
    }
    const escErr = new StripeAdjudicateNeedsReviewError(escalateDecision)
    expect(escErr.decision).toBe(escalateDecision)
    expect(escErr.message).toContain("PSP charge exceeds policy cap")
  })
})

// ── REFUSE surfaces pt-BR userFacing ────────────────────────────────────

describe("stripeAdjudicated — REFUSE refusal copy", () => {
  it("attaches pt-BR userFacing copy to StripeAdjudicateRefusedError", async () => {
    process.env["IBX_STRIPE_ALLOWED_KINDS"] = "stripe.payment_intent.confirm"
    const { fake } = makeFakeStripe()
    __setStripeClientForTests(fake as never)

    let captured: StripeAdjudicateRefusedError | null = null
    try {
      await stripeAdjudicated.paymentIntents.create(
        { amount: 100, currency: "brl" },
        { sourceSubject: "test:refuse-msg" },
      )
    } catch (err) {
      captured = err as StripeAdjudicateRefusedError
    }
    expect(captured).not.toBeNull()
    expect(captured?.code).toBe("stripe.kind.not_allowed")
    expect(captured?.userFacing).toMatch(/Stripe/)
  })
})
