// live/seed-checkout-cart.ts — FE-T12's cart-seeding CLI/library for
// `order.checkout.create` live calibration (team-lead ruling, cart-seeding
// investigation).
//
// CART↔SESSION BINDING (team-lead's own read of the production code): the
// customer↔cart binding is ONLY the Redis key
// `rk('cart:active:session:${sessionId}')` -> a real Medusa cart id
// (`@ibatexas/tools`'s `get-or-create-cart.ts` writes it;
// `resolve-and-assemble.ts`'s `loadCartCtx` reads it at
// `cart:active:session:${opts.sessionId}`). Medusa's own `customer_id`
// column stays null — the binding lives ENTIRELY in Redis, not in Medusa.
// So seeding a chat-checkout precondition is exactly two steps: (a) build a
// real Medusa cart with real line items via the RAW `medusaStore()` client
// (`@ibatexas/tools`) — the adjudicated wrapper
// (`medusaStoreAdjudicated`/`getOrCreateCart`) is SKIPPED here on purpose:
// this is dev tooling seeding PRECONDITION state, not a customer-authored
// mutation the kernel needs to adjudicate; (b) write that cart id under the
// EXACT `sessionId` the calibration case is about to drive under.
//
// INTERACTION WITH SESSION-PER-CASE ROTATION (accuracy-runner.ts): since
// `driveExtractionCorpusOverCustomerChat` mints a FRESH sessionId per case,
// the cart must be (re-)seeded for EACH case's own rotated id — this module
// exports `seedCheckoutCart` for exactly that purpose, wired as the
// driver's `beforeCase` hook (see accuracy-cli.ts's composition).
//
// CATALOG PRICE GRANULARITY (live finding): every seeded product price is a
// whole number of reais (no centavos component) — `MONEY_TARGETS_CENTAVOS`
// below therefore rounds the two odd-centavo money-boundary amounts the
// corpus documents (R$9999,99 and R$1000,01) to the nearest ACHIEVABLE
// whole-real total (R$9999,00 and R$1001,00) that preserves the SAME
// boundary-straddling relationship (still comfortably below the R$10000
// cap / comfortably above the R$1000 threshold, respectively) — this
// corpus's job is proving MODEL extraction correctness across the money
// bands, not pinpoint-testing the kernel's `>=` comparator (a pure,
// model-independent guard already covered elsewhere). Every OTHER
// documented target (R$1000,00 / R$10000,00 / R$15000,00 / R$3000,00 /
// R$50,00) is hit EXACTLY.
//
// SALES-CHANNEL BOOTSTRAP GOTCHA (live-caught, ephemeral-stack-scoped, not
// this ticket's to fix in committed seed/bootstrap code): the ephemeral
// test-stack's "Default Publishable API Key" was scoped to "Default Sales
// Channel", while the seeded product catalog is associated with "Loja
// Online" — `/store/products` therefore returned ZERO products until this
// was corrected (removed "Default Sales Channel" from the key, keeping it
// scoped to ONLY "Loja Online", so `POST /store/carts` with an EMPTY body —
// the SAME call shape `getOrCreateCart` uses in production — still resolves
// an unambiguous sales channel). This fix was applied via the ADMIN API
// directly against the running ephemeral stack (never a file/code change,
// never the main checkout) — if a fresh ephemeral stack bootstrap hits the
// same 400 ("multiple associated sales channels" or zero-products), rerun
// the fix: `POST /admin/api-keys/:id/sales-channels {"remove":["<default-channel-id>"]}`.
//
// pt-BR: operator output is en per the script idiom (CLAUDE.md rule #4
// governs customer-facing copy; this is a dev tool).

import { fileURLToPath } from "node:url"

/** Mirrors `medusaStore`'s cart/product response shapes we actually read (packages/tools). */
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
  readonly total?: number
  readonly items?: ReadonlyArray<{ readonly quantity: number }>
}

/** One line-item plan entry: a stable product HANDLE (never a raw variant
 *  ULID — those regenerate on every bootstrap) plus an optional variant
 *  TITLE match for multi-variant products, and the quantity to add. */
