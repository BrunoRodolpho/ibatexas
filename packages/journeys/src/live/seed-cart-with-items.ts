// live/seed-cart-with-items.ts — BKL-186's CONFIGURABLE cart seeder (CLI +
// library): the generalization of seed-item-cart.ts's fixed 4-item plan into a
// caller-chosen item list, so the SCN-030 happy path (a grounded "o que tem no
// meu carrinho?" item-list render) is finally seedable.
//
// Mirrors seed-item-cart.ts EXACTLY on the governed mechanics (see that
// module's header, not repeated): a REAL Medusa cart via the RAW
// `medusaStore()` store API, line items added one by one, then the cart bound
// to the chat session via `rk('cart:active:session:${sessionId}')` — the SAME
// key the cart TurnRead resolves (apps/api turn-reads: `redis.get(rk(
// 'cart:active:session:${conversationId}'))`, IDOR-safe A2 — the read NEVER
// takes a model-supplied cart id). Governed API only, no raw writes.
//
// `--customer-id` is OPTIONAL and INFORMATIONAL: the Redis binding is
// session-keyed, not customer-keyed — the CART_CONTENTS/CART_EMPTY claims
// resolve ownership from the AUTHENTICATED session driving that sessionId, so
// the caller just needs to drive the chat as that customer. The arg is echoed
// in the result for drive-log bookkeeping only.
//
//   tsx packages/journeys/src/live/seed-cart-with-items.ts \
//     --session-id <chatSessionId> \
//     --items "refrigerante:2,mandioca-frita:1:Porção" \
//     [--customer-id cus_...]
//   -> {"cartId":"cart_...","itemCount":2,"sessionId":"..."}
//
// ITEMS SPEC: comma-separated entries, each `handle[:qty[:variantTitle]]` —
// qty defaults to 1, variant defaults to the product's FIRST variant. The
// variantTitle segment is last so it may contain anything but a comma.
//
// DEV-ONLY: refuses when NODE_ENV=production (it writes real cart rows).

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

export class SeedCartWithItemsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedCartWithItemsError"
  }
}

export interface CartItemSpec {
  readonly productHandle: string
  readonly quantity: number
  readonly variantTitle?: string
}

/**
 * Parse the `--items` spec: comma-separated `handle[:qty[:variantTitle]]`.
 * Pure — unit-tested without any network.
 */
export function parseItemsSpec(spec: string): readonly CartItemSpec[] {
  const trimmed = spec.trim()
  if (trimmed === "") {
    throw new SeedCartWithItemsError("--items must be a non-empty spec (handle[:qty[:variantTitle]],...)")
  }
  return trimmed.split(",").map((raw) => {
    const entry = raw.trim()
    if (entry === "") {
      throw new SeedCartWithItemsError(`--items has an empty entry in "${spec}"`)
    }
    const [handle, qtyRaw, ...variantParts] = entry.split(":")
    if (handle === undefined || handle.trim() === "") {
      throw new SeedCartWithItemsError(`--items entry "${entry}" has no product handle`)
    }
    let quantity = 1
    if (qtyRaw !== undefined && qtyRaw.trim() !== "") {
      quantity = Number.parseInt(qtyRaw, 10)
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new SeedCartWithItemsError(
          `--items entry "${entry}" has an invalid quantity "${qtyRaw}" (positive integer required)`,
        )
      }
    }
    const variantTitle = variantParts.length > 0 ? variantParts.join(":").trim() : undefined
    return {
      productHandle: handle.trim(),
      quantity,
      ...(variantTitle === undefined || variantTitle === "" ? {} : { variantTitle }),
    }
  })
}

async function resolveRegionId(
  medusaStore: typeof import("@ibatexas/tools").medusaStore,
): Promise<string> {
  const data = (await medusaStore("/store/regions")) as { regions?: Array<{ id: string }> }
  const regionId = data.regions?.[0]?.id
  if (regionId === undefined) {
    throw new SeedCartWithItemsError("no Medusa region found — is the commerce stack bootstrapped?")
  }
  return regionId
}

