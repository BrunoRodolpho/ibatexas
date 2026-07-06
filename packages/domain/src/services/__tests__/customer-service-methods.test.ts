// customer.service.ts — coverage for the un-exercised service surface.
//
// The existing suites cover `updatePreferencesFromEnvelope`,
// `submitReviewFromEnvelope`, and the heavy `anonymizeCustomer` machinery.
// This file tops up the remaining (previously ~74%-covered) branches:
//
//   - upsertFromPhone / upsertFromWhatsApp  — E.164 canonicalization + upsert shape
//   - getById / getProfileData / recordOrderItems
//   - findDormantCustomers / getOrderedTogether (empty + grouped)
//   - updatePreferences / submitReview / updatePixDetails (deprecated executors)
//   - createFromEnvelope                    — wa-auto vs OTP source branches (EXECUTE)
//   - updatePixDetailsFromEnvelope          — EXECUTE + CPF-invalid REFUSE
//   - anonymizeCustomerFromEnvelope         — 24h-grace DEFER + immediate-erasure EXECUTE
//   - exportCustomerData                    — LGPD portability aggregate
//
// Mock-based only — no DB / network. We assert the REAL behaviour derived
// from the source: the Prisma call shapes, the kernel decision branches,
// and the side-effect payloads.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { Channel } from "@ibatexas/types"
import type {
  CustomerCreatePayload,
  CustomerPixDetailsSavePayload,
  CustomerAnonymizePayload,
  CustomerOnboardingState,
} from "@ibatexas/pack-customer-onboarding"

// ── Hoisted Prisma + NATS mocks ─────────────────────────────────────────────

const h = vi.hoisted(() => {
  const make = () => vi.fn()
  return {
    customer: {
      upsert: make(),
      update: make(),
      findUniqueOrThrow: make(),
      findUnique: make(),
    },
    customerPreferences: { upsert: make(), findUnique: make(), deleteMany: make() },
    customerOrderItem: {
      createMany: make(),
      findMany: make(),
      groupBy: make(),
      updateMany: make(),
    },
    review: {
      upsert: make(),
      aggregate: make(),
      count: make(),
      findMany: make(),
      updateMany: make(),
    },
    address: { findMany: make(), deleteMany: make() },
    orderProjection: { findMany: make(), updateMany: make() },
    conversation: { findMany: make(), updateMany: make() },
    conversationMessage: { count: make(), findMany: make(), updateMany: make() },
    orderStatusHistory: { updateMany: make() },
    orderEventLog: { count: make(), findMany: make(), updateMany: make() },
    loyaltyAccount: { updateMany: make() },
    reservation: { updateMany: make() },
    $queryRaw: make(),
    $transaction: make(),
    $executeRaw: make(),
    publishNatsEvent: make(),
  }
})

vi.mock("../../client.js", () => ({
  prisma: {
    customer: h.customer,
    customerPreferences: h.customerPreferences,
    customerOrderItem: h.customerOrderItem,
    review: h.review,
    address: h.address,
    orderProjection: h.orderProjection,
    conversation: h.conversation,
    conversationMessage: h.conversationMessage,
    orderStatusHistory: h.orderStatusHistory,
    orderEventLog: h.orderEventLog,
    loyaltyAccount: h.loyaltyAccount,
    reservation: h.reservation,
    $queryRaw: h.$queryRaw,
    $transaction: h.$transaction,
    $executeRaw: h.$executeRaw,
  },
}))

vi.mock("@ibatexas/nats-client", () => ({
  publishNatsEvent: h.publishNatsEvent,
}))

// ── Import under test (after mocks) ─────────────────────────────────────────

import {
  createCustomerService,
  exportCustomerData,
  anonymizeCustomerFromEnvelope,
} from "../customer.service.js"

const ANONYMIZE_GRACE_SIGNAL = "customer.anonymize.confirmed_after_grace"

// ── Fixtures ────────────────────────────────────────────────────────────────

function onboardingState(
  overrides: Partial<CustomerOnboardingState["ctx"]> = {},
): CustomerOnboardingState {
  return {
    ctx: {
      actor: { principal: "user", id: "cus_01" },
      customerId: "cus_01",
      customerExists: true,
      isAuthenticated: true,
      otpFresh: true,
      hasParkedAnonymize: false,
      now: new Date("2026-06-28T12:00:00.000Z"),
      ...overrides,
    },
  }
}

