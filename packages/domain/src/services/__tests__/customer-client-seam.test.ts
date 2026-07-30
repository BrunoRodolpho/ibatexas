// R5-S1 — the `createCustomerService({ client })` seam and the canonical
// in-memory adapter behind it.
//
// The sibling suites (customer-service-methods / customer-admin-reads) assert
// the Prisma CALL SHAPES against hand-built `vi.fn()` delegates. This file
// asserts the complementary half those cannot reach: that the service produces
// the right STATE when its calls actually execute, and that the adapter refuses
// — loudly — every path it does not implement.
//
// The `../../client.js` mock is deliberately kept and is load-bearing: it is how
// the default-to-singleton half of the seam is proven (no client ⇒ the singleton
// delegate is the one that gets called), and it guarantees no test here can
// reach a real database even if the seam regressed.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { buildEnvelope } from "@adjudicate/core"
import { Channel } from "@ibatexas/types"
import type {
  CustomerOnboardingState,
  CustomerPixDetailsSavePayload,
} from "@ibatexas/pack-customer-onboarding"

const singleton = vi.hoisted(() => ({
  customer: { update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
  customerPreferences: { upsert: vi.fn() },
}))

vi.mock("../../client.js", () => ({ prisma: singleton }))
vi.mock("@ibatexas/nats-client", () => ({ publishNatsEvent: vi.fn() }))

import { createCustomerService } from "../customer.service.js"
import {
  createInMemoryDomainClient,
  InMemoryRecordNotFound,
  UnroutedDomainClientCall,
  type InMemoryDomainClient,
} from "../../testing/in-memory-client.js"

const NOW = new Date("2026-07-29T12:00:00.000Z")

/** A CPF with a valid Modulo-11 checksum — the pack's guard accepts it. */
const VALID_CPF = "39053344705"

let db: InMemoryDomainClient

beforeEach(() => {
  vi.clearAllMocks()
  db = createInMemoryDomainClient({ now: () => NOW })
})

function service() {
  return createCustomerService({ client: db.client })
}

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
      now: NOW,
      ...overrides,
    },
  }
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

// ── The seam ────────────────────────────────────────────────────────────────

