// live/seed-item-cart.ts — FE-T14's cart-seeding CLI/library for
// `order.item.update`/`order.item.remove` live calibration (team-lead
// ruling: item-cart seeder approved).
//
// Mirrors seed-checkout-cart.ts's EXACT shape (cart↔session binding via
// `rk('cart:active:session:${sessionId}')`, real Medusa cart via the RAW
// `medusaStore()` client, one seed per rotated sessionId) — see that
// module's header for the full cart↔session binding rationale, not
// repeated here.
//
// WHY a fixed 4-item cart, not a per-case plan (unlike seed-checkout-cart.ts's
// CART_LINE_ITEM_PLANS): order.item.update/remove's corpus references
// exactly 4 casual item names across all its cases (coca, guaraná,
// hambúrguer, batata frita) and each case only ever touches ONE of them —
// seeding all 4 into every rotated session's cart means any case in the
// corpus resolves correctly regardless of driving order, with no per-case
// dispatch table to keep in sync.
//
// CATALOG MAPPING (the variantId bridge's whole reason for existing —
// resolve-and-assemble.ts's resolveLineItemByNameOrVariant): none of these
// 4 casual names equal a PRODUCT title (Medusa always titles a cart line by
// the product, e.g. "Refrigerante" for both "coca" and "guaraná") — they
// name a VARIANT ("Coca-Cola", "Guaraná Antarctica") or, for
// "batata frita", share a lexical token ("frita") with the closest cataloged
// item ("Mandioca Frita") without being an exact product/variant match at
// all. This seeder does not try to paper over that: it seeds the REAL
// catalog as-is, so calibration proves the bridge against genuine product
// data, not a synthetic fixture shaped to make the corpus pass.
//
//   - "coca"          -> refrigerante product, "Coca-Cola" variant
//   - "guaraná"        -> refrigerante product, "Guaraná Antarctica" variant
//   - "hambúrguer"     -> smash-burger-defumado product, "Unidade" variant
//   - "batata frita"   -> mandioca-frita product, "Porção" variant (closest
//                          cataloged item; the bridge's hasLexicalOverlap
//                          floor accepts it via the shared "frita" token)

import { fileURLToPath } from "node:url"

interface MedusaVariant {
  readonly id: string
  readonly title?: string
}
interface MedusaProduct {
  readonly id: string
  readonly handle: string
  readonly variants?: readonly MedusaVariant[]
}
interface MedusaCart {
  readonly id: string
}

interface ItemCartPlanEntry {
  readonly productHandle: string
  readonly variantTitle?: string
}

/** The fixed 4-item plan — see module header for the full catalog-mapping rationale. */
export const ITEM_CART_PLAN: readonly ItemCartPlanEntry[] = [
  { productHandle: "refrigerante", variantTitle: "Coca-Cola" },
  { productHandle: "refrigerante", variantTitle: "Guaraná Antarctica" },
  { productHandle: "smash-burger-defumado", variantTitle: "Unidade" },
  { productHandle: "mandioca-frita", variantTitle: "Porção" },
]

export class SeedItemCartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedItemCartError"
  }
}

async function resolveRegionId(medusaStore: typeof import("@ibatexas/tools").medusaStore): Promise<string> {
  const data = (await medusaStore("/store/regions")) as { regions?: Array<{ id: string }> }
  const regionId = data.regions?.[0]?.id
  if (regionId === undefined) {
    throw new SeedItemCartError("no Medusa region found — is the commerce stack bootstrapped?")
  }
  return regionId
}

