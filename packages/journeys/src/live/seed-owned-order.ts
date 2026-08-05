// live/seed-owned-order.ts — BKL-141's governed customer-OWNED Medusa-order
// seeder (CLI + library). Creates a REAL Medusa order whose
// `metadata.customerId` is bound to a given DOMAIN customer, then mirrors it
// into an ibx_domain.order_projections row — the one precondition that makes
// the order-status happy path (SCN-024) and the true-IDOR ownership guard
// (SCN-036 / assertOrderOwnership) reachable. See seed-owned-order-input.ts's
// header for the full gap rationale (why neither seed-refundable-order.ts nor
// seed-item-order.ts closes it).
//
// GOVERNANCE POSTURE (identical to seed-item-order.ts, which this mirrors):
//   • The Medusa order is created via the admin draft-order -> convert-to-order
//     flow — Medusa's own admin-authored-order mechanism, needing no payment
//     provider (the ephemeral test stack has none). NEVER a raw SQL write into
//     Medusa's tables.
//   • The domain projection is a RAW Prisma write — the same "dev tooling
//     seeds PRECONDITION state directly, not a customer-authored mutation the
//     kernel needs to adjudicate" posture the sibling seeders already document.
//
// IDEMPOTENT: each order carries a deterministic `metadata.seedKey`
// (deriveOwnedOrderSeedKey). A re-run for the same (customer,label) re-finds
// the existing Medusa order by that key and REUSES it (also back-filling the
// projection if it went missing) instead of creating a duplicate — the seeder
// returns the same ids every time.
//
// DRY-RUN: `seedOwnedOrder({ dryRun: true })` returns the IO-free plan
// (buildOwnedOrderDryRunPlan) — no Medusa / prisma / network touched — so a
// caller can inspect exactly what a seed WOULD stamp (crucially,
// metadata.customerId + the stable seedKey) before a live stack exists. The
// live e2e usage is deferred (owner skip-live directive).
//
//   tsx packages/journeys/src/live/seed-owned-order.ts --customer-id <domainCustomerId>
//     [--label happy-path] [--customer-phone +55...] [--dry-run] [--fresh-window]
//
// BKL-187 `--fresh-window`: uniquifies the label per invocation so the
// idempotent (customer,label) REUSE is bypassed and a brand-new order +
// projection row are created NOW — createdAt lands inside the 5-min customer
// cancel window (PONR reads the projection's own created_at). Governed: no
// timestamp surgery, just a fresh row.
//   -> {"orderId":"order_...","displayId":...,"itemCount":4,
//       "customerId":"<domainCustomerId>","seedKey":"bkl141-owned-...","reused":false}
//
// DEV-ONLY: refuses when NODE_ENV=production (it writes real order + projection
// rows). Requires DATABASE_URL (source the dev .env first) for the projection
// write.
//
// pt-BR (CLAUDE.md rule #4): operator/CLI output is en per the script idiom;
// the only pt-BR is the synthetic customer name/address stamped onto seed data.

import { fileURLToPath } from "node:url"
import {
  OWNED_ORDER_ITEM_PLAN,
  OWNED_ORDER_SEED_KEY_FIELD,
  buildOwnedOrderDraftPayload,
  buildOwnedOrderDryRunPlan,
  deriveOwnedOrderSeedKey,
  ownedOrderLookupPath,
  type OwnedOrderDryRunPlan,
  type OwnedOrderLineItemPlanEntry,
  type OwnedOrderSeedOptions,
  type ResolvedOwnedOrderLineItem,
} from "./seed-owned-order-input.js"

export class SeedOwnedOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedOwnedOrderError"
  }
}

interface MedusaVariant {
  readonly id: string
  readonly title?: string
}
interface MedusaProduct {
  readonly id: string
  readonly handle: string
  readonly variants?: readonly MedusaVariant[]
}

export interface SeedOwnedOrderOptions extends OwnedOrderSeedOptions {
  /** IO-free plan only — no Medusa / prisma / network. Returns a dry-run result. */
  readonly dryRun?: boolean
  /**
   * BKL-187 — guarantee an order INSIDE the customer cancel window (PONR).
   * The PONR check reads the PROJECTION row's `createdAt` (`@default(now())`),
   * so a genuinely FRESH seed is in-window by construction — the only reason a
   * "fresh" run landed stale was the (customer,label) idempotent REUSE of an
   * old order. This flag uniquifies the label per invocation (time-suffixed),
   * bypassing reuse so a NEW Medusa order + projection are created NOW. Fully
   * governed: no timestamp surgery anywhere.
   */
  readonly freshWindow?: boolean
  readonly onProgress?: (line: string) => void
}

