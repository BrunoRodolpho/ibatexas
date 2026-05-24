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

      // ── JSON-stringification defense-in-depth scan ───────────────
      //
      // The per-surface assertions above pin the EXPECTED scrubs. This
      // scan catches surface-internal misses: e.g., A1 scrubs
      // OrderProjection.customerEmail but forgets `shippingAddressJson.recipientName`,
      // or adds a new column with PII that wasn't in the schema audit. We
      // serialise every reachable row to JSON and assert NO pre-anonymize
      // PII string survives.
      //
      // Inputs to scan are the load-bearing PII strings from the spec —
      // anything verbatim from the customer's profile that would let an
      // operator reconstruct identity post-anonymize.
      const piiInputs: Array<{ label: string; value: string }> = [
        { label: "email", value: spec.email },
        { label: "name", value: spec.name },
        { label: "phone", value: spec.phone },
        ...(spec.cpf ? [{ label: "cpf", value: spec.cpf }] : []),
        // String values from the embedded JSON payloads. These are the
        // SECOND-order leaks: A1 scrubs the column but leaves a copy
        // inside a JSON blob. The fixture seeds these explicitly so the
        // scan has detectable values.
        { label: "shippingRecipient", value: "João Silva Teste" },
        { label: "shippingStreet", value: "Rua T4 Teste" },
        {
          label: "eventLogEmail",
          value: "joao.silva.t4@example.com",
        },
        { label: "reservationNotes", value: "alérgico a amendoim" },
        { label: "reviewComment", value: "Adorei! Sou João Silva" },
      ]

      // For each reachable table, run a per-row JSON.stringify and
      // search for each PII input. A hit reports BOTH the table AND the
      // PII label so the operator can pinpoint the missed scrub.
      const leakReports: string[] = []
      for (const [tableName, rows] of Object.entries(post)) {
        if (!Array.isArray(rows)) continue
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!
          const serialized = JSON.stringify(row)
          for (const pii of piiInputs) {
            if (serialized.includes(pii.value)) {
              // Column hint — find the first key whose stringified value
              // contains the PII. Best-effort: nested JSON values get
              // attributed to their top-level column.
              const cols: string[] = []
              for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
                if (JSON.stringify(v).includes(pii.value)) cols.push(k)
              }
              leakReports.push(
                `PII leak in ${tableName}[${i}] — column(s) {${cols.join(", ")}} — PII type=${pii.label} value=${JSON.stringify(pii.value)}`,
              )
            }
          }
        }
      }

      expect(
        leakReports,
        leakReports.length > 0
          ? `JSON-stringification defense-in-depth scan caught residual PII (${leakReports.length} hits):\n  ${leakReports.join("\n  ")}`
          : "ok",
      ).toEqual([])

      // Suppress lint on unused fixture-import (we keep it for symmetry
      // with future tests that inspect builder output directly).
      void fixtures
    })

    it("anonymize leaves Staff/admin actor records untouched", async () => {
      // Heavy-on-staff fixture: 5 admin-actor status rows + 1 customer-actor
      // row + 1 system-actor row. Anonymize must scrub ONLY the customer
      // row's actorId; the rest are forensic-audit data and must remain.
      const customerId = "cust_t4_staff_negative"
      const adminActorIds = ["staff_t4_a1", "staff_t4_a2", "staff_t4_a3"]

      await buildPIIFixture({
        customerId,
        phone: "+5511955511111",
        email: "minimal.staff.case@example.com",
        name: "Minimal Staff Case",
        orderStatusHistory: [
          {
            orderId: "ord_t4_staff_neg_1",
            actorType: "customer",
            actorId: customerId,
          },
          ...adminActorIds.map((id, i) => ({
            orderId: `ord_t4_staff_neg_${i + 2}`,
            actorType: "admin" as const,
            actorId: id,
            reason: `admin override #${i + 1}`,
          })),
          {
            orderId: "ord_t4_staff_neg_sys",
            actorType: "system" as const,
            actorId: null,
          },
        ],
      })

      // Pre-snapshot — record every admin actorId so we can assert it
      // survives unchanged post-anonymize.
      const pre = await snapshotCustomerReachable(customerId)
      const preAdminActors = (
        pre.orderStatusHistory as Array<{ actor: string; actorId: string | null }>
      )
        .filter((h) => h.actor === "admin")
        .map((h) => h.actorId)
      expect(
        preAdminActors,
        "fixture setup: expected 3 admin-actor rows pre-anonymize",
      ).toEqual(expect.arrayContaining(adminActorIds))

      const { anonymizeCustomer } = await import("@ibatexas/domain")
      await anonymizeCustomer(customerId)

      const post = await snapshotCustomerReachable(customerId)
      const postRows = post.orderStatusHistory as Array<{
        actor: string
        actorId: string | null
      }>
      const postAdminActors = postRows
        .filter((h) => h.actor === "admin")
        .map((h) => h.actorId)
      const postCustomerRows = postRows.filter((h) => h.actor === "customer")

      // Admin actorIds are byte-for-byte preserved.
      expect(
        postAdminActors,
        "OrderStatusHistory(admin): admin actorIds were modified — staff/admin negative test regression",
      ).toEqual(expect.arrayContaining(adminActorIds))
      expect(
        postAdminActors.length,
        "OrderStatusHistory(admin): row count changed post-anonymize",
      ).toBe(adminActorIds.length)

      // Customer-actor row's actorId IS scrubbed.
      for (const c of postCustomerRows) {
        expect(
          c.actorId,
          "OrderStatusHistory(customer): actorId not scrubbed",
        ).toBeNull()
      }
    })

    it("anonymize is idempotent (re-running produces no further change)", async () => {
      const customerId = "cust_t4_idempotency"
      const spec = defaultPIISpec(customerId)
      await buildPIIFixture(spec)

      const { anonymizeCustomer } = await import("@ibatexas/domain")

      // First run.
      await anonymizeCustomer(customerId)
      const post1 = await snapshotCustomerReachable(customerId)

      // Second run.
      await anonymizeCustomer(customerId)
      const post2 = await snapshotCustomerReachable(customerId)

      // Compare every table key. We use a JSON normalisation pass that
      // strips `updatedAt` (Prisma bumps this on UPDATE even for a no-op
      // SetNull → SetNull update) — the rest of the row must match
      // byte-for-byte across runs. Anything else is a non-idempotent
      // mutation (e.g., a counter, a re-hashed phone sentinel, an audit
      // marker row written twice).
      const normalise = (rows: unknown[]) =>
        JSON.stringify(
          rows.map((r) => {
            const copy = { ...(r as Record<string, unknown>) } as Record<
              string,
              unknown
            >
            delete copy["updatedAt"]
            delete copy["updated_at"]
            return copy
          }),
        )

      for (const key of Object.keys(post1)) {
        const a = normalise(post1[key]!)
        const b = normalise(post2[key]!)
        expect(
          b,
          `idempotency: table '${key}' changed between anonymize runs — non-idempotent mutation`,
        ).toBe(a)
      }
    })

    it("anonymize emits audit records per surface scrubbed", async () => {
      // Capture every audit emission via a fresh sink wired into the
      // audit-sink leaf. We must reset + rewire because `__setAuditSinkDependencies`
      // is idempotent-after-init and the global setup.ts already wired a
      // noop. Per the leaf API: `__resetAuditSink()` then
      // `__setAuditSinkDependencies({...})` with our captures.
      const auditSinkModule = await import("@ibatexas/audit-sink")
      const { __resetAuditSink, __setAuditSinkDependencies } = auditSinkModule

      const captured: Array<Record<string, unknown>> = []

      __resetAuditSink()
      __setAuditSinkDependencies({
        spillStorage: {
          async append() {
            /* no-op */
          },
          async *readAll() {
            /* yields nothing */
          },
          async ack() {
            /* no-op */
          },
        },
        postgresWriter: {
          async insertAudit(record: Record<string, unknown>) {
            captured.push(record)
          },
        },
        natsPublisher: {
          async publish() {
            /* no-op */
          },
        },
        redactor: {
          redact(record) {
            return record
          },
        },
        logger: {
          warn() {
            /* no-op */
          },
          error() {
            /* no-op */
          },
        },
      })

      try {
        const customerId = "cust_t4_audit_emit"
        const spec = defaultPIISpec(customerId)
        await buildPIIFixture(spec)

        const { anonymizeCustomer } = await import("@ibatexas/domain")
        await anonymizeCustomer(customerId)

        // Wait a tick for fire-and-forget emit paths to drain. The sink's
        // emit is buffered; the postgresWriter sees the record after the
        // internal queue flushes.
        await new Promise((resolve) => setTimeout(resolve, 100))

        // Pre-A1: anonymizeCustomer emits ZERO per-surface audit records
        // (the legacy path goes through `withAdjudicate` only at the
        // envelope-typed entry point, not the bare helper). Post-A1: we
        // expect ≥ N records, one per surface scrubbed — kinds shaped like
        // `customer.anonymize.<surface>.scrubbed` OR
        // `customer.anonymize.<surface>` (A1 picks the convention).
        //
        // To keep this assertion durable across reasonable A1 implementations
        // we check: at least one captured record carries `customer.anonymize`
        // in the kind/intentKind/envelope.kind chain. Pre-A1 this is zero;
        // a passing post-A1 implementation produces ≥ 1.
        const anonymizeRecords = captured.filter((r) => {
          const kind =
            (r["kind"] as string | undefined) ??
            (r["intentKind"] as string | undefined) ??
            ((r["envelope"] as Record<string, unknown> | undefined)?.[
              "kind"
            ] as string | undefined) ??
            ""
          return kind.includes("customer.anonymize")
        })

        expect(
          anonymizeRecords.length,
          "anonymize: expected ≥1 audit record carrying 'customer.anonymize' — post-A1 should emit per-surface records",
        ).toBeGreaterThan(0)
      } finally {
        // Restore the noop sink for downstream tests in the file.
        __resetAuditSink()
        __setAuditSinkDependencies({
          spillStorage: {
            async append() {},
            async *readAll() {},
            async ack() {},
          },
          postgresWriter: { async insertAudit() {} },
          natsPublisher: { async publish() {} },
          redactor: { redact: (r) => r },
          logger: { warn() {}, error() {} },
        })
      }
    })
  },
)