function createEnvelope(payload: CustomerCreatePayload) {
  return buildEnvelope<"customer.create", CustomerCreatePayload>({
    kind: "customer.create",
    payload,
    nonce: "n-create",
    // customer.create is SYSTEM-only (createSystemTaintPolicy, systemMinimum SYSTEM).
    actor: { principal: "system", sessionId: "sys-1" },
    taint: "SYSTEM",
  })
}

function pixEnvelope(payload: CustomerPixDetailsSavePayload) {
  return buildEnvelope<"customer.pix.details.save", CustomerPixDetailsSavePayload>({
    kind: "customer.pix.details.save",
    payload,
    nonce: "n-pix",
    actor: { principal: "user", sessionId: "s-1" },
    taint: "UNTRUSTED",
  })
}

function anonymizeEnvelope() {
  return buildEnvelope<"customer.anonymize", CustomerAnonymizePayload>({
    kind: "customer.anonymize",
    payload: { customerId: "cus_01", otpToken: "otp-1", scope: "lgpd_art_18" },
    nonce: "n-anon",
    actor: { principal: "user", sessionId: "s-1" },
    taint: "UNTRUSTED",
  })
}

// ── Shared defaults (anonymize EXECUTE needs the full surface mocked) ───────

beforeEach(() => {
  vi.clearAllMocks()

  // Anonymize pre-tx reads + light-path defaults.
  h.customer.findUnique.mockResolvedValue({ medusaId: null })
  h.customer.update.mockResolvedValue({ id: "cus_01" })
  h.review.count.mockResolvedValue(0)
  h.review.findMany.mockResolvedValue([])
  h.conversation.findMany.mockResolvedValue([])
  h.conversationMessage.count.mockResolvedValue(0)
  h.orderProjection.findMany.mockResolvedValue([])
  h.orderEventLog.count.mockResolvedValue(0)
  h.$executeRaw.mockResolvedValue(0)
  h.publishNatsEvent.mockResolvedValue(undefined)

  // In-tx surfaces (light path — counts not read).
  h.address.deleteMany.mockResolvedValue({ count: 1 })
  h.customerPreferences.deleteMany.mockResolvedValue({ count: 1 })
  h.review.updateMany.mockResolvedValue({ count: 1 })
  h.customerOrderItem.updateMany.mockResolvedValue({ count: 1 })
  h.orderProjection.updateMany.mockResolvedValue({ count: 0 })
  h.conversationMessage.updateMany.mockResolvedValue({ count: 0 })
  h.conversation.updateMany.mockResolvedValue({ count: 0 })
  h.orderStatusHistory.updateMany.mockResolvedValue({ count: 0 })
  h.orderEventLog.updateMany.mockResolvedValue({ count: 0 })
  h.loyaltyAccount.updateMany.mockResolvedValue({ count: 0 })
  h.reservation.updateMany.mockResolvedValue({ count: 0 })

  // $transaction runs the closure inline against a tx client (mirrors prod).
  h.$transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: h.customer,
        address: h.address,
        customerPreferences: h.customerPreferences,
        review: h.review,
        customerOrderItem: h.customerOrderItem,
        orderProjection: h.orderProjection,
        conversationMessage: h.conversationMessage,
        conversation: h.conversation,
        orderStatusHistory: h.orderStatusHistory,
        orderEventLog: h.orderEventLog,
        loyaltyAccount: h.loyaltyAccount,
        reservation: h.reservation,
      }),
  )
})

// ── upsertFromPhone ─────────────────────────────────────────────────────────

describe("upsertFromPhone", () => {
  it("upserts on the canonical phone, setting name on create AND update when supplied", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_01", phone: "+5511999999999", name: "João" })
    const svc = createCustomerService()

    const row = await svc.upsertFromPhone("+5511999999999", "João")

    expect(row).toEqual({ id: "cus_01", phone: "+5511999999999", name: "João" })
    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ phone: "+5511999999999" })
    expect(arg.create).toEqual({ phone: "+5511999999999", name: "João" })
    expect(arg.update).toEqual({ name: "João" })
  })

  it("creates with name=null and an EMPTY update clause when no name is supplied", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_01" })
    const svc = createCustomerService()

    await svc.upsertFromPhone("+5511999999999")

    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.create).toEqual({ phone: "+5511999999999", name: null })
    expect(arg.update).toEqual({})
  })

  it("canonicalizes a 'whatsapp:'-prefixed, human-formatted number to E.164 before the @unique lookup", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_01" })
    const svc = createCustomerService()

    await svc.upsertFromPhone("whatsapp:+55 (11) 99999-9999")

    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.where.phone).toBe("+5511999999999")
  })
})

