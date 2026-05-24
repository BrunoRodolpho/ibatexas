// Tests for medusaStoreAdjudicated — the kernel-gated STORE-scope egress wrapper.
//
// Covers the W9-foundation invariants:
//   - intent-kinds vocabulary
//   - envelope construction for line-item, complete, payment-collection ops
//   - EXECUTE proxy dispatch with idempotency header + JSON body
//   - REFUSE on unknown kind (fail-closed default)
//   - REFUSE on empty cartId / itemId / variantId / paymentCollectionId /
//     providerId / promoCodes
//   - Idempotency key → nonce → intentHash stability
//   - REWRITE payload application (kernel rewriter normalizes the payload)
//   - pt-BR refusal copy
//   - user-actor / llm-actor / system-actor branches and taint
//   - Audit fail-open (mirroring medusa-adjudicated / twilio-adjudicated)
//   - Promotion code formatting / array passthrough

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuditRecord, AuditSink } from "@adjudicate/core"
import {
  MEDUSA_STORE_INTENT_KINDS,
  MedusaStoreAdjudicateNeedsReviewError,
  MedusaStoreAdjudicateRefusedError,
  medusaStoreAdjudicated,
  medusaStoreWrapperPolicyBundle,
  __setMedusaStoreForTests,
  type MedusaStoreFetchLike,
} from "../store-adjudicated.js"

// ── Fake medusaStore transport ───────────────────────────────────────────
//
// Tests don't network. The wrapper exposes `__setMedusaStoreForTests`
// for swapping in a fake — we hand-roll one that records every (path,
// init) call so we can assert HTTP shape end-to-end.

interface FakeCall {
  readonly path: string
  readonly init: RequestInit | undefined
}

function makeFakeTransport(
  response: unknown = { ok: true },
): { fake: MedusaStoreFetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fake: MedusaStoreFetchLike = vi.fn(
    (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return Promise.resolve(response)
    },
  )
  return { fake, calls }
}

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
  vi.clearAllMocks()
})

afterEach(() => {
  __setMedusaStoreForTests(null)
  vi.clearAllMocks()
})

// ── MEDUSA_STORE_INTENT_KINDS sanity ────────────────────────────────────

describe("MEDUSA_STORE_INTENT_KINDS", () => {
  it("exposes the 9 mapped kinds plus medusa.store.unknown (10 total)", () => {
    expect(MEDUSA_STORE_INTENT_KINDS).toHaveLength(10)
    expect(new Set(MEDUSA_STORE_INTENT_KINDS).size).toBe(10)
    expect(MEDUSA_STORE_INTENT_KINDS).toContain("medusa.store.unknown")
    expect(MEDUSA_STORE_INTENT_KINDS).toContain("medusa.store.cart.create")
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.cart.line_item.add",
    )
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.cart.line_item.update",
    )
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.cart.line_item.remove",
    )
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.cart.email.update",
    )
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.cart.promotion.add",
    )
    expect(MEDUSA_STORE_INTENT_KINDS).toContain("medusa.store.cart.complete")
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.payment_collection.create",
    )
    expect(MEDUSA_STORE_INTENT_KINDS).toContain(
      "medusa.store.payment_collection.payment_session.create",
    )
  })

  it("uses the wrapper-local policy bundle with default REFUSE", () => {
    expect(medusaStoreWrapperPolicyBundle.default).toBe("REFUSE")
    expect(medusaStoreWrapperPolicyBundle.business.length).toBeGreaterThan(0)
  })
})

// ── Envelope construction — lineItems.add ───────────────────────────────

describe("medusaStoreAdjudicated.carts.lineItems.add — EXECUTE", () => {
  it("builds an envelope with kind=medusa.store.cart.line_item.add and dispatches", async () => {
    const { fake, calls } = makeFakeTransport({ cart: { id: "cart_01" } })
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    const result = await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 2 },
      { sourceSubject: "tool:add_to_cart", auditSink: sink },
    )

    expect(result).toEqual({ cart: { id: "cart_01" } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe("/store/carts/cart_01/line-items")
    expect(calls[0]!.init?.method).toBe("POST")
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>
    expect(body["variant_id"]).toBe("var_42")
    expect(body["quantity"]).toBe(2)

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("medusa.store.cart.line_item.add")
    expect(records[0]!.envelope.actor.principal).toBe("system")
    expect(records[0]!.envelope.taint).toBe("SYSTEM")
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })

  it("forwards optional metadata in the body", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.carts.lineItems.add(
      {
        cartId: "cart_01",
        variantId: "var_42",
        quantity: 1,
        metadata: { note: "extra spicy" },
      },
      { sourceSubject: "tool:add_to_cart" },
    )

    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>
    expect(body["metadata"]).toEqual({ note: "extra spicy" })
  })
})

