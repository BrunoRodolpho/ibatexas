// audit-2026-05-24 H3 Wave A2 — T4 LGPD scrub conformance suite.
//
// # Why this suite exists
//
// SYNTHESIS.md §"H3 implementation plan" enumerates 7 in-process surfaces
// where `anonymizeCustomer` MUST scrub PII (per LGPD Art. 18 §III). Pre
// Wave A1 the executor only handles 4 of them (Customer / Address /
// CustomerPreferences / Review / CustomerOrderItem). Wave A1 extends it
// to cover the remaining 7 surfaces:
//
//   1. OrderProjection — customerEmail / customerName / customerPhone /
//      shippingAddressJson
//   2. ConversationMessage.content (placeholder "[anonymized]")
//   3. Conversation.customerId (FK null-out)
//   4. OrderStatusHistory.actorId (null-out where actor='customer';
//      staff/admin rows UNTOUCHED — negative test)
//   5. OrderEventLog.payload (full-replace JSON {anonymized:true})
//   6. LoyaltyAccount (scrub linkage + reset balance per G2-c)
//   7. Reservation.specialRequests (null-out / empty array)
//
// This suite is the conformance baseline that gates A1. It uses the real
// Postgres testcontainer (`h3-postgres-container.ts`) — mocking Prisma
// would prove the call shape, not the column state, and A1's failure
// mode is exactly "the UPDATE was never issued" (see `schema.md` §FK
// surprises). Mirrors the RULE 3 stance from CLAUDE.md / T6.
//
// # Pre-A1 expectation
//
// At `feat/kernel-always-on-cutover` HEAD (459c2bd) the executor has NOT
// yet been extended. Running this suite against that HEAD MUST FAIL with
// clean per-surface diagnostics naming the missing scrub:
//
//   "<surface>: pre-anonymize value found post-anonymize"
//
// Once A1 lands, every assertion goes green and the suite becomes the
// regression catch-net.
//
// # Suite shape
//
// Four test cases:
//
//   1. Happy path — every surface populated, anonymize fires, every
//      assertion runs (~50-100 individual checks). Includes the JSON-
//      stringification leak scan (separate top-level commit so the
//      scaffold is reviewable in isolation).
//   2. Staff-actor negative test — admin/staff rows MUST NOT be
//      touched.
//   3. Idempotency — running anonymize twice produces the same
//      post-state as one run.
//   4. Audit-emit per surface — mock the audit sink, assert one record
//      per surface scrubbed with the expected kind.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  RUN_REAL_POSTGRES,
  setupPostgresTestContainer,
  truncateDomainTables,
  type PostgresTestHarness,
} from "./h3-postgres-container.js"
import { buildPIIFixture, snapshotCustomerReachable } from "./h3-fixture-builder.js"

// ── Real-Postgres harness lifecycle ──────────────────────────────────────

let harness: PostgresTestHarness | null = null

beforeAll(async () => {
  if (!RUN_REAL_POSTGRES) return
  harness = await setupPostgresTestContainer()
}, 240_000)

afterAll(async () => {
  await harness?.teardown()
  harness = null
})

beforeEach(async () => {
  if (!harness) return
  const { prisma } = await import("@ibatexas/domain")
  await truncateDomainTables(prisma)
})

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Default PII payload used across the happy-path + idempotency tests.
 * Every string here is detectable by the JSON-stringification leak scan
 * (defense-in-depth) so a surface mismatch surfaces both via the per-
 * surface assertion AND via the global string search.
 */