// ── upsertFromWhatsApp ──────────────────────────────────────────────────────

describe("upsertFromWhatsApp", () => {
  it("strips the whatsapp: prefix, stamps source + firstContactAt on create, and selects only id", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_01" })
    const svc = createCustomerService()

    const row = await svc.upsertFromWhatsApp("whatsapp:+5511988887777")

    expect(row).toEqual({ id: "cus_01" })
    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ phone: "+5511988887777" })
    expect(arg.create.source).toBe("whatsapp")
    expect(arg.create.phone).toBe("+5511988887777")
    expect(arg.create.firstContactAt).toBeInstanceOf(Date)
    expect(arg.update).toEqual({})
    expect(arg.select).toEqual({ id: true })
  })
})

// ── getById ─────────────────────────────────────────────────────────────────

describe("getById", () => {
  it("fetches the customer by id via findUniqueOrThrow", async () => {
    h.customer.findUniqueOrThrow.mockResolvedValue({ id: "cus_01", name: "Ana" })
    const svc = createCustomerService()

    const row = await svc.getById("cus_01")

    expect(row).toEqual({ id: "cus_01", name: "Ana" })
    expect(h.customer.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "cus_01" } })
  })
})

// ── getProfileData ──────────────────────────────────────────────────────────

describe("getProfileData", () => {
  it("loads preferences + the 200 most-recent order items in parallel", async () => {
    h.customerPreferences.findUnique.mockResolvedValue({
      customerId: "cus_01",
      allergenExclusions: ["lactose"],
    })
    h.customerOrderItem.findMany.mockResolvedValue([{ id: "oi_1" }])
    const svc = createCustomerService()

    const out = await svc.getProfileData("cus_01")

    expect(out.customerPrefs).toEqual({ customerId: "cus_01", allergenExclusions: ["lactose"] })
    expect(out.orderItems).toEqual([{ id: "oi_1" }])
    const fmArg = h.customerOrderItem.findMany.mock.calls[0]![0]
    expect(fmArg.where).toEqual({ customerId: "cus_01" })
    expect(fmArg.orderBy).toEqual({ orderedAt: "desc" })
    expect(fmArg.take).toBe(200)
  })
})

// ── recordOrderItems ────────────────────────────────────────────────────────

describe("recordOrderItems", () => {
  it("bulk-inserts each item with customerId + medusaOrderId + an orderedAt timestamp (no skipDuplicates)", async () => {
    h.customerOrderItem.createMany.mockResolvedValue({ count: 1 })
    const svc = createCustomerService()

    await svc.recordOrderItems("cus_01", "order_9", [
      { productId: "p1", variantId: "v1", quantity: 2, priceInCentavos: 8900 },
    ])

    const arg = h.customerOrderItem.createMany.mock.calls[0]![0]
    expect(arg.skipDuplicates).toBe(false)
    expect(arg.data).toHaveLength(1)
    expect(arg.data[0]).toMatchObject({
      customerId: "cus_01",
      productId: "p1",
      variantId: "v1",
      quantity: 2,
      priceInCentavos: 8900,
      medusaOrderId: "order_9",
    })
    expect(arg.data[0].orderedAt).toBeInstanceOf(Date)
  })
})

// ── findDormantCustomers ────────────────────────────────────────────────────

describe("findDormantCustomers", () => {
  it("returns the raw-query rows for dormant customers", async () => {
    const rows = [{ id: "cus_01", phone: "+5511999999999", name: "Ana" }]
    h.$queryRaw.mockResolvedValue(rows)
    const svc = createCustomerService()

    const out = await svc.findDormantCustomers(30, 50)

    expect(out).toBe(rows)
    expect(h.$queryRaw).toHaveBeenCalledOnce()
  })
})

// ── getOrderedTogether ──────────────────────────────────────────────────────