// ── Envelope construction — carts.complete ──────────────────────────────

describe("medusaStoreAdjudicated.carts.complete — EXECUTE", () => {
  it("dispatches POST /store/carts/:id/complete with empty body when none supplied", async () => {
    const { fake, calls } = makeFakeTransport({ type: "order", order: { id: "ord_01" } })
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    const result = await medusaStoreAdjudicated.carts.complete(
      { cartId: "cart_01" },
      { sourceSubject: "tool:create_checkout", auditSink: sink },
    )

    expect(result).toEqual({ type: "order", order: { id: "ord_01" } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe("/store/carts/cart_01/complete")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({})

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.kind).toBe("medusa.store.cart.complete")
  })
})

// ── Envelope construction — paymentCollections.create ───────────────────

describe("medusaStoreAdjudicated.paymentCollections.create — EXECUTE", () => {
  it("dispatches POST /store/payment-collections with cart_id in body", async () => {
    const { fake, calls } = makeFakeTransport({
      payment_collection: { id: "pcol_01" },
    })
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    const result = await medusaStoreAdjudicated.paymentCollections.create(
      { cartId: "cart_01" },
      { sourceSubject: "tool:create_checkout", auditSink: sink },
    )

    expect(result).toEqual({ payment_collection: { id: "pcol_01" } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe("/store/payment-collections")
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>
    expect(body["cart_id"]).toBe("cart_01")

    await Promise.resolve()
    expect(records[0]!.envelope.kind).toBe(
      "medusa.store.payment_collection.create",
    )
  })
})

// ── Envelope construction — paymentSessions.create ──────────────────────

describe("medusaStoreAdjudicated.paymentCollections.paymentSessions.create — EXECUTE", () => {
  it("dispatches POST /store/payment-collections/:id/payment-sessions with provider_id", async () => {
    const { fake, calls } = makeFakeTransport({
      payment_session: { id: "psess_01" },
    })
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.paymentCollections.paymentSessions.create(
      { paymentCollectionId: "pcol_01", providerId: "pp_stripe_stripe" },
      { sourceSubject: "tool:create_checkout" },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe(
      "/store/payment-collections/pcol_01/payment-sessions",
    )
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>
    expect(body["provider_id"]).toBe("pp_stripe_stripe")
  })
})

// ── line_item.update / line_item.remove / promotion.add / cart.create ───

describe("medusaStoreAdjudicated — additional EXECUTE paths", () => {
  it("dispatches lineItems.update with snake-case body", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.carts.lineItems.update(
      { cartId: "cart_01", itemId: "li_42", quantity: 3 },
      { sourceSubject: "tool:update_cart" },
    )

    expect(calls[0]!.path).toBe("/store/carts/cart_01/line-items/li_42")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ quantity: 3 })
  })

  it("dispatches lineItems.remove as DELETE with no body", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.carts.lineItems.remove(
      { cartId: "cart_01", itemId: "li_42" },
      { sourceSubject: "tool:remove_from_cart" },
    )

    expect(calls[0]!.path).toBe("/store/carts/cart_01/line-items/li_42")
    expect(calls[0]!.init?.method).toBe("DELETE")
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it("dispatches promotions.add with snake-case promo_codes array", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.carts.promotions.add(
      { cartId: "cart_01", promoCodes: ["WELCOME10", "FRETE_FREE"] },
      { sourceSubject: "tool:apply_coupon" },
    )

    expect(calls[0]!.path).toBe("/store/carts/cart_01/promotions")
    const body = JSON.parse(calls[0]!.init!.body as string) as {
      promo_codes: string[]
    }
    expect(body.promo_codes).toEqual(["WELCOME10", "FRETE_FREE"])
  })

  it("dispatches carts.create with bare body", async () => {
    const { fake, calls } = makeFakeTransport({ cart: { id: "cart_new" } })
    __setMedusaStoreForTests(fake)

    const result = await medusaStoreAdjudicated.carts.create(
      { body: { region_id: "reg_01" } },
      { sourceSubject: "tool:get_or_create_cart" },
    )

    expect(result).toEqual({ cart: { id: "cart_new" } })
    expect(calls[0]!.path).toBe("/store/carts")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      region_id: "reg_01",
    })
  })

  it("dispatches carts.update (email/metadata) with passthrough body", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.carts.update(
      { cartId: "cart_01", body: { email: "customer@example.com" } },
      { sourceSubject: "tool:create_checkout" },
    )

    expect(calls[0]!.path).toBe("/store/carts/cart_01")
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      email: "customer@example.com",
    })
  })
})

