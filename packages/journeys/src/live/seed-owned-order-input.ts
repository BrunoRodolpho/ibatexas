// live/seed-owned-order-input.ts — PURE input builders for BKL-141's governed
// customer-OWNED Medusa-order seeder (+ the optional reservation recipe). NO
// IO: given a target customer and (live-resolved) line-item variant ids, these
// builders return the EXACT request bodies the executor
// (live/seed-owned-order.ts) then sends to Medusa's admin API — plus the
// deterministic idempotency key those bodies carry.
//
// WHY THIS SEEDER EXISTS (the BKL-141 gap the sibling seeders DON'T close):
// `check_order_status` / `get_order_history` / `assertOrderOwnership`
// (packages/tools/src/guards/ownership.ts:31) read the order STRAIGHT FROM
// MEDUSA (`GET /admin/orders/{id}`) and resolve its owner as
// `order.customer_id ?? order.metadata.customerId`. The existing order
// seeders each miss the piece the ownership/happy-path proofs need:
//   • seed-refundable-order.ts writes ONLY an ibx_domain.order_projections row
//     — no backing Medusa order at all (GET /admin/orders/:id 404s).
//   • seed-item-order.ts DOES create a real Medusa order, but leaves it
//     UNOWNED (no customer_id, no metadata.customerId) — so
//     assertOrderOwnership resolves it as a "no owner" resource and REFUSEs at
//     the fail-closed default, never exercising the true owner-MATCH (SCN-024
//     happy path) or owner-MISMATCH (SCN-036 true-IDOR) branches.
// This seeder binds `metadata.customerId` to the target DOMAIN customer id, so
// the Medusa-direct ownership read resolves a real owner — the one precondition
// that makes both proofs reachable (tracker BKL-141: "one Medusa order + one
// turn settles SCN-024 happy-path AND SCN-036 assertOrderOwnership").
//
// IDEMPOTENCY: every seeded order carries a deterministic `seedKey` in
// metadata (derived purely from customerId + label). The executor looks the
// key up via `GET /admin/orders?metadata[seedKey]=<key>` before creating, so a
// re-run for the same (customer,label) REUSES the existing order instead of
// piling up duplicates — the seeder returns the same ids every time.
//
// Split PURE-from-IO (mirrors seed-input.ts): these builders are cheap to
// unit-test with no Medusa / prisma / network — the executor owns the actual
// admin-API calls and the raw projection write. packages/journeys is
// coverage-excluded, but the SHAPE of an ownership-bearing seed (does it
// actually stamp metadata.customerId? is the key stable across runs?) is
// exactly what a proof depends on, so it is worth pinning.
//
// pt-BR (CLAUDE.md rule #4): the only pt-BR strings here are the synthetic
// customer NAME/ADDRESS stamped onto seed DATA (never user-facing agent copy);
// operator/CLI output stays en per the script idiom.

/** A stable product HANDLE (never a raw variant ULID — those regenerate on
 *  every bootstrap) plus an optional variant TITLE for multi-variant products. */
export interface OwnedOrderLineItemPlanEntry {
  readonly productHandle: string
  readonly variantTitle?: string
}

/** Mirrors seed-item-order.ts's ITEM_ORDER_PLAN — the same 4 casual items the
 *  order.* corpora reference, so one seeded order satisfies any status /
 *  history / ownership case regardless of what it names. A happy-path /
 *  IDOR proof only needs a REAL, non-empty, owned order — not a specific total. */
export const OWNED_ORDER_ITEM_PLAN: readonly OwnedOrderLineItemPlanEntry[] = [
  { productHandle: "refrigerante", variantTitle: "Coca-Cola" },
  { productHandle: "refrigerante", variantTitle: "Guaraná Antarctica" },
  { productHandle: "smash-burger-defumado", variantTitle: "Unidade" },
  { productHandle: "mandioca-frita", variantTitle: "Porção" },
]

/** A friendly, unmistakably-synthetic customer name stamped on owned seeds. */
export const OWNED_ORDER_SEED_CUSTOMER_NAME = "Cliente Semente BKL-141"

/** The metadata key the idempotency lookup filters on. */
export const OWNED_ORDER_SEED_KEY_FIELD = "seedKey"

export class SeedOwnedOrderInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedOwnedOrderInputError"
  }
}

/**
 * Deterministic idempotency key for a (customer, label) pair. Pure and
 * stable: the SAME inputs always produce the SAME key, so the executor's
 * `metadata[seedKey]` lookup reliably re-finds a prior run's order. The
 * `bkl141` prefix namespaces it away from any other metadata filter.
 */
