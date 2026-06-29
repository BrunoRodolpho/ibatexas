// audit-2026-05-24 H3 Wave A2 — declarative PII fixture builder for the
// T4 LGPD-scrub conformance suite.
//
// # Why this builder exists
//
// T4 asserts that `anonymizeCustomer` scrubs PII across 7 in-process
// surfaces. To prove that, every test needs to first POPULATE every
// surface with detectable PII (so the post-anonymize snapshot has
// something to compare against). Hand-rolling N inserts per test would
// be ~150 lines of boilerplate per case — and would drift out of sync
// with the schema.
//
// `PIIFixtureSpec` is a single declarative shape: callers list which
// surfaces to populate + the PII values to embed; the builder runs a
// minimal-coupling `prisma.$transaction` that creates the customer + every
// requested surface in one round trip. Returns the populated rows so the
// test can snapshot pre-anonymize state and diff against post-state.
//
// Surfaces covered (per `docs/.../h3-investigation/schema.md`):
//   1. OrderProjection.{customerEmail, customerName, customerPhone,
//      shippingAddressJson}                                      → orderProjections
//   2. ConversationMessage.content                                → conversations[].messages
//   3. Conversation.customerId (FK)                               → conversations
//   4. OrderStatusHistory.actorId (when actor='customer')         → orderStatusHistory
//   5. OrderEventLog.payload                                      → orderEventLogs
//   6. LoyaltyAccount (entire row scrub)                          → loyaltyAccount
//   7. Reservation.specialRequests                                → reservations
//
// Plus the W4 pre-A1 already-scrubbed surfaces:
//   - Customer.{name,email,phone,cpf}
//   - Address[]
//   - CustomerPreferences
//   - Review[].comment
//   - CustomerOrderItem.customerId (delink)
//
// # Defaults & determinism
//
// The builder fills required FK chains (TimeSlot for Reservation, etc.)
// with deterministic stub rows scoped to the test's customerId. This keeps
// per-test isolation simple: a TRUNCATE between tests wipes both the
// customer rows AND the stub FK targets.
//
// All cuid-style IDs are generated from `randomUUID()` so successive runs
// don't collide. The customerId itself is caller-supplied (or auto-generated)
// so it can be reused for staff-actor negative tests etc.

import { randomUUID } from "node:crypto"
import { prisma, type Prisma } from "@ibatexas/domain"

export interface PIIFixtureSpec {
  /** Customer ID. Auto-generated if not supplied. */
  customerId?: string

  /** Required PII on the Customer row itself. */
  phone: string
  email: string
  name: string
  cpf?: string

  /** Surface 1 — OrderProjection. One row per entry. */
  orderProjections?: Array<{
    customerEmail: string
    customerName: string
    customerPhone: string
    shippingAddressJson: Record<string, unknown>
    /** OrderProjection.id (Medusa order ID). Auto-generated if absent. */
    id?: string
  }>

  /** Surfaces 2 + 3 — Conversation + ConversationMessage. */
  conversations?: Array<{
    sessionId?: string
    messages: Array<{
      role: "user" | "assistant" | "system"
      content: string
    }>
  }>

  /**
   * Surface 4 — OrderStatusHistory. `actorType` mirrors the OrderActor
   * enum: `customer` carries customer linkage (anonymize SHOULD null
   * actorId); `admin` represents staff actions (anonymize must NOT touch
   * those rows). `system`/`system_backfill` use null actorId.
   */
  orderStatusHistory?: Array<{
    /** Required: links to the OrderProjection that triggered the transition. */
    orderId: string
    actorType: "customer" | "admin" | "system" | "system_backfill"
    /** When actorType='customer', this is the customerId; for 'admin' it's a staff.id. */
    actorId?: string | null
    reason?: string
  }>

  /** Surface 5 — OrderEventLog. payload should embed PII to test scrub. */
  orderEventLogs?: Array<{
    orderId: string
    eventType: string
    payload: Record<string, unknown>
  }>

  /**
   * Surface 6 — LoyaltyAccount. Single row (Customer FK is @unique).
   * Present-or-absent decides whether the loyalty path is exercised.
   */
  loyaltyAccount?: {
    stamps: number
    totalEarned: number
    redeemed?: number
  }

