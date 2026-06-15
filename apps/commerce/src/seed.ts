/**
 * Seed file — dev scaffold only.
 * Realistic Smoked House data to exercise agent, storefront, and admin.
 * The restaurant owner will edit/add real items via the admin panel at Step 7.
 *
 * Idempotent: safe to run repeatedly and, crucially, after `ibx db clean
 * --all` (which deletes Medusa products but leaves the store, sales channel,
 * region, categories and tags intact). Every entity is find-or-create, so a
 * reseed never throws on a duplicate (e.g. "Countries with codes 'br' are
 * already assigned to a region" or a category/tag unique-index violation).
 *
 * Run: pnpm --filter @ibatexas/commerce db:seed
 *   or: ibx db seed
 */

import type {
  ExecArgs,
  IProductModuleService,
  IPricingModuleService,
  IRegionModuleService,
  ISalesChannelModuleService,
  IStoreModuleService,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { indexProductsBatch, type MedusaProductInput } from "@ibatexas/tools"
import { CATEGORIES, SEED_PRODUCTS } from "./seed-data"

export default async function seed({ container }: ExecArgs) {
  const productModule =
    container.resolve<IProductModuleService>(Modules.PRODUCT)
  const pricingModule =
    container.resolve<IPricingModuleService>(Modules.PRICING)
  const remoteLink = container.resolve(ContainerRegistrationKeys.LINK)
  const storeModule =
    container.resolve<IStoreModuleService>(Modules.STORE)
  const regionModule =
    container.resolve<IRegionModuleService>(Modules.REGION)
  const salesChannelModule =
    container.resolve<ISalesChannelModuleService>(Modules.SALES_CHANNEL)

  console.log("🌱 Starting seed...")

  const STORE_NAME = "IbateXas Smoked House"
  const SALES_CHANNEL_NAME = "Loja Online"
  const REGION_NAME = "Brasil"

  // ── 0. Store, Sales Channel & Region (idempotent) ─────────────────────────
  // Required for the admin panel to show price-editing fields. `ibx db clean
  // --all` deletes only Medusa products — the store, sales channel and region
  // all survive. A blind create here would throw ("Countries with codes 'br'
  // are already assigned to a region", plus duplicate store/channel), so every
  // step is find-or-create.

  console.log("  Ensuring store, sales channel & region...")

  // Sales channel — find by name (only creates if none exist). NOTE: a Medusa
  // list* call with a filter but no `select` projects ONLY `id` — every other
  // field comes back undefined. We read `.name` below, so select it explicitly.
  const existingChannels = await salesChannelModule.listSalesChannels(
    { name: SALES_CHANNEL_NAME },
    { select: ["id", "name"] },
  )
  if (existingChannels.length > 1) {
    console.warn(
      `  ⚠ ${existingChannels.length} sales channels named "${SALES_CHANNEL_NAME}" — using the first; clean up duplicates (e.g. ibx db reset).`,
    )
  }
  const salesChannel =
    existingChannels[0] ??
    (await salesChannelModule.createSalesChannels([
      { name: SALES_CHANNEL_NAME, description: "Canal de vendas padrão", is_disabled: false },
    ]))[0]

  // Store — singleton. Reuse the existing one if present (a prior seed / Medusa
  // bootstrap leaves one behind) and point it at our sales channel; else create.
  const existingStores = await storeModule.listStores()
  if (existingStores.length > 1) {
    console.warn(
      `  ⚠ ${existingStores.length} stores exist — using the first; clean up duplicates (e.g. ibx db reset).`,
    )
  }
  const existingStore = existingStores[0]
  const store = existingStore
    ? await storeModule.updateStores(existingStore.id, {
        name: STORE_NAME,
        default_sales_channel_id: salesChannel.id,
      })
    : await storeModule.createStores({
        name: STORE_NAME,
        supported_currencies: [{ currency_code: "brl", is_default: true }],
        default_sales_channel_id: salesChannel.id,
      })

  // Region — find by COUNTRY OWNERSHIP, not name. Country "br" can belong to
  // exactly one region, and re-assigning it throws. A region owning "br" may
  // have been renamed in admin, so matching on name alone could miss it and
  // re-throw "Countries with codes 'br' are already assigned to a region".
  const allRegions = await regionModule.listRegions({}, { relations: ["countries"] })
  const regionOwningBr = allRegions.find((r) =>
    r.countries?.some((c) => c.iso_2 === "br"),
  )
  if (!regionOwningBr) {
    await regionModule.createRegions({
      name: REGION_NAME,
      currency_code: "brl",
      countries: ["br"],
    })
  }

  console.log(`  ✓ Store "${store.name}", sales channel & region ready`)

  // ── 1. Categories (idempotent by handle) ──────────────────────────────────
  // Category `handle` is unique (partial index where deleted_at IS NULL) and
  // categories survive `clean --all`, so we look up existing ones first and
  // only create the missing ones.

  console.log("  Ensuring categories...")

  const categoryMap = new Map<string, string>() // handle → id

  // `select` is REQUIRED here: a filtered list* projects only `id` otherwise,
  // so `cat.handle` would be undefined and every existing category missed.
  const existingCategories = await productModule.listProductCategories(
    { handle: CATEGORIES.map((c) => c.handle) },
    { select: ["id", "handle"] },
  )
  for (const cat of existingCategories) {
    if (cat.handle) categoryMap.set(cat.handle, cat.id)
  }

  // Root categories first (children reference their parent's id).
  const roots = CATEGORIES.filter((c) => c.parent === null)
  for (const root of roots) {
    if (categoryMap.has(root.handle)) continue
    const [created] = await productModule.createProductCategories([
      { name: root.name, handle: root.handle, is_active: true },
    ])
    categoryMap.set(root.handle, created.id)
  }

  // Children (parents now guaranteed in categoryMap).
  const children = CATEGORIES.filter((c): c is typeof c & { parent: string } => c.parent !== null)
  const missingChildren = children.filter((c) => !categoryMap.has(c.handle))
  if (missingChildren.length > 0) {
    const createdChildren = await productModule.createProductCategories(
      missingChildren.map((c) => {
        const parentId = categoryMap.get(c.parent)
        if (!parentId) {
          throw new Error(`Parent category '${c.parent}' not found for child '${c.handle}'`)
        }
        return {
          name: c.name,
          handle: c.handle,
          is_active: true,
          parent_category_id: parentId,
        }
      })
    )
    for (const child of createdChildren) {
      if (child.handle) categoryMap.set(child.handle, child.id)
    }
  }

  console.log(`  ✓ ${CATEGORIES.length} categories ready (${existingCategories.length} reused)`)

  // ── 2. Products (idempotent by handle) ────────────────────────────────────

  console.log("  Ensuring products...")

  // Tags — `value` is unique and tags survive `clean --all`. Find existing,
  // create only the missing values, then build value → id.
  const allTags = [...new Set(SEED_PRODUCTS.flatMap((p) => p.tags))]
  const tagMap = new Map<string, string>()
  // `select` required — a filtered list* projects only `id`, so without it
  // `t.value` is undefined and every existing tag is missed (then re-created → throws).
  const existingTags = await productModule.listProductTags(
    { value: allTags },
    { select: ["id", "value"] },
  )
  for (const t of existingTags) tagMap.set(t.value, t.id)
  const missingTagValues = allTags.filter((v) => !tagMap.has(v))
  if (missingTagValues.length > 0) {
    const createdTags = await productModule.createProductTags(
      missingTagValues.map((value) => ({ value }))
    )
    for (const t of createdTags) tagMap.set(t.value, t.id)
  }

  // Pre-existing products (by handle). `clean --all` deletes products, so on a
  // typical reseed none exist; but re-running `seed` without a clean (or the
  // tail beyond clean's 200-product cap) must not duplicate. A fully-seeded
  // product already carries its sales-channel link and prices, so the create
  // loop below skips it — re-creating the variant→price_set link would throw
  // "Cannot create multiple links". It is still reindexed below (upsert), and
  // any variants it is *missing* a price for get healed just below.
  // `select` required — a filtered list* projects only `id`, so without it
  // `p.handle` is undefined and existingProductByHandle is built with undefined keys.
  const existingProducts = await productModule.listProducts(
    { handle: SEED_PRODUCTS.map((p) => p.handle) },
    { select: ["id", "handle"] },
  )
  const existingProductByHandle = new Map(existingProducts.map((p) => [p.handle, p]))

  // Variant → price to link after creation: newly-created variants, plus any
  // reused-product variants the heal pass below finds without a price_set.
  const variantPrices: { variantId: string; amount: number }[] = []
  // Track every seeded product id (new + reused) for the post-link reindex pass.
  const allProductIds: string[] = []
  let createdCount = 0

  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // Heal pre-existing products that are missing prices — e.g. a crash-interrupted
  // prior seed left the product row but never linked a price_set. Such a product
  // would otherwise be skipped forever and reindexed at R$0. Re-price ONLY the
  // variants lacking a price_set link (fully-priced products are untouched, and
  // re-linking an already-linked variant throws "Cannot create multiple links").
  if (existingProducts.length > 0) {
    const { data: reusedGraph } = await query.graph({
      entity: "product",
      fields: ["handle", "variants.id", "variants.title", "variants.price_set.id"],
      filters: { id: existingProducts.map((p) => p.id) },
    })
    for (const p of reusedGraph as unknown as Array<{
      handle: string
      variants?: { id: string; title: string; price_set?: { id: string } | null }[]
    }>) {
      const seedProduct = SEED_PRODUCTS.find((s) => s.handle === p.handle)
      if (!seedProduct) continue
      for (const variant of p.variants ?? []) {
        if (variant.price_set) continue // already priced — leave it
        const seedVariant = seedProduct.variants.find((v) => v.title === variant.title)
        if (seedVariant) {
          variantPrices.push({ variantId: variant.id, amount: seedVariant.price })
        }
      }
    }
  }

  for (const product of SEED_PRODUCTS) {
    const already = existingProductByHandle.get(product.handle)
    if (already) {
      allProductIds.push(already.id)
      continue
    }

    const categoryId = categoryMap.get(product.categoryHandle)
    if (!categoryId) {
      throw new Error(`Category not found: ${product.categoryHandle}`)
    }

    const hasVariants = product.variants.length > 1

    const [createdProduct] = await productModule.createProducts([
      {
        title: product.title,
        handle: product.handle,
        description: product.description,
        status: "published" as const,
        // Medusa v2 uses category_ids (array of IDs), not categories objects
        category_ids: [categoryId],
        // Medusa v2 uses tag_ids (array of IDs), not tag objects
        tag_ids: product.tags.map((t) => tagMap.get(t)!).filter(Boolean),
        options: hasVariants
          ? [
              {
                title: "Variante",
                values: product.variants.map((v) => v.title),
              },
            ]
          : [],
        variants: product.variants.map((v) => ({
          title: v.title,
          manage_inventory: false,
          ...(hasVariants ? { options: { Variante: v.title } } : {}),
        })),
        metadata: { ...product.metadata, categoryHandle: product.categoryHandle },
      },
    ])

    allProductIds.push(createdProduct.id)
    createdCount++

    // Link product → sales channel via Remote Link (safe upsert; only run for
    // newly created products to keep the loop tight).
    await remoteLink.create([
      {
        [Modules.PRODUCT]: { product_id: createdProduct.id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannel.id },
      },
    ])

    for (const variant of createdProduct.variants ?? []) {
      const seedVariant = product.variants.find((v) => v.title === variant.title)
      if (seedVariant) {
        variantPrices.push({ variantId: variant.id, amount: seedVariant.price })
      }
    }
  }

  console.log(
    `  ✓ ${createdCount} products created, ${existingProducts.length} reused & linked to sales channel`
  )

  // ── 3. Create price sets and link to variants via Remote Link ─────────────
  // `variantPrices` holds newly-created variants plus any reused-product
  // variants the heal pass found without a price_set — every entry here is a
  // variant with NO existing price_set link, so linking can't throw
  // ("Cannot create multiple links between product_variant and price_set").

  console.log("  Creating prices...")

  for (const { variantId, amount } of variantPrices) {
    // Medusa v2 stores amount in main currency unit (reais), not centavos.
    // Our seed data uses centavos (CLAUDE.md convention), so divide by 100.
    const [priceSet] = await pricingModule.createPriceSets([
      {
        prices: [{ amount: amount / 100, currency_code: "brl" }],
      },
    ])

    // Medusa v2: link product variant → price set via the Remote Link module
    await remoteLink.create([
      {
        [Modules.PRODUCT]: { variant_id: variantId },
        [Modules.PRICING]: { price_set_id: priceSet.id },
      },
    ])
  }

  console.log(`  ✓ ${variantPrices.length} prices linked`)

  // ── 4. Reindex all seeded products with linked prices ────────────────────
  //
  // The product.created and pricing.price.created subscribers ran too early
  // during the create/link phases: at product.created no prices existed, and
  // at pricing.price.created no variant↔price_set link existed yet (the link
  // is created separately via remoteLink with no event). Without this pass,
  // Typesense ends up with every variant at price=0. Reindexing here, after
  // all links exist, pulls the full graph from remote query and writes the
  // correct prices. Covers newly-created and pre-existing products alike
  // (`indexProductsBatch` upserts), so a reseed after a Typesense wipe also
  // re-populates the index for products that survived.
  let reindexed = 0
  if (allProductIds.length > 0) {
    console.log("  Reindexing products with linked prices...")
    const { data: fullProducts } = await query.graph({
      entity: "product",
      fields: [
        "*",
        "variants.*",
        "variants.price_set.*",
        "variants.price_set.prices.*",
        "tags.*",
        "categories.*",
        "images.*",
      ],
      filters: { id: allProductIds },
    })
    await indexProductsBatch(fullProducts as unknown as MedusaProductInput[])
    reindexed = fullProducts.length
    console.log(`  ✓ ${reindexed} products reindexed with prices`)
  }

  console.log("\n✅ Seed complete!")
  console.log(`   Store      : ${store.name}`)
  console.log(`   Currency   : BRL (default)`)
  console.log(`   Region     : ${REGION_NAME}`)
  console.log(`   Sales Ch.  : ${salesChannel.name}`)
  console.log(`   Categories : ${CATEGORIES.length}`)
  console.log(`   Products   : ${allProductIds.length} (${createdCount} new, ${existingProducts.length} reused)`)
  console.log(`   Variants   : ${variantPrices.length} priced`)
  console.log("\n   Verify at http://localhost:9000/app → Products")
  console.log("   Edit prices at: Product → Variants → Pricing")
}