export interface CartLineItemPlanEntry {
  readonly productHandle: string
  readonly variantTitle?: string
  readonly quantity: number
}

/**
 * Every cart total this ticket's corpus needs, keyed by TARGET CENTAVOS —
 * the single source of truth both the corpus's documented SETUP notes and
 * this seeder read from (kept in sync by hand; see the module header for
 * the two rounded odd-centavo entries). All handles/quantities below were
 * VERIFIED by hand against the ephemeral stack's real catalog (see the PR
 * body) — quantities are large for some entries because every seeded
 * product price is a whole number of reais, and the CENTAVO-exact targets
 * (R$1000/R$10000/R$15000/R$3000) needed a specific combination to land
 * exactly; `manage_inventory: false` on every seeded variant means no stock
 * cap blocks a large quantity.
 */
export const CART_LINE_ITEM_PLANS: ReadonlyMap<number, readonly CartLineItemPlanEntry[]> = new Map([
  // R$50,00 — the "modest" total every register-diversity / PII-adversarial
  // / slots-incomplete case uses (comfortably under the R$1000 threshold).
  [5_000, [
    { productHandle: "refrigerante", quantity: 1 },
    { productHandle: "smash-burger-defumado", quantity: 1 },
  ]],
  // R$1000,00 EXACT — money-boundary-confirm-exact-threshold.
  [100_000, [
    { productHandle: "refrigerante", quantity: 125 },
  ]],
  // R$9999,00 (rounded from the corpus's documented R$9999,99 — see module
  // header) — money-boundary-confirm-just-below-refuse-cap.
  [999_900, [
    { productHandle: "kit-presente-ibatexas", quantity: 40 },
    { productHandle: "suco-do-dia", quantity: 1 },
    { productHandle: "refrigerante", quantity: 1 },
    { productHandle: "limonada-suica", variantTitle: "500ml", quantity: 1 },
  ]],
  // R$10000,00 EXACT — money-boundary-refuse-exact-cap.
  [1_000_000, [
    { productHandle: "kit-presente-ibatexas", quantity: 40 },
    { productHandle: "refrigerante", quantity: 5 },
  ]],
  // R$15000,00 EXACT — money-boundary-refuse-well-above-cap.
  [1_500_000, [
    { productHandle: "kit-presente-ibatexas", quantity: 60 },
    { productHandle: "smash-burger-defumado", quantity: 1 },
    { productHandle: "mandioca-frita", quantity: 1 },
  ]],
  // R$3000,00 EXACT — money-boundary-confirm-well-above-threshold.
  [300_000, [
    { productHandle: "kit-presente-ibatexas", quantity: 12 },
    { productHandle: "suco-do-dia", quantity: 1 },
  ]],
  // R$1001,00 (rounded from the corpus's documented R$1000,01 — see module
  // header) — money-boundary-confirm-just-above-threshold.
  [100_100, [
    { productHandle: "refrigerante", quantity: 118 },
    { productHandle: "limonada-suica", variantTitle: "500ml", quantity: 3 },
  ]],
])

/**
 * Case id -> target centavos (the single map `beforeCase` callers key off
 * of). The 6 money-boundary case ids map to their specific band-straddling
 * total; every OTHER case in the checkout corpus uses the modest R$50,00
 * default (register diversity / PII-adversarial / slots-incomplete never
 * need a specific total — only a NON-EMPTY cart).
 */
const MONEY_BOUNDARY_CASE_TARGETS: ReadonlyMap<string, number> = new Map([
  ["money-boundary-confirm-exact-threshold", 100_000],
  ["money-boundary-confirm-just-below-refuse-cap", 999_900],
  ["money-boundary-refuse-exact-cap", 1_000_000],
  ["money-boundary-refuse-well-above-cap", 1_500_000],
  ["money-boundary-confirm-well-above-threshold", 300_000],
  ["money-boundary-confirm-just-above-threshold", 100_100],
])
const DEFAULT_TARGET_CENTAVOS = 5_000

/** The target total (centavos) for a given corpus case id — the modest default unless the case is a named money-boundary one. */
export function targetCentavosForCase(caseId: string): number {
  return MONEY_BOUNDARY_CASE_TARGETS.get(caseId) ?? DEFAULT_TARGET_CENTAVOS
}

