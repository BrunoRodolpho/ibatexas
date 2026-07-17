// live/seed-item-order.ts — FE-T14's PLACED-ORDER-seeding CLI/library for
// `order.amend.update_qty`/`order.amend.remove_item` live calibration
// (team-lead ruling: the variantId-bridge fix's "calibrate the 4 dependent
// files live" — this is the order-side sibling of seed-item-cart.ts's
// cart-side seeding).
//
// WHY a NEW seeder, not seed-cancelable-order.ts (T12's existing
// order-precondition seeder): that seeder's underlying seed-refundable-
// order.ts creates an `ibx_domain.order_projections` row DIRECTLY (a WS9
// refund-fixture pattern) with NO backing Medusa order at all — verified
// empirically against this ticket's own ephemeral stack: `GET /admin/
// orders/:id` for a seed-refundable-order.ts-created id returns ZERO
// items. That's fine for order.cancel/order.note.add (their auto-resolve
// only needs the order's EXISTENCE + total/payment-status), but
// resolveOrderLineItem (resolve-and-assemble.ts) fetches the order
// straight from MEDUSA's admin API for its line items — a projection-only
// fixture has nothing for it to match against, bridge or not.
//
// This seeder instead does BOTH halves for real: (1) creates a genuine
// Medusa order via the admin draft-order -> convert-to-order flow (no
// payment-provider module is configured on the ephemeral test stack, so
// the customer-facing checkout/payment-session flow 400s — draft orders
// are Medusa's own admin-authored-order mechanism and need neither), with
// the SAME 4-item vocabulary seed-item-cart.ts's ITEM_CART_PLAN uses; (2)
// maps that REAL order through the SAME `toOrderProjectionData` mapper
// production order-sync uses, and writes the resulting
// `ibx_domain.order_projections` row via a RAW Prisma write — same
// "dev tooling seeds PRECONDITION state directly, not a customer-authored
// mutation the kernel needs to adjudicate" posture seed-checkout-cart.ts's
// header already documents for its own raw `medusaStore()` cart-building
// (never `medusaStoreAdjudicated`/`getOrCreateCart`).
//
// CUSTOMER-KEYED, not session-keyed (mirrors seed-cancelable-order.ts):
// order.amend.*'s auto-resolve targets "the customer's most recent order"
// by customerId — nothing here binds to a sessionId, unlike the cart
// seeders.

import { fileURLToPath } from "node:url"

export class SeedItemOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedItemOrderError"
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

interface ItemOrderPlanEntry {
  readonly productHandle: string
  readonly variantTitle?: string
}

/** Mirrors seed-item-cart.ts's ITEM_CART_PLAN exactly — same 4 casual item
 *  names the order.amend.update_qty/remove_item corpus references, so a
 *  seeded order satisfies any case regardless of which item it names. */
export const ITEM_ORDER_PLAN: readonly ItemOrderPlanEntry[] = [
  { productHandle: "refrigerante", variantTitle: "Coca-Cola" },
  { productHandle: "refrigerante", variantTitle: "Guaraná Antarctica" },
  { productHandle: "smash-burger-defumado", variantTitle: "Unidade" },
  { productHandle: "mandioca-frita", variantTitle: "Porção" },
]

export interface SeedItemOrderOptions {
  /** The domain Customer.id (NOT phone) the order_projections row is stamped with. */
  customerId: string
  onProgress?: (line: string) => void
}

export interface SeedItemOrderResult {
  readonly orderId: string
  readonly itemCount: number
}

async function resolveRegionAndSalesChannel(
  medusaAdmin: typeof import("@ibatexas/tools").medusaAdmin,
): Promise<{ regionId: string; salesChannelId: string }> {
  const regions = (await medusaAdmin("/admin/regions")) as { regions?: Array<{ id: string }> }
  const regionId = regions.regions?.[0]?.id
  if (regionId === undefined) {
    throw new SeedItemOrderError("no Medusa region found — is the commerce stack bootstrapped?")
  }
  const channels = (await medusaAdmin("/admin/sales-channels")) as {
    sales_channels?: Array<{ id: string; name: string }>
  }
  // "Loja Online" is the catalog's real sales channel (see seed-checkout-
  // cart.ts's own SALES-CHANNEL BOOTSTRAP GOTCHA note) — "Default Sales
  // Channel" has no products associated with it on this ephemeral stack.
  const salesChannelId =
    channels.sales_channels?.find((c) => c.name === "Loja Online")?.id ??
    channels.sales_channels?.[0]?.id
  if (salesChannelId === undefined) {
    throw new SeedItemOrderError("no Medusa sales channel found")
  }
  return { regionId, salesChannelId }
}