// ── Idempotency key → nonce → intentHash ────────────────────────────────

describe("medusaStoreAdjudicated — idempotency key", () => {
  it("sets envelope.nonce to the supplied idempotencyKey", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      {
        sourceSubject: "tool:add_to_cart",
        auditSink: sink,
        idempotencyKey: "key-from-caller",
      },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.envelope.nonce).toBe("key-from-caller")
    // The Idempotency-Key header is forwarded to the transport.
    const headers = (calls[0]!.init!.headers as Record<string, string>) ?? {}
    expect(headers["Idempotency-Key"]).toBe("key-from-caller")
  })

  it("two calls with identical idempotencyKey + payload produce identical intentHash", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    const args = {
      cartId: "cart_01",
      variantId: "var_42",
      quantity: 1,
    } as const
    const meta = {
      sourceSubject: "tool:add_to_cart",
      auditSink: sink,
      idempotencyKey: "stable-replay-key",
    } as const

    await medusaStoreAdjudicated.carts.lineItems.add(args, meta)
    await medusaStoreAdjudicated.carts.lineItems.add(args, meta)
    await Promise.resolve()

    expect(records).toHaveLength(2)
    expect(records[0]!.envelope.intentHash).toBe(
      records[1]!.envelope.intentHash,
    )
  })

  it("generates a non-empty nonce when no idempotencyKey is supplied", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      { sourceSubject: "tool:add_to_cart", auditSink: sink },
    )

    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(typeof records[0]!.envelope.nonce).toBe("string")
    expect(records[0]!.envelope.nonce.length).toBeGreaterThan(0)
  })
})

// ── REFUSE on empty ids / invalid quantities ────────────────────────────

describe("medusaStoreAdjudicated — REFUSE on invalid payload", () => {
  it("REFUSEs lineItems.add when cartId is empty", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await expect(
      medusaStoreAdjudicated.carts.lineItems.add(
        { cartId: "", variantId: "var_42", quantity: 1 },
        { sourceSubject: "tool:add_to_cart", auditSink: sink },
      ),
    ).rejects.toBeInstanceOf(MedusaStoreAdjudicateRefusedError)

    expect(calls).toHaveLength(0)
    await Promise.resolve()
    expect(records).toHaveLength(1)
    expect(records[0]!.decision.kind).toBe("REFUSE")
  })

  it("REFUSEs lineItems.add when variantId is empty", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    let captured: MedusaStoreAdjudicateRefusedError | null = null
    try {
      await medusaStoreAdjudicated.carts.lineItems.add(
        { cartId: "cart_01", variantId: "   ", quantity: 1 },
        { sourceSubject: "tool:add_to_cart" },
      )
    } catch (err) {
      captured = err as MedusaStoreAdjudicateRefusedError
    }

    expect(captured).not.toBeNull()
    expect(captured?.code).toBe("medusa.store.payload.empty_variant_id")
    expect(calls).toHaveLength(0)
  })

  it("REFUSEs lineItems.update when itemId is empty", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await expect(
      medusaStoreAdjudicated.carts.lineItems.update(
        { cartId: "cart_01", itemId: "", quantity: 1 },
        { sourceSubject: "tool:update_cart" },
      ),
    ).rejects.toMatchObject({ code: "medusa.store.payload.empty_item_id" })

    expect(calls).toHaveLength(0)
  })

  it("REFUSEs lineItems.remove when itemId is empty", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await expect(
      medusaStoreAdjudicated.carts.lineItems.remove(
        { cartId: "cart_01", itemId: "" },
        { sourceSubject: "tool:remove_from_cart" },
      ),
    ).rejects.toMatchObject({ code: "medusa.store.payload.empty_item_id" })

    expect(calls).toHaveLength(0)
  })

  it("REFUSEs lineItems.add when quantity is < 1", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await expect(
      medusaStoreAdjudicated.carts.lineItems.add(
        { cartId: "cart_01", variantId: "var_42", quantity: 0 },
        { sourceSubject: "tool:add_to_cart" },
      ),
    ).rejects.toMatchObject({ code: "medusa.store.payload.invalid_quantity" })

    expect(calls).toHaveLength(0)
  })

  it("REFUSEs paymentSessions.create when paymentCollectionId is empty", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await expect(
      medusaStoreAdjudicated.paymentCollections.paymentSessions.create(
        { paymentCollectionId: "", providerId: "pp_stripe_stripe" },
        { sourceSubject: "tool:create_checkout" },
      ),
    ).rejects.toMatchObject({
      code: "medusa.store.payload.empty_payment_collection_id",
    })

    expect(calls).toHaveLength(0)
  })

  it("REFUSEs promotions.add when promoCodes contains an empty string", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await expect(
      medusaStoreAdjudicated.carts.promotions.add(
        { cartId: "cart_01", promoCodes: [""] },
        { sourceSubject: "tool:apply_coupon" },
      ),
    ).rejects.toMatchObject({
      code: "medusa.store.payload.empty_promo_codes",
    })

    expect(calls).toHaveLength(0)
  })
})