async function resolveVariantId(
  medusaStore: typeof import("@ibatexas/tools").medusaStore,
  regionId: string,
  item: CartItemSpec,
): Promise<string> {
  const data = (await medusaStore(
    `/store/products?handle=${item.productHandle}&region_id=${regionId}&fields=id,handle,*variants`,
  )) as { products?: MedusaProduct[] }
  const product = data.products?.[0]
  if (product === undefined) {
    throw new SeedCartWithItemsError(
      `no product with handle "${item.productHandle}" found — did the catalog seed run?`,
    )
  }
  const variants = product.variants ?? []
  const variant =
    item.variantTitle === undefined
      ? variants[0]
      : variants.find((v) => v.title === item.variantTitle)
  if (variant === undefined) {
    throw new SeedCartWithItemsError(
      `product "${item.productHandle}" has no variant` +
        (item.variantTitle === undefined ? "" : ` titled "${item.variantTitle}"`),
    )
  }
  return variant.id
}

export interface SeedCartWithItemsOptions {
  /** The EXACT chat sessionId the drive will POST under — the cart binds to THIS id. */
  readonly sessionId: string
  readonly items: readonly CartItemSpec[]
  /** Informational only (drive-log bookkeeping) — the binding is session-keyed. */
  readonly customerId?: string
  /** Redis TTL, seconds — mirrors the sibling seeders' 24h convention. */
  readonly ttlSeconds?: number
  readonly onProgress?: (line: string) => void
}

export interface SeedCartWithItemsResult {
  readonly cartId: string
  readonly itemCount: number
  readonly sessionId: string
  readonly customerId?: string
}

/**
 * Build a real Medusa cart carrying the requested items and bind it to
 * `sessionId` — the SCN-030 happy-path precondition (an active cart WITH
 * items for the session about to ask "o que tem no meu carrinho?").
 */
export async function seedCartWithItems(
  opts: SeedCartWithItemsOptions,
): Promise<SeedCartWithItemsResult> {
  const onProgress = opts.onProgress ?? (() => undefined)
  if (opts.items.length === 0) {
    throw new SeedCartWithItemsError("seedCartWithItems: items must be non-empty")
  }
  try {
    return await seedOnce(opts, onProgress)
  } catch (err) {
    if (err instanceof SeedCartWithItemsError) throw err
    // One bounded retry — the sibling seeders' transient-backoff rationale.
    onProgress(`  ⚠ cart seed attempt 1 failed (${(err as Error).message}) — retrying once after 3s`)
    await new Promise((r) => setTimeout(r, 3_000))
    return await seedOnce(opts, onProgress)
  }
}

async function seedOnce(
  opts: SeedCartWithItemsOptions,
  onProgress: (line: string) => void,
): Promise<SeedCartWithItemsResult> {
  const { medusaStore, getRedisClient, rk } = await import("@ibatexas/tools")

  const regionId = await resolveRegionId(medusaStore)

  const cartRes = (await medusaStore("/store/carts", {
    method: "POST",
    body: JSON.stringify({ region_id: regionId }),
  })) as { cart?: MedusaCart }
  const cartId = cartRes.cart?.id
  if (cartId === undefined) {
    throw new SeedCartWithItemsError("POST /store/carts returned no cart id")
  }

  let itemCount = 0
  for (const item of opts.items) {
    const variantId = await resolveVariantId(medusaStore, regionId, item)
    await medusaStore(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, quantity: item.quantity }),
    })
    itemCount++
  }

  const redis = await getRedisClient()
  const ttlSeconds = opts.ttlSeconds ?? 24 * 60 * 60
  await redis.set(rk(`cart:active:session:${opts.sessionId}`), cartId, { EX: ttlSeconds })

  onProgress(
    `  ✓ seeded cart ${cartId} (${itemCount} item entries) -> session ${opts.sessionId}`,
  )
  return {
    cartId,
    itemCount,
    sessionId: opts.sessionId,
    ...(opts.customerId === undefined ? {} : { customerId: opts.customerId }),
  }
}

// ── CLI entry point (ad-hoc/manual seeding, mirrors seed-item-cart.ts) ──

interface CliArgs {
  sessionId: string
  itemsSpec: string
  customerId?: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  let sessionId: string | undefined
  let itemsSpec: string | undefined
  let customerId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      i++
      return v
    }
    switch (a) {
      case "--session-id":
        sessionId = next()
        break
      case "--items":
        itemsSpec = next()
        break
      case "--customer-id":
        customerId = next()
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  if (sessionId === undefined) throw new Error("--session-id is required")
  if (itemsSpec === undefined) throw new Error("--items is required")
  return { sessionId, itemsSpec, customerId }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new SeedCartWithItemsError(
      "seed-cart-with-items refuses to run with NODE_ENV=production (it writes real cart rows)",
    )
  }
  const args = parseArgs(process.argv.slice(2))
  const result = await seedCartWithItems({
    sessionId: args.sessionId,
    items: parseItemsSpec(args.itemsSpec),
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
