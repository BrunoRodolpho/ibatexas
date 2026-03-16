/**
 * Seed file — dev scaffold only.
 * Realistic Smoked House data to exercise agent, storefront, and admin.
 * The restaurant owner will edit/add real items via the admin panel at Step 7.
 *
 * Run: pnpm --filter @ibatexas/commerce db:seed
 *   or: ibx db seed
 */

import type { ExecArgs } from "@medusajs/framework/types"
import type {
  IProductModuleService,
  IPricingModuleService,
  IRegionModuleService,
  ISalesChannelModuleService,
  IStoreModuleService,
} from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { CATEGORIES, SEED_PRODUCTS } from "./seed-data"

export default async function ({ container }: ExecArgs) {
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

  // ── 0. Store, Sales Channel & Region ──────────────────────────────────
  // These are required for the admin panel to show price editing fields.

  console.log("  Creating store, sales channel & region...")

  const [salesChannel] = await salesChannelModule.createSalesChannels([
    { name: "Loja Online", description: "Canal de vendas padrão", is_disabled: false },
  ])

  const store = await storeModule.createStores({
    name: "IbateXas Smoked House",
    supported_currencies: [
      { currency_code: "brl", is_default: true },
    ],
    default_sales_channel_id: salesChannel.id,
  })

  await regionModule.createRegions({
    name: "Brasil",
    currency_code: "brl",
    countries: ["br"],
  })

  console.log(`  ✓ Store "${store.name}", sales channel & region created`)

  // ── 1. Create categories ─────────────────────────────────────────────────

  console.log("  Creating categories...")

  const categoryMap = new Map<string, string>() // handle → id

  // Root categories first (there can be multiple, e.g. restaurante + loja)
  const roots = CATEGORIES.filter((c) => c.parent === null)
  for (const root of roots) {
    const [created] = await productModule.createProductCategories([
      { name: root.name, handle: root.handle, is_active: true },
    ])
    categoryMap.set(root.handle, created.id)
  }

  // Children (parents already in categoryMap)
  const children = CATEGORIES.filter((c): c is typeof c & { parent: string } => c.parent !== null)
  const createdChildren = await productModule.createProductCategories(
    children.map((c) => {
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
    categoryMap.set(child.handle, child.id)
  }

  console.log(`  ✓ ${CATEGORIES.length} categories created`)

  // ── 2. Create products (without prices) ─────────────────────────────────

  console.log("  Creating products...")

  // Collect all unique tags across all products
  const allTags = [...new Set(SEED_PRODUCTS.flatMap((p) => p.tags))]
  const createdTags = await productModule.createProductTags(
    allTags.map((value) => ({ value }))
  )
  const tagMap = new Map<string, string>(
    createdTags.map((t) => [t.value, t.id])
  )

  // Track variant → price for linking after creation
  const variantPrices: { variantId: string; amount: number }[] = []

  for (const product of SEED_PRODUCTS) {
    const categoryId = categoryMap.get(product.categoryHandle)
    if (!categoryId) {
      throw new Error(`Category not found: ${product.categoryHandle}`)
    }

    const hasVariants = product.variants.length > 1

    const created = await productModule.createProducts([
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

    const createdProduct = created[0]

    // Link product → sales channel via Remote Link
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

  console.log(`  ✓ ${SEED_PRODUCTS.length} products created & linked to sales channel`)

  // ── 3. Create price sets and link to variants via Remote Link ─────────────

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

  console.log("\n✅ Seed complete!")
  console.log(`   Store      : ${store.name}`)
  console.log(`   Currency   : BRL (default)`)
  console.log(`   Region     : Brasil`)
  console.log(`   Sales Ch.  : ${salesChannel.name}`)
  console.log(`   Categories : ${CATEGORIES.length}`)
  console.log(`   Products   : ${SEED_PRODUCTS.length}`)
  console.log(`   Variants   : ${variantPrices.length}`)
  console.log("\n   Verify at http://localhost:9000/app → Products")
  console.log("   Edit prices at: Product → Variants → Pricing")
}