async function resolveVariantId(
  medusaStore: typeof import("@ibatexas/tools").medusaStore,
  regionId: string,
  entry: ItemCartPlanEntry,
): Promise<string> {
  const data = (await medusaStore(
    `/store/products?handle=${entry.productHandle}&region_id=${regionId}&fields=id,handle,*variants`,
  )) as { products?: MedusaProduct[] }
  const product = data.products?.[0]
  if (product === undefined) {
    throw new SeedItemCartError(
      `no product with handle "${entry.productHandle}" found — did the catalog seed run?`,
    )
  }
  const variants = product.variants ?? []
  const variant =
    entry.variantTitle === undefined
      ? variants[0]
      : variants.find((v) => v.title === entry.variantTitle)
  if (variant === undefined) {
    throw new SeedItemCartError(
      `product "${entry.productHandle}" has no variant` +
        (entry.variantTitle === undefined ? "" : ` titled "${entry.variantTitle}"`),
    )
  }
  return variant.id
}

export interface SeedItemCartOptions {
  /** The EXACT sessionId the calibration case is about to POST under — the cart is bound to THIS id, not customerId. */
  sessionId: string
  /** Redis TTL, seconds — mirrors seed-checkout-cart.ts's own 24h convention. */
  ttlSeconds?: number
  onProgress?: (line: string) => void
}

export interface SeedItemCartResult {
  readonly cartId: string
  readonly itemCount: number
}

/**
 * Builds a real Medusa cart carrying all 4 `ITEM_CART_PLAN` entries and
 * binds it to `sessionId` in Redis — the `order.item.update`/
 * `order.item.remove` precondition (an active cart with the referenced
 * item already in it).
 */
export async function seedItemCart(opts: SeedItemCartOptions): Promise<SeedItemCartResult> {
  const onProgress = opts.onProgress ?? (() => undefined)
  try {
    return await seedItemCartOnce(opts, onProgress)
  } catch (err) {
    if (err instanceof SeedItemCartError) throw err
    // Mirrors seed-checkout-cart.ts's one-bounded-retry rationale — a
    // transient Medusa admin-login backoff, not a governance workaround.
    onProgress(`  ⚠ item-cart seed attempt 1 failed (${(err as Error).message}) — retrying once after 3s`)
    await new Promise((r) => setTimeout(r, 3_000))
    return await seedItemCartOnce(opts, onProgress)
  }
}

async function seedItemCartOnce(
  opts: SeedItemCartOptions,
  onProgress: (line: string) => void,
): Promise<SeedItemCartResult> {
  const { medusaStore, getRedisClient, rk } = await import("@ibatexas/tools")

  const regionId = await resolveRegionId(medusaStore)

  const cartRes = (await medusaStore("/store/carts", {
    method: "POST",
    body: JSON.stringify({ region_id: regionId }),
  })) as { cart?: MedusaCart }
  const cartId = cartRes.cart?.id
  if (cartId === undefined) {
    throw new SeedItemCartError("POST /store/carts returned no cart id")
  }

  for (const entry of ITEM_CART_PLAN) {
    const variantId = await resolveVariantId(medusaStore, regionId, entry)
    await medusaStore(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    })
  }

  const redis = await getRedisClient()
  const ttlSeconds = opts.ttlSeconds ?? 24 * 60 * 60
  await redis.set(rk(`cart:active:session:${opts.sessionId}`), cartId, { EX: ttlSeconds })

  onProgress(`  ✓ seeded item cart ${cartId} (4 items) -> session ${opts.sessionId}`)
  return { cartId, itemCount: ITEM_CART_PLAN.length }
}

// ── CLI entry point (ad-hoc/manual seeding, mirrors seed-checkout-cart.ts) ──

interface CliArgs {
  sessionId: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  let sessionId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--session-id") {
      const v = argv[i + 1]
      if (v === undefined) throw new Error("missing value for --session-id")
      sessionId = v
      i++
    } else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  if (sessionId === undefined) throw new Error("--session-id is required")
  return { sessionId }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new SeedItemCartError(
      "seed-item-cart refuses to run with NODE_ENV=production (it writes real cart rows)",
    )
  }
  const args = parseArgs(process.argv.slice(2))
  const result = await seedItemCart({
    sessionId: args.sessionId,
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