// ── REFUSE pt-BR userFacing copy ────────────────────────────────────────

describe("medusaStoreAdjudicated — REFUSE refusal copy", () => {
  it("attaches pt-BR userFacing copy to MedusaStoreAdjudicateRefusedError", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    let captured: MedusaStoreAdjudicateRefusedError | null = null
    try {
      await medusaStoreAdjudicated.carts.lineItems.add(
        { cartId: "", variantId: "var_42", quantity: 1 },
        { sourceSubject: "tool:add_to_cart" },
      )
    } catch (err) {
      captured = err as MedusaStoreAdjudicateRefusedError
    }

    expect(captured).not.toBeNull()
    expect(captured?.code).toBe("medusa.store.payload.empty_cart_id")
    // pt-BR refusal copy.
    expect(captured?.userFacing).toMatch(/carrinho|identificador/)
  })
})

// ── REFUSE on unknown kind (default fail-closed) ────────────────────────

describe("medusaStoreAdjudicated — REFUSE on unknown kind", () => {
  it("default-REFUSE on medusa.store.unknown via direct policy invocation", () => {
    // We can't trigger this via the public surface (every public helper
    // pins a known kind), so we exercise the policy bundle directly.
    // This is the same posture as the bundle's `default: "REFUSE"`
    // contract — any unmapped envelope must be refused.
    const business = medusaStoreWrapperPolicyBundle.business
    expect(Array.isArray(business)).toBe(true)
    expect(business.length).toBeGreaterThanOrEqual(1)

    // The first business guard refuses medusa.store.unknown.
    const firstGuard = business[0]!
    type Envelope = Parameters<typeof firstGuard>[0]
    const fakeEnvelope = {
      kind: "medusa.store.unknown",
      payload: {},
      actor: { principal: "system" as const, sessionId: "test" },
      taint: "SYSTEM" as const,
    } as unknown as Envelope
    const decision = firstGuard(
      fakeEnvelope,
      { egress: "medusa-store" } as never,
    )
    expect(decision).not.toBeNull()
    expect(decision?.kind).toBe("REFUSE")
  })
})

// ── REWRITE payload application ─────────────────────────────────────────

describe("medusaStoreAdjudicated — REWRITE forwarded to transport", () => {
  it("forwards the (possibly REWRITE-rewritten) envelope.payload to the transport", async () => {
    // The current inline policy does not REWRITE — but the wrapper MUST
    // read `env.payload` (not the input) so a future rewriter is honored.
    // We assert that by checking the transport receives the exact same
    // payload we passed in (no in-place mutation, no field drops). This
    // is the same structural test the twilio-adjudicated suite uses.
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 5 },
      { sourceSubject: "tool:add_to_cart" },
    )

    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>
    expect(body["variant_id"]).toBe("var_42")
    expect(body["quantity"]).toBe(5)
  })
})

// ── Actor principal branches (user / llm / system) ──────────────────────