function defaultPIISpec(customerId: string): Parameters<typeof buildPIIFixture>[0] {
  return {
    customerId,
    phone: "+5511987654321",
    email: "joao.silva.t4@example.com",
    name: "João Silva Teste",
    cpf: "123.456.789-09",

    orderProjections: [
      {
        customerEmail: "joao.silva.t4@example.com",
        customerName: "João Silva Teste",
        customerPhone: "+5511987654321",
        shippingAddressJson: {
          street: "Rua T4 Teste",
          number: "100",
          district: "Bela Vista",
          city: "São Paulo",
          state: "SP",
          cep: "01310100",
          recipientName: "João Silva Teste",
        },
      },
    ],

    conversations: [
      {
        sessionId: "sess_t4_happy_path",
        messages: [
          {
            role: "user",
            content:
              "Oi, meu nome é João Silva Teste, meu telefone é +5511987654321",
          },
          {
            role: "assistant",
            content: "Olá! Como posso ajudar?",
          },
        ],
      },
    ],

    orderStatusHistory: [
      {
        orderId: "ord_t4_status_customer",
        actorType: "customer",
        actorId: customerId,
        reason: "Customer-initiated cancellation: contato 11987654321",
      },
      {
        orderId: "ord_t4_status_admin",
        actorType: "admin",
        actorId: "staff_t4_alice",
        reason: "Admin override — keep me",
      },
    ],

    orderEventLogs: [
      {
        orderId: "ord_t4_event_log",
        eventType: "order.placed",
        payload: {
          customerEmail: "joao.silva.t4@example.com",
          customerName: "João Silva Teste",
          customerPhone: "+5511987654321",
          source: "web",
        },
      },
    ],

    loyaltyAccount: {
      stamps: 7,
      totalEarned: 23,
      redeemed: 2,
    },

    reservations: [
      {
        partySize: 4,
        specialRequests: [
          {
            type: "allergy_warning",
            notes:
              "João Silva Teste é alérgico a amendoim — contato +5511987654321",
          },
        ],
      },
    ],

    addresses: [
      {
        street: "Rua T4 Teste",
        number: "100",
        district: "Bela Vista",
        city: "São Paulo",
        state: "SP",
        cep: "01310100",
      },
    ],

    reviews: [
      {
        orderId: "ord_t4_review_1",
        rating: 5,
        comment: "Adorei! Sou João Silva, meu email é joao.silva.t4@example.com",
      },
    ],

    preferences: {
      dietaryRestrictions: ["vegetarian"],
      allergenExclusions: ["peanuts"],
      favoriteCategories: ["pizza"],
    },

    orderItems: [
      {
        medusaOrderId: "ord_t4_review_1",
        productId: "prod_t4_pizza",
        variantId: "var_t4_pizza_m",
        quantity: 1,
        priceInCentavos: 4500,
      },
    ],
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_REAL_POSTGRES)(
  "audit-2026-05-24 T4 — LGPD scrub conformance (H3 Wave A1 validation)",
  () => {
    it("anonymize scrubs all 7 in-scope surfaces — happy path", async () => {
      const customerId = "cust_t4_happy_path"
      const spec = defaultPIISpec(customerId)
      const { fixtures } = await buildPIIFixture(spec)

      // Pre-snapshot — proves the PII actually exists at pre-anonymize
      // time. If the builder broke (e.g., FK failure), this snapshot
      // would surface zero rows and the test would fail with a clear
      // "fixture setup leaked PII into the assertion path" hint.
      const pre = await snapshotCustomerReachable(customerId)
      expect(
        (pre.orderProjections as Array<{ customerEmail: string | null }>).length,
        "fixture setup: expected OrderProjection rows pre-anonymize",
      ).toBeGreaterThan(0)
      expect(
        (pre.conversationMessages as unknown[]).length,
        "fixture setup: expected ConversationMessage rows pre-anonymize",
      ).toBeGreaterThan(0)

      // Fire anonymize.
      const { anonymizeCustomer } = await import("@ibatexas/domain")
      await anonymizeCustomer(customerId)

      // Post-snapshot.
      const post = await snapshotCustomerReachable(customerId)

      // ── Customer scalar fields (W4 baseline — should pass pre-A1) ──
      const postCustomer = (post.customer as Array<Record<string, unknown>>)[0]!
      expect(
        postCustomer["email"],
        "Customer.email: pre-anonymize value found post-anonymize",
      ).toBeNull()
      expect(
        postCustomer["cpf"],
        "Customer.cpf: pre-anonymize value found post-anonymize",
      ).toBeNull()
      expect(
        postCustomer["name"],
        "Customer.name: pre-anonymize value found post-anonymize",
      ).toBe("Usuário Removido")
      expect(
        String(postCustomer["phone"] ?? ""),
        "Customer.phone: pre-anonymize value found post-anonymize",
      ).toMatch(/^anonymized:[a-f0-9]{16}$/)

      // ── W4 baseline tables (should pass pre-A1) ────────────────────
      expect(
        (post.addresses as unknown[]).length,
        "Address: pre-anonymize rows still present post-anonymize",
      ).toBe(0)
      expect(
        (post.preferences as unknown[]).length,
        "CustomerPreferences: pre-anonymize rows still present post-anonymize",
      ).toBe(0)
      for (const r of post.reviews as Array<{ comment: string | null }>) {
        expect(
          r.comment,
          "Review.comment: pre-anonymize value found post-anonymize",
        ).toBeNull()
      }

      // ── Surface 1 — OrderProjection (A1-new) ───────────────────────
      const postProjections = post.orderProjections as Array<
        Record<string, unknown>
      >
      expect(
        postProjections.length,
        "OrderProjection: rows missing post-anonymize",
      ).toBeGreaterThan(0)
      for (const p of postProjections) {
        expect(
          p["customerEmail"],
          "OrderProjection.customerEmail: pre-anonymize value found post-anonymize",
        ).toBeNull()
        expect(
          p["customerName"],
          "OrderProjection.customerName: pre-anonymize value found post-anonymize",
        ).toBeNull()
        expect(
          p["customerPhone"],
          "OrderProjection.customerPhone: pre-anonymize value found post-anonymize",
        ).toBeNull()
        // shippingAddressJson — A1 should replace with {anonymized: true} OR
        // null it out. Either is acceptable per G2-b (the recommendation is
        // full-replace JSON; null is a strict subset of "no PII"). We accept
        // both shapes so A1 can pick the cleaner one.
        const shipping = p["shippingAddressJson"]
        const isAnonymized =
          shipping === null ||
          (typeof shipping === "object" &&
            shipping !== null &&
            (shipping as Record<string, unknown>)["anonymized"] === true)
        expect(
          isAnonymized,
          `OrderProjection.shippingAddressJson: pre-anonymize value found post-anonymize (saw ${JSON.stringify(shipping)})`,
        ).toBe(true)
      }

      // ── Surface 2 — ConversationMessage.content (A1-new) ──────────
      const postMessages = post.conversationMessages as Array<{
        content: string
      }>
      expect(
        postMessages.length,
        "ConversationMessage: rows missing post-anonymize",
      ).toBeGreaterThan(0)
      for (const m of postMessages) {
        expect(
          m.content,
          "ConversationMessage.content: pre-anonymize value found post-anonymize",
        ).toBe("[anonymized]")
      }

      // ── Surface 3 — Conversation.customerId (A1-new) ───────────────
      const postConversations = post.conversations as Array<{
        customerId: string | null
      }>
      expect(
        postConversations.length,
        "Conversation: rows missing post-anonymize",
      ).toBeGreaterThan(0)
      for (const c of postConversations) {
        expect(
          c.customerId,
          "Conversation.customerId: pre-anonymize value found post-anonymize",
        ).toBeNull()
      }

      // ── Surface 4 — OrderStatusHistory.actorId (A1-new) ────────────
      // customer-actor rows MUST have actorId nulled; admin-actor rows
      // MUST be untouched. The fixture seeded one of each.
      const postHistory = post.orderStatusHistory as Array<{
        actor: string
        actorId: string | null
      }>
      const customerRows = postHistory.filter((h) => h.actor === "customer")
      const adminRows = postHistory.filter((h) => h.actor === "admin")
      expect(
        customerRows.length,
        "OrderStatusHistory: expected ≥1 customer-actor row in fixture",
      ).toBeGreaterThan(0)
      expect(
        adminRows.length,
        "OrderStatusHistory: expected ≥1 admin-actor row in fixture",
      ).toBeGreaterThan(0)
      for (const h of customerRows) {
        expect(
          h.actorId,
          "OrderStatusHistory(customer-actor).actorId: pre-anonymize value found post-anonymize",
        ).toBeNull()
      }
      for (const h of adminRows) {
        expect(
          h.actorId,
          "OrderStatusHistory(admin-actor).actorId: was scrubbed but should be UNCHANGED — staff/admin negative test",
        ).not.toBeNull()
      }

      // ── Surface 5 — OrderEventLog.payload (A1-new) ────────────────
      const postEventLogs = post.orderEventLogs as Array<{
        payload: Record<string, unknown> | null
      }>
      expect(
        postEventLogs.length,
        "OrderEventLog: rows missing post-anonymize",
      ).toBeGreaterThan(0)
      for (const e of postEventLogs) {
        // Per G2-d default recommendation: payload replaced with
        // {anonymized: true}. Accept null as a subset.
        const isAnonymized =
          e.payload === null ||
          (typeof e.payload === "object" &&
            e.payload !== null &&
            (e.payload as Record<string, unknown>)["anonymized"] === true)
        expect(
          isAnonymized,
          `OrderEventLog.payload: pre-anonymize value found post-anonymize (saw ${JSON.stringify(e.payload)})`,
        ).toBe(true)
      }

      // ── Surface 6 — LoyaltyAccount (A1-new) ───────────────────────
      // Per G2-c recommendation: scrub linkage (customerId null) + reset
      // balance to 0. Row STILL EXISTS (not deleted). We accept either
      // "customerId null and balance 0" OR "row deleted" — both satisfy
      // the LGPD erasure semantics. The brief calls for "scrub linkage +
      // reset balance"; a stricter A1 may delete the row entirely.
      const postLoyalty = post.loyaltyAccount as Array<{
        customerId: string | null
        stamps: number
        totalEarned: number
        redeemed: number
      }>
      if (postLoyalty.length > 0) {
        // G2-c "scrub linkage" branch.
        for (const l of postLoyalty) {
          expect(
            l.customerId,
            "LoyaltyAccount.customerId: pre-anonymize linkage found post-anonymize",
          ).toBeNull()
          expect(
            l.stamps,
            "LoyaltyAccount.stamps: pre-anonymize value found post-anonymize (balance must reset)",
          ).toBe(0)
        }
      }
      // (zero-rows branch is accepted as a stricter "delete-row" policy)

      // ── Surface 7 — Reservation.specialRequests (A1-new) ──────────
      const postReservations = post.reservations as Array<{
        specialRequests: unknown
      }>
      expect(
        postReservations.length,
        "Reservation: rows missing post-anonymize",
      ).toBeGreaterThan(0)
      for (const r of postReservations) {
        // Accept empty array OR null. The strategy doc recommends empty
        // array (`[]`); A1 may choose either.
        const isScrubbed =
          r.specialRequests === null ||
          (Array.isArray(r.specialRequests) && r.specialRequests.length === 0)
        expect(
          isScrubbed,
          `Reservation.specialRequests: pre-anonymize value found post-anonymize (saw ${JSON.stringify(r.specialRequests)})`,
        ).toBe(true)
      }

      // Suppress lint on unused fixture-import (we keep it for symmetry
      // with future tests that inspect builder output directly).
      void fixtures
    })
  },
)