describe("getOrderedTogether", () => {
  it("short-circuits to [] (no groupBy) when the customer never ordered the anchor product", async () => {
    h.customerOrderItem.findMany.mockResolvedValue([])
    const svc = createCustomerService()

    const out = await svc.getOrderedTogether("cus_01", "p_anchor")

    expect(out).toEqual([])
    expect(h.customerOrderItem.groupBy).not.toHaveBeenCalled()
  })

  it("groups co-purchased products from the matching orders, excluding the anchor product", async () => {
    h.customerOrderItem.findMany.mockResolvedValue([
      { medusaOrderId: "o1" },
      { medusaOrderId: "o2" },
    ])
    h.customerOrderItem.groupBy.mockResolvedValue([{ productId: "p2", _count: { productId: 3 } }])
    const svc = createCustomerService()

    const out = await svc.getOrderedTogether("cus_01", "p_anchor", 5)

    expect(out).toEqual([{ productId: "p2", _count: { productId: 3 } }])
    const gbArg = h.customerOrderItem.groupBy.mock.calls[0]![0]
    expect(gbArg.where).toEqual({
      customerId: "cus_01",
      medusaOrderId: { in: ["o1", "o2"] },
      productId: { not: "p_anchor" },
    })
    expect(gbArg.take).toBe(5)
  })
})

// ── updatePreferences (deprecated executor) ─────────────────────────────────

describe("updatePreferences (bare-arg executor)", () => {
  it("defaults every list to [] and emits an EMPTY update clause when the input omits all fields", async () => {
    // Real Prisma upsert resolves the stored row; the return value is the
    // AUTHORITATIVE row (a partial update must not report coerced-empty
    // arrays for fields the DB preserved — callers cache the return).
    h.customerPreferences.upsert.mockResolvedValue({
      customerId: "cus_01",
      allergenExclusions: [],
      dietaryRestrictions: [],
      favoriteCategories: [],
    })
    const svc = createCustomerService()

    const out = await svc.updatePreferences("cus_01", {})

    expect(out).toEqual({
      allergenExclusions: [],
      dietaryRestrictions: [],
      favoriteCategories: [],
    })
    const arg = h.customerPreferences.upsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ customerId: "cus_01" })
    expect(arg.create).toEqual({
      customerId: "cus_01",
      allergenExclusions: [],
      dietaryRestrictions: [],
      favoriteCategories: [],
    })
    expect(arg.update).toEqual({})
  })

  it("includes each provided list in the update clause", async () => {
    h.customerPreferences.upsert.mockResolvedValue({})
    const svc = createCustomerService()

    await svc.updatePreferences("cus_01", {
      allergenExclusions: ["amendoim"],
      dietaryRestrictions: ["vegano"],
      favoriteCategories: ["churrasco"],
    })

    const arg = h.customerPreferences.upsert.mock.calls[0]![0]
    expect(arg.update).toEqual({
      allergenExclusions: ["amendoim"],
      dietaryRestrictions: ["vegano"],
      favoriteCategories: ["churrasco"],
    })
  })
})

// ── submitReview (deprecated executor) ──────────────────────────────────────

describe("submitReview (bare-arg executor)", () => {
  it("upserts the review with comment=null when omitted and falls back to the given rating when no aggregate exists", async () => {
    h.review.upsert.mockResolvedValue({})
    h.review.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { rating: 0 } })
    const svc = createCustomerService()

    const out = await svc.submitReview({
      customerId: "cus_01",
      productId: "p1",
      orderId: "o1",
      rating: 4,
      channel: Channel.WhatsApp,
    })

    // _avg.rating is null (first review) → service falls back to the input rating.
    expect(out).toEqual({ avgRating: 4, reviewCount: 0 })
    const arg = h.review.upsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ orderId_customerId: { orderId: "o1", customerId: "cus_01" } })
    expect(arg.create.comment).toBe(null)
    expect(arg.create.productIds).toEqual(["p1"])
    expect(arg.create.rating).toBe(4)
  })

  it("returns the computed aggregate when reviews exist", async () => {
    h.review.upsert.mockResolvedValue({})
    h.review.aggregate.mockResolvedValue({ _avg: { rating: 4.5 }, _count: { rating: 8 } })
    const svc = createCustomerService()

    const out = await svc.submitReview({
      customerId: "cus_01",
      productId: "p1",
      orderId: "o1",
      rating: 5,
      comment: "Muito bom!",
      channel: Channel.WhatsApp,
    })

    expect(out).toEqual({ avgRating: 4.5, reviewCount: 8 })
    expect(h.review.upsert.mock.calls[0]![0].create.comment).toBe("Muito bom!")
  })
})