export interface SeedOwnedOrderResult {
  readonly orderId: string
  readonly displayId: number
  readonly itemCount: number
  readonly customerId: string
  readonly seedKey: string
  /** True when an existing order was re-found by seedKey (idempotent re-run). */
  readonly reused: boolean
  /** True when nothing was written (dryRun). */
  readonly dryRun: boolean
  /** Present only on a dry run — the IO-free plan. */
  readonly plan?: OwnedOrderDryRunPlan
}

async function resolveRegionAndSalesChannel(
  medusaAdmin: typeof import("@ibatexas/tools").medusaAdmin,
): Promise<{ regionId: string; salesChannelId: string }> {
  const regions = (await medusaAdmin("/admin/regions")) as { regions?: Array<{ id: string }> }
  const regionId = regions.regions?.[0]?.id
  if (regionId === undefined) {
    throw new SeedOwnedOrderError("no Medusa region found — is the commerce stack bootstrapped?")
  }
  const channels = (await medusaAdmin("/admin/sales-channels")) as {
    sales_channels?: Array<{ id: string; name: string }>
  }
  // "Loja Online" is the catalog's real sales channel (see seed-item-order.ts /
  // seed-checkout-cart.ts's SALES-CHANNEL BOOTSTRAP GOTCHA) — "Default Sales
  // Channel" has no products associated on the ephemeral stack.
  const salesChannelId =
    channels.sales_channels?.find((c) => c.name === "Loja Online")?.id ??
    channels.sales_channels?.[0]?.id
  if (salesChannelId === undefined) {
    throw new SeedOwnedOrderError("no Medusa sales channel found")
  }
  return { regionId, salesChannelId }
}

async function resolveVariantId(
  medusaAdmin: typeof import("@ibatexas/tools").medusaAdmin,
  entry: OwnedOrderLineItemPlanEntry,
): Promise<string> {
  const data = (await medusaAdmin(`/admin/products?handle=${entry.productHandle}`)) as {
    products?: MedusaProduct[]
  }
  const product = data.products?.[0]
  if (product === undefined) {
    throw new SeedOwnedOrderError(
      `no product with handle "${entry.productHandle}" found — did the catalog seed run?`,
    )
  }
  const variants = product.variants ?? []
  const variant =
    entry.variantTitle === undefined
      ? variants[0]
      : variants.find((v) => v.title === entry.variantTitle)
  if (variant === undefined) {
    throw new SeedOwnedOrderError(
      `product "${entry.productHandle}" has no variant` +
        (entry.variantTitle === undefined ? "" : ` titled "${entry.variantTitle}"`),
    )
  }
  return variant.id
}

/** Domain OrderFulfillmentStatus for a freshly-seeded order (Medusa's own
 *  `fulfillment_status` vocabulary is NOT the domain enum — see
 *  seed-item-order.ts's note; a fresh order is "pending" in domain terms). */
const DOMAIN_FULFILLMENT_STATUS = "pending"

/**
 * Idempotently seed a customer-owned Medusa order (+ its domain projection).
 * On `dryRun`, returns the IO-free plan with NO imports of tools/prisma.
 */