export function deriveOwnedOrderSeedKey(customerId: string, label = "default"): string {
  const cid = customerId.trim()
  if (cid === "") {
    throw new SeedOwnedOrderInputError("deriveOwnedOrderSeedKey: customerId must be non-empty")
  }
  const lbl = label.trim() === "" ? "default" : label.trim()
  // Only characters safe in a URL query value + Medusa metadata string.
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_")
  return `bkl141-owned-${safe(cid)}-${safe(lbl)}`
}

/** The idempotency-lookup path the executor GETs before creating anything. */
export function ownedOrderLookupPath(seedKey: string): string {
  return `/admin/orders?metadata[${OWNED_ORDER_SEED_KEY_FIELD}]=${encodeURIComponent(seedKey)}&limit=1&fields=id,display_id,customer_id,metadata`
}

export interface OwnedOrderSeedOptions {
  /** The DOMAIN Customer.id (NOT a Medusa customer id, NOT a phone) the order
   *  is bound to — stamped into `metadata.customerId`, exactly what
   *  assertOrderOwnership / toOrderProjectionData resolve the owner from. */
  readonly customerId: string
  /** Optional idempotency namespace, so one customer can own several distinct
   *  seeded orders (e.g. "happy-path" vs "idor-victim"). Default `"default"`. */
  readonly label?: string
  /** Contact fields stamped onto the seed (defaults are synthetic). */
  readonly customerEmail?: string
  readonly customerName?: string
  readonly customerPhone?: string
}

/** The shipping address every owned seed carries (synthetic, pt-BR data). */
export const OWNED_ORDER_SHIPPING_ADDRESS = {
  first_name: "Cliente",
  last_name: "Semente",
  address_1: "Rua da Semente 141",
  city: "São Paulo",
  country_code: "br",
  postal_code: "01000-000",
} as const

/** One resolved line item (variant id resolved live) the draft carries. */
export interface ResolvedOwnedOrderLineItem {
  readonly variant_id: string
  readonly quantity: number
}

/** The `POST /admin/draft-orders` body — deterministic given the resolved pieces. */
export interface OwnedOrderDraftPayload {
  readonly email: string
  readonly region_id: string
  readonly sales_channel_id: string
  readonly items: readonly ResolvedOwnedOrderLineItem[]
  readonly metadata: Readonly<Record<string, string>>
  readonly shipping_address: typeof OWNED_ORDER_SHIPPING_ADDRESS
}

/**
 * Build the `POST /admin/draft-orders` body. The load-bearing correctness
 * this seeder exists for lives here: `metadata.customerId` is bound to the
 * target customer (the ownership anchor) and `metadata.seedKey` carries the
 * idempotency key. Throws (never silently drifts) on an empty customerId or
 * an empty resolved item set — an owned order with no items is useless to a
 * line-item / history proof.
 */
export function buildOwnedOrderDraftPayload(
  opts: OwnedOrderSeedOptions,
  resolved: {
    readonly regionId: string
    readonly salesChannelId: string
    readonly lineItems: readonly ResolvedOwnedOrderLineItem[]
  },
): OwnedOrderDraftPayload {
  const customerId = opts.customerId.trim()
  if (customerId === "") {
    throw new SeedOwnedOrderInputError("buildOwnedOrderDraftPayload: customerId must be non-empty")
  }
  if (resolved.lineItems.length === 0) {
    throw new SeedOwnedOrderInputError(
      "buildOwnedOrderDraftPayload: resolved lineItems must be non-empty (an owned order needs real lines)",
    )
  }
  const seedKey = deriveOwnedOrderSeedKey(customerId, opts.label)
  const name = opts.customerName ?? OWNED_ORDER_SEED_CUSTOMER_NAME
  const email = opts.customerEmail ?? `${seedKey}@example.com`

  const metadata: Record<string, string> = {
    // The ownership anchor — assertOrderOwnership resolves the owner from
    // exactly this (customer_id ?? metadata.customerId), and
    // toOrderProjectionData reads the same key.
    customerId,
    customerName: name,
    customerEmail: email,
    // Idempotency: the executor re-finds this order by this key.
    [OWNED_ORDER_SEED_KEY_FIELD]: seedKey,
    // Documents provenance for anyone spelunking the Medusa order later.
    seededBy: "bkl141-seed-owned-order",
  }
  if (opts.customerPhone !== undefined) {
    metadata["customerPhone"] = opts.customerPhone
  }

  return {
    email,
    region_id: resolved.regionId,
    sales_channel_id: resolved.salesChannelId,
    items: resolved.lineItems,
    metadata,
    shipping_address: OWNED_ORDER_SHIPPING_ADDRESS,
  }
}