// ── updatePixDetails (deprecated executor) ──────────────────────────────────

describe("updatePixDetails (bare-arg executor)", () => {
  it("updates only the truthy fields supplied", async () => {
    h.customer.update.mockResolvedValue({})
    const svc = createCustomerService()

    await svc.updatePixDetails("cus_01", {
      name: "Ana",
      email: "ana@example.com",
      cpf: "11144477735",
    })

    const arg = h.customer.update.mock.calls[0]![0]
    expect(arg.where).toEqual({ id: "cus_01" })
    expect(arg.data).toEqual({ name: "Ana", email: "ana@example.com", cpf: "11144477735" })
  })

  it("emits an EMPTY data clause when nothing is supplied", async () => {
    h.customer.update.mockResolvedValue({})
    const svc = createCustomerService()

    await svc.updatePixDetails("cus_01", {})

    expect(h.customer.update.mock.calls[0]![0].data).toEqual({})
  })
})

// ── createFromEnvelope ──────────────────────────────────────────────────────

describe("createFromEnvelope", () => {
  it("wa-auto source: EXECUTEs the WhatsApp first-contact upsert (source=whatsapp, firstContactAt set)", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_new" })
    const svc = createCustomerService()

    const out = await svc.createFromEnvelope(
      createEnvelope({ phoneHash: "hash-1", source: "wa-auto" }),
      onboardingState(),
      { phone: "+5511999999999" },
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toEqual({ id: "cus_new" })
    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.where).toEqual({ phone: "+5511999999999" })
    expect(arg.create.source).toBe("whatsapp")
    expect(arg.create.firstContactAt).toBeInstanceOf(Date)
    expect(arg.select).toEqual({ id: true })
  })

  it("otp source with name: EXECUTEs the OTP upsert carrying the name on create AND update", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_new" })
    const svc = createCustomerService()

    const out = await svc.createFromEnvelope(
      createEnvelope({ phoneHash: "hash-1", source: "otp" }),
      onboardingState(),
      { phone: "+5511999999999", name: "João" },
    )

    expect(out.decision.kind).toBe("EXECUTE")
    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.create).toEqual({ phone: "+5511999999999", name: "João" })
    expect(arg.update).toEqual({ name: "João" })
    expect(arg.select).toEqual({ id: true })
  })

  it("otp source without name: creates name=null and an EMPTY update clause", async () => {
    h.customer.upsert.mockResolvedValue({ id: "cus_new" })
    const svc = createCustomerService()

    await svc.createFromEnvelope(
      createEnvelope({ phoneHash: "hash-1", source: "otp" }),
      onboardingState(),
      { phone: "+5511999999999" },
    )

    const arg = h.customer.upsert.mock.calls[0]![0]
    expect(arg.create.name).toBe(null)
    expect(arg.update).toEqual({})
  })
})

// ── updatePixDetailsFromEnvelope ────────────────────────────────────────────

describe("updatePixDetailsFromEnvelope", () => {
  it("EXECUTE: persists name + email (cpf absent) for an authenticated, existing customer", async () => {
    h.customer.update.mockResolvedValue({})
    const svc = createCustomerService()

    const out = await svc.updatePixDetailsFromEnvelope(
      pixEnvelope({ name: "Maria Souza", email: "maria@example.com" }),
      onboardingState(),
      { customerId: "cus_01" },
    )

    expect(out.decision.kind).toBe("EXECUTE")
    const arg = h.customer.update.mock.calls[0]![0]
    expect(arg.where).toEqual({ id: "cus_01" })
    expect(arg.data).toEqual({ name: "Maria Souza", email: "maria@example.com" })
  })

  it("REFUSE: an invalid-checksum CPF is rejected and Prisma is never touched", async () => {
    const svc = createCustomerService()

    const out = await svc.updatePixDetailsFromEnvelope(
      pixEnvelope({ name: "Maria", email: "m@x.com", cpf: "12345678901" }),
      onboardingState(),
      { customerId: "cus_01" },
    )

    expect(out.decision.kind).toBe("REFUSE")
    if (out.decision.kind === "REFUSE") {
      expect(out.decision.refusal.code).toBe("customer.cpf.invalid_format")
    }
    expect(h.customer.update).not.toHaveBeenCalled()
  })
})