describe("medusaStoreAdjudicated — actor principal branches", () => {
  it("sets envelope.actor.principal=system and taint=SYSTEM by default", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      { sourceSubject: "tool:add_to_cart", auditSink: sink },
    )

    await Promise.resolve()
    expect(records[0]!.envelope.actor.principal).toBe("system")
    expect(records[0]!.envelope.taint).toBe("SYSTEM")
  })

  it("sets envelope.actor.principal=llm and taint=UNTRUSTED when actorPrincipal=llm", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      {
        sourceSubject: "tool:add_to_cart",
        actorPrincipal: "llm",
        auditSink: sink,
      },
    )

    await Promise.resolve()
    expect(records[0]!.envelope.actor.principal).toBe("llm")
    expect(records[0]!.envelope.taint).toBe("UNTRUSTED")
    // EXECUTE despite UNTRUSTED — the wrapper's taint policy allows
    // UNTRUSTED for all known cart-store kinds (customer-initiated).
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })

  it("sets envelope.actor.principal=user and taint=UNTRUSTED when actorPrincipal=user", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      {
        sourceSubject: "tool:add_to_cart",
        actorPrincipal: "user",
        auditSink: sink,
      },
    )

    await Promise.resolve()
    expect(records[0]!.envelope.actor.principal).toBe("user")
    expect(records[0]!.envelope.taint).toBe("UNTRUSTED")
    expect(records[0]!.decision.kind).toBe("EXECUTE")
  })

  it("appends customerId / sessionId / reason to actor.sessionId for audit grep", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const { sink, records } = createMemoryAuditSink()

    await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      {
        sourceSubject: "tool:add_to_cart",
        actorPrincipal: "llm",
        customerId: "cust_99",
        sessionId: "wa_session_42",
        reason: "menu-recommendation",
        auditSink: sink,
      },
    )

    await Promise.resolve()
    expect(records[0]!.envelope.actor.sessionId).toBe(
      "tool:add_to_cart:medusa.store.cart.line_item.add:menu-recommendation:cust=cust_99:sess=wa_session_42",
    )
  })
})

// ── Audit fail-open ─────────────────────────────────────────────────────

describe("medusaStoreAdjudicated — audit fail-open", () => {
  it("does not propagate audit sink errors to the caller", async () => {
    const { fake } = makeFakeTransport()
    __setMedusaStoreForTests(fake)
    const failingSink: AuditSink = {
      async emit() {
        throw new Error("nats broker down")
      },
    }
    const errorLog = vi.fn()

    const result = await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      {
        sourceSubject: "tool:add_to_cart",
        auditSink: failingSink,
        log: { error: errorLog },
      },
    )

    expect(result).toEqual({ ok: true })
    // Allow the fire-and-forget emit a microtask to settle.
    await new Promise((r) => setTimeout(r, 0))
    expect(errorLog).toHaveBeenCalled()
  })

  it("works without an audit sink", async () => {
    const { fake, calls } = makeFakeTransport()
    __setMedusaStoreForTests(fake)

    const result = await medusaStoreAdjudicated.carts.lineItems.add(
      { cartId: "cart_01", variantId: "var_42", quantity: 1 },
      { sourceSubject: "tool:add_to_cart" },
    )
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
  })
})

// ── REQUEST_CONFIRMATION / ESCALATE — typed error structural test ──────

describe("medusaStoreAdjudicated — needs-review error class", () => {
  // The inline policy never emits REQUEST_CONFIRMATION / ESCALATE today.
  // The error class is tested structurally so adopters can read
  // `prompt` / `to` / `reason` off the thrown error.
  it("carries REQUEST_CONFIRMATION decision payload through the error class", () => {
    const confirmDecision = {
      kind: "REQUEST_CONFIRMATION" as const,
      prompt: "Confirm cart checkout?",
      basis: [],
    }
    const err = new MedusaStoreAdjudicateNeedsReviewError(confirmDecision)
    expect(err.decision).toBe(confirmDecision)
    expect(err.message).toContain("Confirm cart checkout?")
  })

  it("carries ESCALATE decision payload through the error class", () => {
    const escalateDecision = {
      kind: "ESCALATE" as const,
      to: "human" as const,
      reason: "Cart total exceeds threshold",
      basis: [],
    }
    const escErr = new MedusaStoreAdjudicateNeedsReviewError(escalateDecision)
    expect(escErr.decision).toBe(escalateDecision)
    expect(escErr.message).toContain("Cart total exceeds threshold")
  })
})