describe("createCustomerService client seam", () => {
  it("defaults to the module singleton when no client is supplied", async () => {
    singleton.customer.update.mockResolvedValue({})

    await createCustomerService().updateProfile("cus_01", { name: "Ana" })

    expect(singleton.customer.update).toHaveBeenCalledWith({
      where: { id: "cus_01" },
      data: { name: "Ana" },
    })
  })

  it("routes through the injected client and never touches the singleton", async () => {
    db.seed("customer", [{ id: "cus_01", phone: "+5511999990001" }])

    await service().updateProfile("cus_01", { name: "Ana", email: "ana@x.com" })

    expect(singleton.customer.update).not.toHaveBeenCalled()
    const [row] = db.rows("customer")
    expect(row).toMatchObject({ id: "cus_01", name: "Ana", email: "ana@x.com" })
  })

  it("keeps the audit/log options working alongside the client", async () => {
    db.seed("customer", [{ id: "cus_01", phone: "+5511999990001" }])
    const emit = vi.fn().mockResolvedValue(undefined)

    const out = await createCustomerService({
      client: db.client,
      auditSink: { emit },
    }).updatePixDetailsFromEnvelope(
      pixEnvelope({ name: "Maria", email: "maria@x.com", cpf: VALID_CPF }),
      onboardingState(),
      { customerId: "cus_01" },
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(emit).toHaveBeenCalledTimes(1)
  })
})

// ── Real service behaviour, observed as state ───────────────────────────────

describe("preferences round-trip through the adapter", () => {
  it("creates the row with every array explicit (CLAUDE.md rule #1)", async () => {
    const out = await service().updatePreferences("cus_01", {
      allergenExclusions: ["amendoim"],
    })

    expect(out).toEqual({
      allergenExclusions: ["amendoim"],
      dietaryRestrictions: [],
      favoriteCategories: [],
    })
    expect(db.rows("customerPreferences")).toHaveLength(1)
  })

  it("returns the STORED row on a partial update, preserving omitted fields", async () => {
    // This is the behaviour the service comment calls out: callers cache the
    // return value, so a partial update must not answer with coerced-empty
    // arrays for the fields it did not touch. Only an executing client can
    // show it — a `vi.fn()` returning a canned row proves nothing.
    const svc = service()
    await svc.updatePreferences("cus_01", {
      allergenExclusions: ["amendoim"],
      dietaryRestrictions: ["vegetariano"],
      favoriteCategories: ["carnes"],
    })

    const out = await svc.updatePreferences("cus_01", {
      favoriteCategories: ["peixes"],
    })

    expect(out).toEqual({
      allergenExclusions: ["amendoim"],
      dietaryRestrictions: ["vegetariano"],
      favoriteCategories: ["peixes"],
    })
    expect(db.rows("customerPreferences")).toHaveLength(1)
  })
})

describe("submitReview round-trip through the adapter", () => {
  const base = {
    customerId: "cus_01",
    productId: "prod_1",
    rating: 4,
    channel: Channel.Web,
  }

  it("aggregates the product's rating across reviews", async () => {
    const svc = service()
    await svc.submitReview({ ...base, orderId: "ord_1", rating: 5 })
    const out = await svc.submitReview({
      ...base,
      customerId: "cus_02",
      orderId: "ord_2",
      rating: 3,
    })

    expect(out).toEqual({ avgRating: 4, reviewCount: 2 })
    expect(db.rows("review")).toHaveLength(2)
  })

  it("upserts on the (orderId, customerId) compound unique instead of inserting twice", async () => {
    const svc = service()
    await svc.submitReview({ ...base, orderId: "ord_1", rating: 2, comment: "morno" })
    const out = await svc.submitReview({ ...base, orderId: "ord_1", rating: 5 })

    expect(db.rows("review")).toHaveLength(1)
    expect(out).toEqual({ avgRating: 5, reviewCount: 1 })
    expect(db.rows("review")[0]).toMatchObject({ rating: 5, comment: null })
  })
})

describe("admin reads round-trip through the adapter", () => {
  beforeEach(() => {
    db.seed("customer", [
      {
        id: "cus_01",
        phone: "+5511999990001",
        name: "Maria Silva",
        email: "maria@example.com",
        cpf: "123.456.789-00",
        source: "whatsapp",
        createdAt: new Date("2026-06-01T10:00:00.000Z"),
      },
      {
        id: "cus_02",
        phone: "+5511888880002",
        name: "João Souza",
        email: "joao@example.com",
        source: "web",
        createdAt: new Date("2026-07-01T10:00:00.000Z"),
      },
    ])
  })

  it("searchForAdmin matches name case-insensitively and NEVER selects cpf", async () => {
    const out = await service().searchForAdmin({ q: "maria" })

    expect(out.count).toBe(1)
    expect(out.customers[0]).toEqual({
      id: "cus_01",
      name: "Maria Silva",
      phone: "+5511999990001",
      email: "maria@example.com",
      source: "whatsapp",
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
    })
    // The `select` whitelist is the real defence, not the route's mapping.
    expect(Object.keys(out.customers[0]!)).not.toContain("cpf")
  })

  it("searchForAdmin orders most-recent-first and paginates", async () => {
    const out = await service().searchForAdmin({ limit: 1, offset: 1 })

    expect(out.count).toBe(2)
    expect(out.customers.map((c) => c.id)).toEqual(["cus_01"])
  })

  it("getByIdForAdmin resolves the preferences relation and 404s an unknown id", async () => {
    db.seed("customerPreferences", [
      { customerId: "cus_01", allergenExclusions: ["amendoim"] },
    ])
    const svc = service()

    const found = await svc.getByIdForAdmin("cus_01")
    expect(found?.preferences?.allergenExclusions).toEqual(["amendoim"])

    expect(await svc.getByIdForAdmin("nope")).toBeNull()
  })

  it("getOrderedTogether ranks co-purchased products by frequency", async () => {
    const item = (medusaOrderId: string, productId: string) => ({
      customerId: "cus_01",
      medusaOrderId,
      productId,
      variantId: `${productId}_v`,
      quantity: 1,
      priceInCentavos: 8900,
      orderedAt: NOW,
    })
    db.seed("customerOrderItem", [
      item("ord_1", "costela"),
      item("ord_1", "pao"),
      item("ord_2", "costela"),
      item("ord_2", "pao"),
      item("ord_2", "refrigerante"),
    ])

    const out = await service().getOrderedTogether("cus_01", "costela")

    expect(out).toEqual([
      { productId: "pao", _count: { productId: 2 } },
      { productId: "refrigerante", _count: { productId: 1 } },
    ])
  })
})

// ── Kernel branches, executed ───────────────────────────────────────────────

describe("updatePixDetailsFromEnvelope over a live client", () => {
  beforeEach(() => {
    db.seed("customer", [{ id: "cus_01", phone: "+5511999990001" }])
  })

  it("EXECUTE writes name/email/cpf onto the row", async () => {
    const out = await service().updatePixDetailsFromEnvelope(
      pixEnvelope({ name: "Maria", email: "maria@x.com", cpf: VALID_CPF }),
      onboardingState(),
      { customerId: "cus_01" },
    )

    expect(out.decision.kind).toBe("EXECUTE")
    expect(db.rows("customer")[0]).toMatchObject({
      name: "Maria",
      email: "maria@x.com",
      cpf: VALID_CPF,
    })
  })

  it("REFUSE on an invalid CPF leaves the row byte-identical", async () => {
    const before = db.rows("customer")[0]

    const out = await service().updatePixDetailsFromEnvelope(
      pixEnvelope({ name: "Maria", email: "maria@x.com", cpf: "bad" }),
      onboardingState(),
      { customerId: "cus_01" },
    )

    expect(out.decision.kind).toBe("REFUSE")
    expect(db.rows("customer")[0]).toEqual(before)
  })
})

// ── Throw-on-unrouted ───────────────────────────────────────────────────────

describe("the adapter refuses instead of answering emptily", () => {
  it("throws on a model it does not cover", () => {
    expect(
      () => (db.client as unknown as Record<string, unknown>)["orderProjection"],
    ).toThrow(UnroutedDomainClientCall)
  })

  it("throws on a delegate method it does not implement", () => {
    expect(
      () =>
        (db.client.review as unknown as Record<string, unknown>)["updateMany"],
    ).toThrow(/unrouted call: review\.updateMany/)
  })

  it("throws on raw SQL rather than inventing rows (findDormantCustomers)", async () => {
    await expect(service().findDormantCustomers(30)).rejects.toThrow(
      /\$queryRaw/,
    )
  })

  it("throws on an unsupported where operator EVEN WITH AN EMPTY STORE", async () => {
    // The store is deliberately empty. A check that only fires while iterating
    // rows would never run here, and the unsupported filter would silently
    // widen the query — the test would then pass on `[]`.
    expect(db.rows("customer")).toHaveLength(0)
    await expect(
      db.client.customer.findMany({
        where: { name: { startsWith: "Ma" } },
      }),
    ).rejects.toThrow(/customer\.where\.name\.startsWith/)
  })

  it("throws on a column the declared schema does not have, before the row lookup", async () => {
    // No `cus_01` row exists. The write-shape complaint must still be the one
    // that surfaces, otherwise a typo'd column hides behind a P2025 whenever
    // the store happens not to hold the target row.
    await expect(
      db.client.customer.update({
        where: { id: "cus_01" },
        // @ts-expect-error — the point of the test: a typo'd column must fail
        // loudly here rather than being stored as an unread field.
        data: { nmae: "Ana" },
      }),
    ).rejects.toThrow(/no such column/)
  })

  it("throws on a where that is not a declared unique for a unique-only read", async () => {
    await expect(
      db.client.customer.findUnique({
        // @ts-expect-error — Prisma would refuse to compile this too.
        where: { name: "Ana" },
      }),
    ).rejects.toThrow(/not a declared unique/)
  })

  it("rejects an update against a missing row (Prisma P2025), never a silent no-op", async () => {
    await expect(
      service().updateProfile("ghost", { name: "Ana" }),
    ).rejects.toThrow(InMemoryRecordNotFound)
  })

  it("rejects findUniqueOrThrow against a missing row", async () => {
    await expect(service().getById("ghost")).rejects.toThrow(
      InMemoryRecordNotFound,
    )
  })

  it("refuses interactive transactions (no rollback semantics to offer)", async () => {
    await expect(
      (
        db.client as unknown as {
          $transaction: (cb: () => Promise<void>) => Promise<void>
        }
      ).$transaction(async () => undefined),
    ).rejects.toThrow(/interactive transactions/)
  })
})