// ── anonymizeCustomerFromEnvelope ───────────────────────────────────────────

describe("anonymizeCustomerFromEnvelope", () => {
  it("DEFERs on the 24h grace signal and runs NO destructive work in the cognitive-loop flow", async () => {
    const out = await anonymizeCustomerFromEnvelope(anonymizeEnvelope(), onboardingState())

    expect(out.decision.kind).toBe("DEFER")
    if (out.decision.kind === "DEFER") {
      expect(out.decision.signal).toBe(ANONYMIZE_GRACE_SIGNAL)
    }
    // Executor never ran: no scrub transaction, no pre-tx reads.
    expect(h.$transaction).not.toHaveBeenCalled()
    expect(h.customer.findUnique).not.toHaveBeenCalled()
  })

  it("immediate-erasure: EXECUTEs the scrub now and threads the envelope as the per-surface audit predecessor", async () => {
    const auditSink = { emit: vi.fn().mockResolvedValue(undefined) }
    const envelope = anonymizeEnvelope()

    const out = await anonymizeCustomerFromEnvelope(
      envelope,
      onboardingState({ immediateErasure: true }),
      { auditSink },
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(out.result).toEqual({ success: true })

    // anonymizeCustomer actually ran the profile scrub inside the tx.
    const upd = h.customer.update.mock.calls[0]![0]
    expect(upd.where).toEqual({ id: "cus_01" })
    expect(upd.data.name).toBe("Usuário Removido")
    expect(upd.data.cpf).toBe(null)
    expect(upd.data.email).toBe(null)

    // The shared sink receives 8 records: 1 for the kernel's EXECUTE decision
    // (via withAdjudicate) + 7 per-surface scrub records (via anonymizeCustomer).
    expect(auditSink.emit).toHaveBeenCalledTimes(8)
    const records = auditSink.emit.mock.calls.map(
      (call) =>
        call[0] as {
          envelope: { kind: string }
          decision: { kind: string }
          supersedes?: {
            predecessorIntentHash: string
            predecessorAt: string
            reason: string
          }
        },
    )

    // The kernel-decision record carries the originating intent + EXECUTE verdict.
    const decisionRecord = records.find((r) => r.envelope.kind === "customer.anonymize")
    expect(decisionRecord).toBeDefined()
    expect(decisionRecord?.decision.kind).toBe("EXECUTE")

    // The 7 per-surface scrub records are each chained to THIS envelope as predecessor.
    const scrubRecords = records.filter((r) => r.envelope.kind !== "customer.anonymize")
    expect(scrubRecords).toHaveLength(7)
    for (const record of scrubRecords) {
      expect(record.supersedes?.predecessorIntentHash).toBe(envelope.intentHash)
      expect(record.supersedes?.predecessorAt).toBe(envelope.createdAt)
      expect(record.supersedes?.reason).toBe("lgpd_scrub")
    }
  })
})

// ── exportCustomerData ──────────────────────────────────────────────────────

describe("exportCustomerData", () => {
  it("aggregates customer + addresses + preferences + reviews + order history (LGPD portability)", async () => {
    h.customer.findUniqueOrThrow.mockResolvedValue({
      id: "cus_01",
      phone: "+5511999999999",
      name: "Ana",
      email: null,
      source: "otp",
      firstContactAt: null,
    })
    h.address.findMany.mockResolvedValue([{ id: "addr_1" }])
    h.customerPreferences.findUnique.mockResolvedValue({ customerId: "cus_01" })
    h.review.findMany.mockResolvedValue([{ id: "rev_1" }])
    h.customerOrderItem.findMany.mockResolvedValue([{ id: "oi_1" }])

    const out = await exportCustomerData("cus_01")

    expect(out.customer.id).toBe("cus_01")
    expect(out.addresses).toEqual([{ id: "addr_1" }])
    expect(out.preferences).toEqual({ customerId: "cus_01" })
    expect(out.reviews).toEqual([{ id: "rev_1" }])
    expect(out.orderHistory).toEqual([{ id: "oi_1" }])
    // Portability selects a NON-PII-bearing column projection on the customer row.
    const selectArg = h.customer.findUniqueOrThrow.mock.calls[0]![0]
    expect(selectArg.where).toEqual({ id: "cus_01" })
    expect(selectArg.select.phone).toBe(true)
  })
})