async function resolveVariantId(
  medusaAdmin: typeof import("@ibatexas/tools").medusaAdmin,
  entry: ItemOrderPlanEntry,
): Promise<string> {
  const data = (await medusaAdmin(`/admin/products?handle=${entry.productHandle}`)) as {
    products?: MedusaProduct[]
  }
  const product = data.products?.[0]
  if (product === undefined) {
    throw new SeedItemOrderError(
      `no product with handle "${entry.productHandle}" found — did the catalog seed run?`,
    )
  }
  const variants = product.variants ?? []
  const variant =
    entry.variantTitle === undefined
      ? variants[0]
      : variants.find((v) => v.title === entry.variantTitle)
  if (variant === undefined) {
    throw new SeedItemOrderError(
      `product "${entry.productHandle}" has no variant` +
        (entry.variantTitle === undefined ? "" : ` titled "${entry.variantTitle}"`),
    )
  }
  return variant.id
}

/**
 * Creates a real Medusa order (draft-order -> convert-to-order, no payment
 * module needed) carrying all 4 `ITEM_ORDER_PLAN` entries, maps it through
 * `toOrderProjectionData`, and writes the matching `order_projections` row
 * directly for `customerId` — the `order.amend.update_qty`/`remove_item`
 * precondition (an existing order with real, variant_id-bearing lines).
 */
export async function seedItemOrder(opts: SeedItemOrderOptions): Promise<SeedItemOrderResult> {
  const onProgress = opts.onProgress ?? (() => undefined)
  const { medusaAdmin } = await import("@ibatexas/tools")
  const { prisma, toOrderProjectionData } = await import("@ibatexas/domain")

  const { regionId, salesChannelId } = await resolveRegionAndSalesChannel(medusaAdmin)

  const items = await Promise.all(
    ITEM_ORDER_PLAN.map(async (entry) => ({
      variant_id: await resolveVariantId(medusaAdmin, entry),
      quantity: 1,
    })),
  )

  const draftRes = (await medusaAdmin("/admin/draft-orders", {
    method: "POST",
    body: JSON.stringify({
      email: `fe-t14-item-order-${Date.now()}@example.com`,
      region_id: regionId,
      sales_channel_id: salesChannelId,
      items,
      shipping_address: {
        first_name: "Calibração",
        last_name: "FE-T14",
        address_1: "Rua de Teste 100",
        city: "Sao Paulo",
        country_code: "br",
        postal_code: "01000-000",
      },
    }),
  })) as { draft_order?: { id: string } }
  const draftOrderId = draftRes.draft_order?.id
  if (draftOrderId === undefined) {
    throw new SeedItemOrderError("POST /admin/draft-orders returned no draft order id")
  }

  const convertRes = (await medusaAdmin(`/admin/draft-orders/${draftOrderId}/convert-to-order`, {
    method: "POST",
  })) as { order?: { id: string } }
  const orderId = convertRes.order?.id
  if (orderId === undefined) {
    throw new SeedItemOrderError("convert-to-order returned no order id")
  }

  // Re-fetch: convert-to-order's own response shape is not guaranteed to
  // carry the full `items[]` expansion `toOrderProjectionData` needs.
  const fullOrder = (await medusaAdmin(`/admin/orders/${orderId}`)) as {
    order: Parameters<typeof toOrderProjectionData>[0]
  }
  const projectionInput = toOrderProjectionData(fullOrder.order, { customerId: opts.customerId })
  // Medusa's own `fulfillment_status` vocabulary ("not_fulfilled", ...) is
  // NOT the domain OrderFulfillmentStatus enum (pending|confirmed|
  // preparing|ready|in_delivery|delivered|canceled) — toOrderProjectionData
  // passes Medusa's raw string through unmapped, which the Prisma enum
  // column rejects outright. A freshly placed order is always "pending" in
  // the domain's own vocabulary; this seeder's precondition only needs a
  // REAL order with matchable line items, not a specific status.
  const DOMAIN_FULFILLMENT_STATUS = "pending"

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

  onProgress(
    `  ✓ seeded item order ${orderId} (${projectionInput.itemCount} items) for customer ${opts.customerId}`,
  )
  return { orderId, itemCount: projectionInput.itemCount }
}

// ── CLI entry point (ad-hoc/manual seeding, mirrors seed-item-cart.ts) ──

interface CliArgs {
  customerId: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  let customerId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--customer-id") {
      const v = argv[i + 1]
      if (v === undefined) throw new Error("missing value for --customer-id")
      customerId = v
      i++
    } else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  if (customerId === undefined) throw new Error("--customer-id is required")
  return { customerId }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new SeedItemOrderError(
      "seed-item-order refuses to run with NODE_ENV=production (it writes real order rows)",
    )
  }
  const args = parseArgs(process.argv.slice(2))
  const result = await seedItemOrder({
    customerId: args.customerId,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const invokedPath = process.argv[1] ?? ""
if (invokedPath !== "" && fileURLToPath(import.meta.url) === invokedPath) {
  try {
    await main()
    process.exit(0)
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