export class SeedCheckoutCartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SeedCheckoutCartError"
  }
}

async function resolveRegionId(medusaStore: typeof import("@ibatexas/tools").medusaStore): Promise<string> {
  const data = (await medusaStore("/store/regions")) as { regions?: Array<{ id: string }> }
  const regionId = data.regions?.[0]?.id
  if (regionId === undefined) {
    throw new SeedCheckoutCartError("no Medusa region found — is the commerce stack bootstrapped?")
  }
  return regionId
}

async function resolveVariantId(
  medusaStore: typeof import("@ibatexas/tools").medusaStore,
  regionId: string,
  entry: CartLineItemPlanEntry,
): Promise<string> {
  const data = (await medusaStore(
    `/store/products?handle=${entry.productHandle}&region_id=${regionId}&fields=id,handle,*variants`,
  )) as { products?: MedusaProduct[] }
  const product = data.products?.[0]
  if (product === undefined) {
    throw new SeedCheckoutCartError(
      `no product with handle "${entry.productHandle}" found — did the catalog seed run?`,
    )
  }
  const variants = product.variants ?? []
  const variant =
    entry.variantTitle === undefined
      ? variants[0]
      : variants.find((v) => v.title === entry.variantTitle)
  if (variant === undefined) {
    throw new SeedCheckoutCartError(
      `product "${entry.productHandle}" has no variant` +
        (entry.variantTitle === undefined ? "" : ` titled "${entry.variantTitle}"`),
    )
  }
  return variant.id
}

export interface SeedCheckoutCartOptions {
  /** The EXACT sessionId the calibration case is about to POST under — the cart is bound to THIS id, not customerId. */
  sessionId: string
  /** Target cart total in centavos — must be an EXACT sum of a plan in `CART_LINE_ITEM_PLANS` (see `targetCentavosForCase` for the corpus-case-id shortcut). */
  targetCentavos: number
  /** Redis TTL, seconds — mirrors `getOrCreateCart`'s own 24h convention. */
  ttlSeconds?: number
  onProgress?: (line: string) => void
}

export interface SeedCheckoutCartResult {
  readonly cartId: string
  readonly totalCentavos: number
}

/**
 * Builds a real Medusa cart at EXACTLY `targetCentavos` (via the plan in
 * `CART_LINE_ITEM_PLANS`) and binds it to `sessionId` in Redis — the
 * `order.checkout.create` precondition `requireCartItemsForCheckout` reads.
 * Throws (never silently drifts) if the plan doesn't exist for the target
 * or the resulting Medusa total doesn't match it exactly — a seeded cart
 * that's off by even one centavo would silently corrupt a money-boundary
 * case's outcome.
 */
export async function seedCheckoutCart(opts: SeedCheckoutCartOptions): Promise<SeedCheckoutCartResult> {
  const onProgress = opts.onProgress ?? (() => undefined)
  const plan = CART_LINE_ITEM_PLANS.get(opts.targetCentavos)
  if (plan === undefined) {
    throw new SeedCheckoutCartError(
      `no CART_LINE_ITEM_PLANS entry for ${opts.targetCentavos} centavos — add one (see this module's header)`,
    )
  }

  // Live-caught: a live calibration run twice crashed the ENTIRE multi-
  // hour pass on the very first `POST /auth/user/emailpass` this seeder
  // triggers, with Medusa returning a clean, well-formed 401 ("Invalid
  // email or password") — yet the SAME credentials succeeded on an
  // immediate, isolated retest seconds later. This is consistent with a
  // transient auth rate-limit/backoff window on Medusa's admin login (the
  // publishable-key resolution this seeder needs logs in as admin on every
  // COLD process — see `@ibatexas/tools`'s client.ts header — and this
  // session drove MANY cold processes against it while diagnosing the
  // sales-channel gotcha above), not a real credential problem. ONE bounded
  // retry with a short backoff is harness resilience for a transient infra
  // blip, not a governance workaround — `SeedCheckoutCartError` itself
  // (plan missing, total mismatch, product not found) is never retried,
  // only re-thrown immediately; only the underlying medusaStore/Redis call
  // chain gets the retry, and a SECOND failure still propagates loudly
  // (never silently swallowed — see the `beforeCase` hook's own "NOT
  // caught" contract in accuracy-runner.ts).
  try {
    return await seedCheckoutCartOnce(opts, plan, onProgress)
  } catch (err) {
    if (err instanceof SeedCheckoutCartError) throw err
    onProgress(`  ⚠ cart seed attempt 1 failed (${(err as Error).message}) — retrying once after 3s`)
    await new Promise((r) => setTimeout(r, 3_000))
    return await seedCheckoutCartOnce(opts, plan, onProgress)
  }
}