  /** Surface 7 — Reservation. */
  reservations?: Array<{
    partySize: number
    /** JSON array of {type, notes} entries — PII lives in notes. */
    specialRequests: Array<Record<string, unknown>>
  }>

  // ── W4 pre-A1 surfaces (already scrubbed; included for the
  //    JSON-stringification leak scan + idempotency tests) ──────────

  addresses?: Array<{
    street: string
    number: string
    district: string
    city: string
    state: string
    cep: string
  }>

  reviews?: Array<{
    orderId: string
    rating: number
    comment: string
    channel?: "web" | "whatsapp"
  }>

  preferences?: {
    dietaryRestrictions?: string[]
    allergenExclusions?: string[]
    favoriteCategories?: string[]
  }

  orderItems?: Array<{
    medusaOrderId: string
    productId: string
    variantId: string
    quantity: number
    priceInCentavos: number
  }>
}

export interface BuiltFixture {
  customerId: string
  fixtures: {
    customer: unknown
    orderProjections: unknown[]
    conversations: unknown[]
    conversationMessages: unknown[]
    orderStatusHistory: unknown[]
    orderEventLogs: unknown[]
    loyaltyAccount: unknown
    reservations: unknown[]
    timeSlots: unknown[]
    staffActors: unknown[]
    addresses: unknown[]
    reviews: unknown[]
    preferences: unknown
    orderItems: unknown[]
  }
}

/**
 * Populate every surface declared in `spec` for a single customer in one
 * Prisma transaction. Returns the populated rows so the test can snapshot
 * pre-anonymize PII before calling `anonymizeCustomer`.
 *
 * The builder also creates the minimal FK-target rows the in-scope surfaces
 * require (a TimeSlot for each Reservation, an OrderProjection for each
 * Review/OrderStatusHistory/OrderEventLog if not already created via
 * `orderProjections`, Staff rows for staff-actor history entries). These
 * are tagged with the test's customerId in their `id` namespace so TRUNCATE
 * between tests wipes them cleanly.
 */
export async function buildPIIFixture(spec: PIIFixtureSpec): Promise<BuiltFixture> {
  const customerId = spec.customerId ?? `cust_t4_${randomUUID().slice(0, 12)}`

  // Pre-compute IDs we need to coordinate across multiple writes.
  // Auto-generate OrderProjection IDs when callers don't supply them, so
  // downstream surfaces (statusHistory, eventLogs) can target real rows.
  const projectionIdsByIndex = (spec.orderProjections ?? []).map(
    (op, i) => op.id ?? `ord_t4_${customerId.slice(-8)}_${i}`,
  )

  // Collect every orderId we need an OrderProjection FK for (status
  // history + event logs may reference projections beyond what
  // spec.orderProjections supplies).
  const referencedOrderIds = new Set<string>(projectionIdsByIndex)
  for (const h of spec.orderStatusHistory ?? []) referencedOrderIds.add(h.orderId)
  for (const e of spec.orderEventLogs ?? []) referencedOrderIds.add(e.orderId)

  return prisma.$transaction(async (tx) => {
    // ── (1) Customer ────────────────────────────────────────────────
    const customer = await tx.customer.create({
      data: {
        id: customerId,
        phone: spec.phone,
        email: spec.email,
        name: spec.name,
        ...(spec.cpf === undefined ? {} : { cpf: spec.cpf }),
      },
    })

    // ── (2) Staff rows referenced by orderStatusHistory ─────────────
    const staffActors = await createStaffActors(tx, spec)

    // ── (3) Order projections (Surface 1) ──────────────────────────
    const orderProjections = await createOrderProjections(
      tx,
      spec,
      customerId,
      projectionIdsByIndex,
      referencedOrderIds,
    )

    // ── (4) Order status history (Surface 4) ───────────────────────
    const orderStatusHistory = await createOrderStatusHistory(tx, spec)

    // ── (5) Order event log (Surface 5) ────────────────────────────
    const orderEventLogs = await createOrderEventLogs(tx, spec, customerId)

    // ── (6) Conversations + messages (Surfaces 2 + 3) ──────────────
    const { conversations, conversationMessages } = await createConversations(
      tx,
      spec,
      customerId,
    )

    // ── (7) Loyalty account (Surface 6) ────────────────────────────
    const loyaltyAccount = await createLoyaltyAccount(tx, spec, customerId)

    // ── (8) Reservations + supporting TimeSlots (Surface 7) ────────
    const { reservations, timeSlots } = await createReservations(tx, spec, customerId)

    // ── (W4-a) Addresses ─────────────────────────────────────────────
    const addresses = await createAddresses(tx, spec, customerId)

    // ── (W4-b) Reviews ───────────────────────────────────────────────
    const reviews = await createReviews(tx, spec, customerId)

    // ── (W4-c) Preferences ───────────────────────────────────────────
    const preferences = await createPreferences(tx, spec, customerId)

    // ── (W4-d) Order items (CustomerOrderItem — delink on anonymize) ─
    const orderItems = await createOrderItems(tx, spec, customerId)

    return {
      customerId,
      fixtures: {
        customer,
        orderProjections,
        conversations,
        conversationMessages,
        orderStatusHistory,
        orderEventLogs,
        loyaltyAccount,
        reservations,
        timeSlots,
        staffActors,
        addresses,
        reviews,
        preferences,
        orderItems,
      },
    }
  })
}