/**
 * The dry-run plan — everything the seeder can determine WITHOUT any IO
 * (variant ids are live-resolved, so they are absent here). Lets a caller /
 * test inspect exactly what an owned seed WOULD stamp before a live stack
 * exists.
 */
export interface OwnedOrderDryRunPlan {
  readonly customerId: string
  readonly seedKey: string
  readonly email: string
  readonly customerName: string
  /** The metadata that WILL be stamped (sans any live-derived fields). */
  readonly metadata: Readonly<Record<string, string>>
  /** The handle/variant vocabulary the executor will resolve live. */
  readonly itemPlan: readonly OwnedOrderLineItemPlanEntry[]
  /** The idempotency lookup the executor will issue first. */
  readonly lookupPath: string
}

/** Build the IO-free dry-run plan for `seedOwnedOrder({ dryRun: true })`. */
export function buildOwnedOrderDryRunPlan(opts: OwnedOrderSeedOptions): OwnedOrderDryRunPlan {
  const customerId = opts.customerId.trim()
  if (customerId === "") {
    throw new SeedOwnedOrderInputError("buildOwnedOrderDryRunPlan: customerId must be non-empty")
  }
  const seedKey = deriveOwnedOrderSeedKey(customerId, opts.label)
  const name = opts.customerName ?? OWNED_ORDER_SEED_CUSTOMER_NAME
  const email = opts.customerEmail ?? `${seedKey}@example.com`
  const metadata: Record<string, string> = {
    customerId,
    customerName: name,
    customerEmail: email,
    [OWNED_ORDER_SEED_KEY_FIELD]: seedKey,
    seededBy: "bkl141-seed-owned-order",
  }
  if (opts.customerPhone !== undefined) {
    metadata["customerPhone"] = opts.customerPhone
  }
  return {
    customerId,
    seedKey,
    email,
    customerName: name,
    metadata,
    itemPlan: OWNED_ORDER_ITEM_PLAN,
    lookupPath: ownedOrderLookupPath(seedKey),
  }
}

// ── Optional reservation seed (BKL-141 "+ optional reservation") ─────────────
//
// Reservations live in the DOMAIN (ibx_domain.reservations / Prisma), NOT in
// Medusa — assertReservationOwnership (ownership.ts:65) reads
// `prisma.reservation` directly by customerId, so no Medusa write is involved.
// The GOVERNED, already-working recipe (statusSweep, 2026-07-10) is an authed
// `POST /api/reservations` (customer JWT via live/mint-staff-jwt.ts's sibling
// customer path) AFTER `ibx db:seed:tables` has seeded time slots — that HTTP
// route runs the real kernel-adjudicated `reservation.create` path. This
// builder produces the EXACT request body that recipe needs; the live POST
// itself rides the deferred skip-live wave (owner directive), symmetric with
// the order seeder's own live-deferred posture.

export interface ReservationSeedOptions {
  /** The DOMAIN Customer.id the reservation is owned by. */
  readonly customerId: string
  /** A seeded TimeSlot.id (from `ibx db:seed:tables`). */
  readonly timeSlotId: string
  /** Party size — a positive integer. */
  readonly partySize: number
  /** Optional structured special requests (SpecialRequest[] shape). */
  readonly specialRequests?: ReadonlyArray<{ readonly type: string; readonly notes?: string }>
}

/** The `POST /api/reservations` request body for a reservation seed. */
export interface ReservationSeedPlan {
  readonly customerId: string
  readonly httpBody: {
    readonly timeSlotId: string
    readonly partySize: number
    readonly specialRequests: ReadonlyArray<{ readonly type: string; readonly notes?: string }>
  }
}

/**
 * Build the authed-`POST /api/reservations` body for an owned reservation
 * seed. Pure + validated: rejects an empty customerId / timeSlotId or a
 * non-positive-integer party size rather than letting the live POST fail
 * opaquely later.
 */
export function buildReservationSeedPlan(opts: ReservationSeedOptions): ReservationSeedPlan {
  const customerId = opts.customerId.trim()
  if (customerId === "") {
    throw new SeedOwnedOrderInputError("buildReservationSeedPlan: customerId must be non-empty")
  }
  const timeSlotId = opts.timeSlotId.trim()
  if (timeSlotId === "") {
    throw new SeedOwnedOrderInputError("buildReservationSeedPlan: timeSlotId must be non-empty")
  }
  if (!Number.isInteger(opts.partySize) || opts.partySize <= 0) {
    throw new SeedOwnedOrderInputError(
      `buildReservationSeedPlan: partySize must be a positive integer, got ${String(opts.partySize)}`,
    )
  }
  return {
    customerId,
    httpBody: {
      timeSlotId,
      partySize: opts.partySize,
      specialRequests: opts.specialRequests ?? [],
    },
  }
}