async function seedCheckoutCartOnce(
  opts: SeedCheckoutCartOptions,
  plan: readonly CartLineItemPlanEntry[],
  onProgress: (line: string) => void,
): Promise<SeedCheckoutCartResult> {
  const { medusaStore, getRedisClient, rk } = await import("@ibatexas/tools")

  const regionId = await resolveRegionId(medusaStore)

  // Explicit region_id (a DELIBERATE difference from production's
  // `getOrCreateCart`, which POSTs an empty body and relies entirely on the
  // publishable key resolving one unambiguous sales channel — see the
  // module header's sales-channel gotcha): a seeding script that must land
  // an EXACT total is worth the extra robustness of pinning the region
  // explicitly, independent of that key-scoping assumption ever drifting
  // again.
  const cartRes = (await medusaStore("/store/carts", {
    method: "POST",
    body: JSON.stringify({ region_id: regionId }),
  })) as { cart?: MedusaCart }
  const cartId = cartRes.cart?.id
  if (cartId === undefined) {
    throw new SeedCheckoutCartError("POST /store/carts returned no cart id")
  }

  let latestCart: MedusaCart | undefined
  for (const entry of plan) {
    const variantId = await resolveVariantId(medusaStore, regionId, entry)
    const lineItemRes = (await medusaStore(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      body: JSON.stringify({ variant_id: variantId, quantity: entry.quantity }),
    })) as { cart?: MedusaCart }
    latestCart = lineItemRes.cart
  }

  const totalReais = latestCart?.total ?? 0
  const totalCentavos = Math.round(totalReais * 100)
  if (totalCentavos !== opts.targetCentavos) {
    throw new SeedCheckoutCartError(
      `seeded cart ${cartId} totals ${totalCentavos} centavos, expected EXACTLY ${opts.targetCentavos} — ` +
        "the plan in CART_LINE_ITEM_PLANS no longer matches the live catalog prices (a seed/price drift), " +
        "never silently proceeding with a wrong total.",
    )
  }

  const redis = await getRedisClient()
  const ttlSeconds = opts.ttlSeconds ?? 24 * 60 * 60
  await redis.set(rk(`cart:active:session:${opts.sessionId}`), cartId, { EX: ttlSeconds })

  onProgress(
    `  ✓ seeded cart ${cartId} (R$${(totalCentavos / 100).toFixed(2)}) -> session ${opts.sessionId}`,
  )
  return { cartId, totalCentavos }
}

// ── CLI entry point (ad-hoc/manual seeding, mirrors seed-refundable-order.ts) ──

interface CliArgs {
  sessionId: string
  targetCentavos: number
}

function parseArgs(argv: readonly string[]): CliArgs {
  let sessionId: string | undefined
  let targetCentavos: number | undefined
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
      case "--target-centavos":
        targetCentavos = Number(next())
        break
      case "--target-reais":
        targetCentavos = Math.round(Number(next()) * 100)
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  if (sessionId === undefined) throw new Error("--session-id is required")
  return { sessionId, targetCentavos: targetCentavos ?? DEFAULT_TARGET_CENTAVOS }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new SeedCheckoutCartError(
      "seed-checkout-cart refuses to run with NODE_ENV=production (it writes real cart rows)",
    )
  }
  const args = parseArgs(process.argv.slice(2))
  const result = await seedCheckoutCart({
    sessionId: args.sessionId,
    targetCentavos: args.targetCentavos,
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