// ── Per-surface insert helpers ───────────────────────────────────────
// Extracted verbatim from buildPIIFixture's transaction body to keep each
// unit's cognitive complexity low. Every helper writes through the supplied
// transaction client `tx`, so all inserts still share buildPIIFixture's atomic
// `$transaction`. Write order and generated IDs are identical to performing the
// inserts inline.

async function createStaffActors(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
): Promise<unknown[]> {
  // Staff rows referenced by orderStatusHistory. Staff actions are encoded as
  // actor='admin' with an actorId pointing at a staff row (the OrderActor enum
  // has no `staff` value; the schema comment on actorId notes it can carry
  // staff.id OR customer.id).
  const staffActorIds = new Set<string>()
  for (const h of spec.orderStatusHistory ?? []) {
    if (h.actorType === "admin" && h.actorId) staffActorIds.add(h.actorId)
  }
  const staffActors: unknown[] = []
  for (const staffId of staffActorIds) {
    const s = await tx.staff.create({
      data: {
        id: staffId,
        // Use a phone uniqueness-safe stub scoped to the customerId so
        // parallel-iteration tests don't collide on staff.phone unique.
        phone: `+55119${staffId.slice(-8).padStart(8, "0")}`,
        name: `Staff ${staffId}`,
      },
    })
    staffActors.push(s)
  }
  return staffActors
}

async function createOrderProjections(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
  projectionIdsByIndex: string[],
  referencedOrderIds: Set<string>,
): Promise<unknown[]> {
  const orderProjections: unknown[] = []
  const createdProjectionIds = new Set<string>()
  for (let i = 0; i < (spec.orderProjections ?? []).length; i++) {
    const op = spec.orderProjections![i]!
    const id = projectionIdsByIndex[i]!
    const proj = await tx.orderProjection.create({
      data: {
        id,
        displayId: 1000 + i,
        customerId,
        customerEmail: op.customerEmail,
        customerName: op.customerName,
        customerPhone: op.customerPhone,
        shippingAddressJson: op.shippingAddressJson as Parameters<
          typeof tx.orderProjection.create
        >[0]["data"]["shippingAddressJson"],
        medusaCreatedAt: new Date(),
      },
    })
    orderProjections.push(proj)
    createdProjectionIds.add(id)
  }
  // Backfill referenced order IDs that the caller didn't explicitly
  // declare in spec.orderProjections — orderStatusHistory + orderEventLog
  // have FK constraints on order_projections.id.
  for (const orderId of referencedOrderIds) {
    if (createdProjectionIds.has(orderId)) continue
    const proj = await tx.orderProjection.create({
      data: {
        id: orderId,
        displayId: 9000 + createdProjectionIds.size,
        customerId,
        medusaCreatedAt: new Date(),
      },
    })
    orderProjections.push(proj)
    createdProjectionIds.add(orderId)
  }
  return orderProjections
}

async function createOrderStatusHistory(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
): Promise<unknown[]> {
  const orderStatusHistory: unknown[] = []
  for (const h of spec.orderStatusHistory ?? []) {
    const row = await tx.orderStatusHistory.create({
      data: {
        orderId: h.orderId,
        fromStatus: "pending",
        toStatus: "confirmed",
        actor: h.actorType,
        ...(h.actorId === undefined ? {} : { actorId: h.actorId }),
        ...(h.reason === undefined ? {} : { reason: h.reason }),
        version: 1,
      },
    })
    orderStatusHistory.push(row)
  }
  return orderStatusHistory
}