export async function seedOwnedOrder(opts: SeedOwnedOrderOptions): Promise<SeedOwnedOrderResult> {
  const onProgress = opts.onProgress ?? (() => undefined)
  const customerId = opts.customerId.trim()
  if (customerId === "") {
    throw new SeedOwnedOrderError("seedOwnedOrder: --customer-id must be non-empty")
  }
  // BKL-187 — a fresh-window seed must NEVER reuse: uniquify the label so the
  // deterministic seedKey misses every prior order and a brand-new projection
  // row (createdAt=now, inside PONR) is created. The suffix is second-granular
  // ISO (sanitized to the seedKey charset) — unique per invocation in practice
  // and readable in the returned seedKey.
  const effectiveLabel =
    opts.freshWindow === true
      ? `${opts.label ?? "fresh"}-w${new Date().toISOString().replace(/[:.-]/g, "").slice(0, 18)}`
      : opts.label
  // Thread the effective label through EVERY derivation (lookup, dry-run plan,
  // draft metadata) so the stamped metadata.seedKey and the returned seedKey
  // stay one value — never a lookup/stamp mismatch.
  const seedOpts: OwnedOrderSeedOptions = { ...opts, label: effectiveLabel }
  const seedKey = deriveOwnedOrderSeedKey(customerId, effectiveLabel)

  if (opts.dryRun === true) {
    const plan = buildOwnedOrderDryRunPlan(seedOpts)
    onProgress(`  ✓ [dry-run] owned-order plan for customer ${customerId} (seedKey ${seedKey})`)
    return {
      orderId: `dry-run:${seedKey}`,
      displayId: 0,
      itemCount: OWNED_ORDER_ITEM_PLAN.length,
      customerId,
      seedKey,
      reused: false,
      dryRun: true,
      plan,
    }
  }

  const { medusaAdmin } = await import("@ibatexas/tools")
  const { prisma, toOrderProjectionData } = await import("@ibatexas/domain")

  // ── Idempotency: re-find a prior seed by its deterministic seedKey ──────────
  // BKL-187 hardening (smoke-caught): on some stacks Medusa's `metadata[...]`
  // query filter does NOT filter (returns an arbitrary order), so a blind
  // `orders[0]` reuse is SPURIOUS — it silently returns someone else's stale
  // order (exactly the stale-age trap this flag exists to break). Two guards:
  //   1. freshWindow skips the lookup entirely (its key is unique-per-run —
  //      there is nothing legitimate to re-find).
  //   2. every reuse VERIFIES the candidate's stamped metadata.seedKey equals
  //      the derived key (the lookup already requests `metadata` in fields).
  let existingOrder: { id: string; display_id?: number } | undefined
  if (opts.freshWindow !== true) {
    const existing = (await medusaAdmin(ownedOrderLookupPath(seedKey))) as {
      orders?: Array<{
        id: string
        display_id?: number
        metadata?: Record<string, unknown>
      }>
    }
    existingOrder = existing.orders?.find(
      (o) => o.metadata?.[OWNED_ORDER_SEED_KEY_FIELD] === seedKey,
    )
  }
  if (existingOrder !== undefined) {
    const itemCount = await ensureProjection(medusaAdmin, prisma, toOrderProjectionData, existingOrder.id, customerId)
    onProgress(
      `  ✓ reused owned order ${existingOrder.id} (seedKey ${seedKey}) for customer ${customerId}`,
    )
    return {
      orderId: existingOrder.id,
      displayId: existingOrder.display_id ?? 0,
      itemCount,
      customerId,
      seedKey,
      reused: true,
      dryRun: false,
    }
  }

  // ── Create a REAL Medusa order (draft -> convert), owned via metadata ───────
  const { regionId, salesChannelId } = await resolveRegionAndSalesChannel(medusaAdmin)
  const lineItems: ResolvedOwnedOrderLineItem[] = await Promise.all(
    OWNED_ORDER_ITEM_PLAN.map(async (entry) => ({
      variant_id: await resolveVariantId(medusaAdmin, entry),
      quantity: 1,
    })),
  )

  const draftPayload = buildOwnedOrderDraftPayload(seedOpts, { regionId, salesChannelId, lineItems })
  const draftRes = (await medusaAdmin("/admin/draft-orders", {
    method: "POST",
    body: JSON.stringify(draftPayload),
  })) as { draft_order?: { id: string } }
  const draftOrderId = draftRes.draft_order?.id
  if (draftOrderId === undefined) {
    throw new SeedOwnedOrderError("POST /admin/draft-orders returned no draft order id")
  }

  const convertRes = (await medusaAdmin(`/admin/draft-orders/${draftOrderId}/convert-to-order`, {
    method: "POST",
  })) as { order?: { id: string; display_id?: number } }
  const orderId = convertRes.order?.id
  if (orderId === undefined) {
    throw new SeedOwnedOrderError("convert-to-order returned no order id")
  }

  const itemCount = await ensureProjection(medusaAdmin, prisma, toOrderProjectionData, orderId, customerId)

  onProgress(
    `  ✓ seeded owned order ${orderId} (${itemCount} items, metadata.customerId=${customerId}) seedKey ${seedKey}`,
  )
  return {
    orderId,
    displayId: convertRes.order?.display_id ?? 0,
    itemCount,
    customerId,
    seedKey,
    reused: false,
    dryRun: false,
  }
}

/**
 * Ensure the ibx_domain.order_projections row (+ initial status-history) for
 * `orderId` exists and is owned by `customerId`. Idempotent: skips the write
 * if a projection is already present (an idempotent re-run reusing a prior
 * Medusa order). Re-fetches the full Medusa order (convert-to-order's response
 * is not guaranteed to expand items) and maps it via the SAME
 * toOrderProjectionData production order-sync uses. Returns the item count.
 */