async function createOrderEventLogs(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<unknown[]> {
  const orderEventLogs: unknown[] = []
  for (let i = 0; i < (spec.orderEventLogs ?? []).length; i++) {
    const e = spec.orderEventLogs![i]!
    const row = await tx.orderEventLog.create({
      data: {
        orderId: e.orderId,
        eventType: e.eventType,
        idempotencyKey: `idem_t4_${customerId.slice(-8)}_${i}_${randomUUID().slice(0, 8)}`,
        payload: e.payload as Parameters<
          typeof tx.orderEventLog.create
        >[0]["data"]["payload"],
        timestamp: new Date(),
      },
    })
    orderEventLogs.push(row)
  }
  return orderEventLogs
}

async function createConversations(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<{ conversations: unknown[]; conversationMessages: unknown[] }> {
  const conversations: unknown[] = []
  const conversationMessages: unknown[] = []
  for (let i = 0; i < (spec.conversations ?? []).length; i++) {
    const c = spec.conversations![i]!
    const conv = await tx.conversation.create({
      data: {
        sessionId: c.sessionId ?? `sess_t4_${customerId.slice(-8)}_${i}`,
        customerId,
        channel: "web",
      },
    })
    conversations.push(conv)
    for (const m of c.messages) {
      const msg = await tx.conversationMessage.create({
        data: {
          conversationId: (conv as { id: string }).id,
          role: m.role,
          content: m.content,
        },
      })
      conversationMessages.push(msg)
    }
  }
  return { conversations, conversationMessages }
}

async function createLoyaltyAccount(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<unknown> {
  if (!spec.loyaltyAccount) return null
  const loyaltyAccount = await tx.loyaltyAccount.create({
    data: {
      customerId,
      stamps: spec.loyaltyAccount.stamps,
      totalEarned: spec.loyaltyAccount.totalEarned,
      redeemed: spec.loyaltyAccount.redeemed ?? 0,
    },
  })
  return loyaltyAccount
}

async function createReservations(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<{ reservations: unknown[]; timeSlots: unknown[] }> {
  const reservations: unknown[] = []
  const timeSlots: unknown[] = []
  for (let i = 0; i < (spec.reservations ?? []).length; i++) {
    const r = spec.reservations![i]!
    // Each reservation needs a TimeSlot — make a unique one per row so
    // we don't trip the (date, startTime) unique constraint across
    // iterations.
    const slotDate = new Date(Date.UTC(2026, 5, 1 + i))
    const slot = await tx.timeSlot.create({
      data: {
        date: slotDate,
        startTime: `${(18 + (i % 4)).toString().padStart(2, "0")}:${(i * 7) % 60}`.replace(
          /:(\d)$/,
          ":0$1",
        ),
        maxCovers: 40,
      },
    })
    timeSlots.push(slot)
    const reservation = await tx.reservation.create({
      data: {
        customerId,
        timeSlotId: (slot as { id: string }).id,
        partySize: r.partySize,
        specialRequests: r.specialRequests as Parameters<
          typeof tx.reservation.create
        >[0]["data"]["specialRequests"],
      },
    })
    reservations.push(reservation)
  }
  return { reservations, timeSlots }
}

async function createAddresses(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<unknown[]> {
  const addresses: unknown[] = []
  for (const a of spec.addresses ?? []) {
    const addr = await tx.address.create({
      data: { customerId, ...a },
    })
    addresses.push(addr)
  }
  return addresses
}

async function createReviews(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<unknown[]> {
  const reviews: unknown[] = []
  for (const r of spec.reviews ?? []) {
    // Reviews have a (orderId, customerId) unique — auto-skip duplicates.
    const rev = await tx.review.create({
      data: {
        orderId: r.orderId,
        customerId,
        rating: r.rating,
        comment: r.comment,
        channel: r.channel ?? "web",
        productIds: [],
      },
    })
    reviews.push(rev)
  }
  return reviews
}

async function createPreferences(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<unknown> {
  if (!spec.preferences) return null
  const preferences = await tx.customerPreferences.create({
    data: {
      customerId,
      dietaryRestrictions: spec.preferences.dietaryRestrictions ?? [],
      allergenExclusions: spec.preferences.allergenExclusions ?? [],
      favoriteCategories: spec.preferences.favoriteCategories ?? [],
    },
  })
  return preferences
}

async function createOrderItems(
  tx: Prisma.TransactionClient,
  spec: PIIFixtureSpec,
  customerId: string,
): Promise<unknown[]> {
  const orderItems: unknown[] = []
  for (const oi of spec.orderItems ?? []) {
    const item = await tx.customerOrderItem.create({
      data: {
        customerId,
        medusaOrderId: oi.medusaOrderId,
        productId: oi.productId,
        variantId: oi.variantId,
        quantity: oi.quantity,
        priceInCentavos: oi.priceInCentavos,
        orderedAt: new Date(),
      },
    })
    orderItems.push(item)
  }
  return orderItems
}

/**
 * Snapshot every row reachable from `customerId` after a mutation. Used to
 * diff pre-vs-post anonymize state and to power the JSON-stringification
 * defense-in-depth scan.
 */
export async function snapshotCustomerReachable(
  customerId: string,
  priorSnapshot?: Record<string, unknown[]>,
): Promise<Record<string, unknown[]>> {
  // Post-anonymize, A1 nulls `Conversation.customerId` AND
  // `LoyaltyAccount.customerId`, so re-deriving those sets via the FK
  // returns 0 rows. The optional `priorSnapshot` lets callers thread the
  // pre-anonymize row IDs through so the post-snapshot can still locate
  // the rows that A1 mutated in place.
  const priorConversationIds = priorSnapshot
    ? ((priorSnapshot.conversations as Array<{ id: string }> | undefined) ?? [])
        .map((c) => c.id)
    : []
  const priorLoyaltyAccountIds = priorSnapshot
    ? (
        (priorSnapshot.loyaltyAccount as Array<{ id: string }> | undefined) ??
        []
      ).map((l) => l.id)
    : []

  // OrderProjection.customerId is NOT scrubbed by A1 (only the scalar PII
  // fields are nulled), so the same query works pre- and post-anonymize.
  const orderProjections = await prisma.orderProjection.findMany({
    where: { customerId },
  })
  const orderIds = orderProjections.map((p) => (p as { id: string }).id)

  const [
    customer,
    addresses,
    preferences,
    reviews,
    orderItems,
    conversations,
    conversationMessages,
    orderStatusHistory,
    orderEventLogs,
    loyaltyAccount,
    reservations,
  ] = await Promise.all([
    prisma.customer.findMany({ where: { id: customerId } }),
    prisma.address.findMany({ where: { customerId } }),
    prisma.customerPreferences.findMany({ where: { customerId } }),
    prisma.review.findMany({ where: { customerId } }),
    prisma.customerOrderItem.findMany({ where: { customerId } }),
    priorConversationIds.length > 0
      ? prisma.conversation.findMany({
          where: {
            OR: [{ customerId }, { id: { in: priorConversationIds } }],
          },
        })
      : prisma.conversation.findMany({ where: { customerId } }),
    priorConversationIds.length > 0
      ? prisma.conversationMessage.findMany({
          where: { conversationId: { in: priorConversationIds } },
        })
      : prisma.conversationMessage.findMany({
          where: { conversation: { customerId } },
        }),
    // OrderStatusHistory has no FK to Customer; we search by the projections
    // we just snapshotted PLUS the actorId for customer-actor rows.
    prisma.orderStatusHistory.findMany({
      where: {
        OR: [
          { actorId: customerId },
          ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
        ],
      },
    }),
    // OrderEventLog has no Prisma relation; route via orderId.
    orderIds.length > 0
      ? prisma.orderEventLog.findMany({ where: { orderId: { in: orderIds } } })
      : Promise.resolve([] as unknown[]),
    priorLoyaltyAccountIds.length > 0
      ? prisma.loyaltyAccount.findMany({
          where: {
            OR: [{ customerId }, { id: { in: priorLoyaltyAccountIds } }],
          },
        })
      : prisma.loyaltyAccount.findMany({ where: { customerId } }),
    prisma.reservation.findMany({ where: { customerId } }),
  ])

  return {
    customer,
    addresses,
    preferences,
    reviews,
    orderItems,
    orderProjections,
    conversations,
    conversationMessages,
    orderStatusHistory,
    orderEventLogs,
    loyaltyAccount,
    reservations,
  }
}