async function ensureProjection(
  medusaAdmin: typeof import("@ibatexas/tools").medusaAdmin,
  prisma: typeof import("@ibatexas/domain").prisma,
  toOrderProjectionData: typeof import("@ibatexas/domain").toOrderProjectionData,
  orderId: string,
  customerId: string,
): Promise<number> {
  const existing = await prisma.orderProjection.findUnique({ where: { id: orderId } })

  const fullOrder = (await medusaAdmin(`/admin/orders/${orderId}`)) as {
    order: Parameters<typeof toOrderProjectionData>[0]
  }
  const projectionInput = toOrderProjectionData(fullOrder.order, { customerId })

  if (existing !== null) {
    return projectionInput.itemCount
  }

  await prisma.$transaction(async (tx) => {
    const projection = await tx.orderProjection.create({
      data: {
        id: projectionInput.id,
        displayId: projectionInput.displayId,
        customerId: projectionInput.customerId,
        customerEmail: projectionInput.customerEmail,
        customerName: projectionInput.customerName,
        customerPhone: projectionInput.customerPhone,
        fulfillmentStatus: DOMAIN_FULFILLMENT_STATUS,
        paymentStatus: projectionInput.paymentStatus,
        totalInCentavos: projectionInput.totalInCentavos,
        subtotalInCentavos: projectionInput.subtotalInCentavos,
        shippingInCentavos: projectionInput.shippingInCentavos,
        itemCount: projectionInput.itemCount,
        itemsJson: projectionInput.itemsJson as never,
        itemsSchemaVersion: projectionInput.itemsSchemaVersion,
        shippingAddressJson: projectionInput.shippingAddressJson as never,
        deliveryType: projectionInput.deliveryType,
        paymentMethod: projectionInput.paymentMethod,
        tipInCentavos: projectionInput.tipInCentavos,
        version: 1,
        medusaCreatedAt: projectionInput.medusaCreatedAt,
      },
    })
    await tx.orderStatusHistory.create({
      data: {
        orderId: projection.id,
        fromStatus: DOMAIN_FULFILLMENT_STATUS,
        toStatus: DOMAIN_FULFILLMENT_STATUS,
        actor: "system",
        version: 1,
      },
    })
  })

  return projectionInput.itemCount
}

// ── CLI entry point (ad-hoc/manual seeding, mirrors seed-item-order.ts) ──

interface CliArgs {
  customerId: string
  label?: string
  customerEmail?: string
  customerName?: string
  customerPhone?: string
  dryRun: boolean
  freshWindow: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  let customerId: string | undefined
  let label: string | undefined
  let customerEmail: string | undefined
  let customerName: string | undefined
  let customerPhone: string | undefined
  let dryRun = false
  let freshWindow = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      i++
      return v
    }
    switch (a) {
      case "--customer-id":
        customerId = next()
        break
      case "--label":
        label = next()
        break
      case "--customer-email":
        customerEmail = next()
        break
      case "--customer-name":
        customerName = next()
        break
      case "--customer-phone":
        customerPhone = next()
        break
      case "--dry-run":
        dryRun = true
        break
      case "--fresh-window":
        freshWindow = true
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  if (customerId === undefined) throw new Error("--customer-id is required")
  return { customerId, label, customerEmail, customerName, customerPhone, dryRun, freshWindow }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new SeedOwnedOrderError(
      "seed-owned-order refuses to run with NODE_ENV=production (it writes real order rows)",
    )
  }
  const args = parseArgs(process.argv.slice(2))
  if (!args.dryRun && !process.env.DATABASE_URL) {
    throw new SeedOwnedOrderError(
      "seed-owned-order: DATABASE_URL is not set (source the dev .env first, or pass --dry-run)",
    )
  }
  const result = await seedOwnedOrder({
    customerId: args.customerId,
    label: args.label,
    customerEmail: args.customerEmail,
    customerName: args.customerName,
    customerPhone: args.customerPhone,
    dryRun: args.dryRun,
    freshWindow: args.freshWindow,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const invokedPath = process.argv[1] ?? ""
if (invokedPath !== "" && fileURLToPath(import.meta.url) === invokedPath) {
  // No explicit prisma.$disconnect() (mirrors seed-item-order.ts): process.exit
  // tears the pool down, and a dry-run must never import @ibatexas/domain.
  try {
    await main()
    process.exit(0)
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
