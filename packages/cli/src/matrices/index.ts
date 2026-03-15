// matrices/index.ts — Matrix definitions for combinatorial UI state testing.
// Each matrix defines binary state variables with apply()/remove() functions
// and expectations that map variable combinations to UI section visibility.

import type { MatrixDefinition, StateVariable, MatrixExpectation } from "../lib/matrix.js"
import {
  fetchAllProductsWithTags,
  findOrCreateTag,
  updateProductTags,
  removeAllTagsFromAllProducts,
  findProductByHandle,
} from "../lib/medusa.js"
import { rk, getRedis, scanDelete, scanCount } from "../lib/redis.js"
import { StepRegistry } from "../lib/steps.js"

// ── Tag helpers ──────────────────────────────────────────────────────────────

/** Add a tag to a set of products by handle. */
async function applyTagToProducts(handles: string[], tagValue: string): Promise<void> {
  const tagId = await findOrCreateTag(tagValue)
  for (const handle of handles) {
    const product = await findProductByHandle(handle)
    if (!product) continue
    const existingIds = (product.tags ?? []).map((t) => t.id)
    if (!existingIds.includes(tagId)) {
      await updateProductTags(product.id, [...existingIds, tagId])
    }
  }
}

/** Remove a specific tag from ALL products. */
async function removeTagFromAllProducts(tagValue: string): Promise<void> {
  const products = await fetchAllProductsWithTags()
  for (const product of products) {
    const tags = product.tags ?? []
    const filtered = tags.filter((t) => t.value !== tagValue)
    if (filtered.length < tags.length) {
      await updateProductTags(product.id, filtered.map((t) => t.id))
    }
  }
}

// ── Homepage Matrix — 5 variables → 32 states ──────────────────────────────

const POPULAR_HANDLES = [
  "costela-bovina-defumada",
  "pulled-pork",
  "frango-defumado-inteiro",
  "barriga-de-porco-defumada",
  "smash-burger-defumado",
  "linguica-artesanal-defumada",
]

const CHEF_CHOICE_HANDLES = [
  "brisket-americano",
  "costela-bovina-defumada",
]

const homepageVariables: StateVariable[] = [
  {
    name: "popularProducts",
    description: "Products tagged popular (Em Alta section)",
    apply: () => applyTagToProducts(POPULAR_HANDLES, "popular"),
    remove: () => removeTagFromAllProducts("popular"),
  },
  {
    name: "chefChoiceProducts",
    description: "Products tagged chef_choice (Pitmaster section)",
    apply: () => applyTagToProducts(CHEF_CHOICE_HANDLES, "chef_choice"),
    remove: () => removeTagFromAllProducts("chef_choice"),
  },
  {
    name: "reviewsPresent",
    description: "Reviews in database (HomeReviews section)",
    apply: async () => {
      await StepRegistry["seed-homepage"].run()
      await StepRegistry["sync-reviews"].run()
    },
    remove: async () => {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.review.deleteMany()
      // Reset Typesense rating/reviewCount so stale data doesn't persist
      try {
        const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
        const ts = getTypesenseClient()
        const products = await fetchAllProductsWithTags()
        for (const product of products) {
          try {
            await ts.collections(COLLECTION).documents(product.id).update({ rating: 0, reviewCount: 0 })
          } catch { /* skip — product may not be indexed */ }
        }
      } catch { /* Typesense unavailable */ }
      await prisma.$disconnect()
    },
  },
  {
    name: "ordersPresent",
    description: "Order history (Mais Pedidos via global score)",
    apply: async () => {
      await StepRegistry["seed-orders"].run()
      await StepRegistry["intel-global-score"].run()
    },
    remove: async () => {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.customerOrderItem.deleteMany()
      const redis = await getRedis()
      await redis.del(rk("product:global:score"))
      await prisma.$disconnect()
    },
  },
  {
    name: "copurchasePresent",
    description: "Co-purchase relations (Also Added on PDP)",
    apply: async () => {
      await StepRegistry["intel-copurchase"].run()
    },
    remove: async () => {
      const redis = await getRedis()
      await scanDelete(redis, rk("copurchase:*"))
    },
  },
]

const homepageExpectations: MatrixExpectation[] = [
  {
    section: "Em Alta",
    requires: ["popularProducts"],
    severity: "error",
    check: async () => {
      const products = await fetchAllProductsWithTags()
      const count = products.filter((p) => p.tags?.some((t) => t.value === "popular")).length
      return { ok: count > 0, detail: `${count} products with popular tag` }
    },
  },
  {
    section: "Pitmaster Recomenda",
    requires: ["chefChoiceProducts"],
    severity: "error",
    check: async () => {
      const products = await fetchAllProductsWithTags()
      const count = products.filter((p) => p.tags?.some((t) => t.value === "chef_choice")).length
      return { ok: count > 0, detail: `${count} products with chef_choice tag` }
    },
  },
  {
    section: "HomeReviews",
    requires: ["reviewsPresent"],
    severity: "error",
    check: async () => {
      const { prisma } = await import("@ibatexas/domain")
      const count = await prisma.review.count({ where: { rating: { gte: 4 }, comment: { not: null } } })
      await prisma.$disconnect()
      return { ok: count > 0, detail: `${count} reviews with rating≥4 + comment` }
    },
  },
  {
    section: "Mais Pedidos",
    requires: ["ordersPresent"],
    severity: "error",
    check: async () => {
      const redis = await getRedis()
      const count = await redis.zCard(rk("product:global:score"))
      return { ok: count > 0, detail: `${count} products in global score` }
    },
  },
  {
    section: "Also Added (PDP)",
    requires: ["copurchasePresent"],
    severity: "warning",
    check: async () => {
      const redis = await getRedis()
      const count = await scanCount(redis, rk("copurchase:*"))
      return { ok: count > 0, detail: `${count} copurchase relations` }
    },
  },
]

// ── Search Matrix — 4 variables → 16 states ────────────────────────────────

const searchVariables: StateVariable[] = [
  {
    name: "popularProducts",
    description: "Products tagged popular (Em Alta section)",
    apply: () => applyTagToProducts(POPULAR_HANDLES, "popular"),
    remove: () => removeTagFromAllProducts("popular"),
  },
  {
    name: "chefChoiceProducts",
    description: "Products tagged chef_choice (Pitmaster Pick)",
    apply: () => applyTagToProducts(CHEF_CHOICE_HANDLES, "chef_choice"),
    remove: () => removeTagFromAllProducts("chef_choice"),
  },
  {
    name: "ordersPresent",
    description: "Global scores exist (Mais Pedidos)",
    apply: async () => {
      await StepRegistry["seed-orders"].run()
      await StepRegistry["intel-global-score"].run()
    },
    remove: async () => {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.customerOrderItem.deleteMany()
      const redis = await getRedis()
      await redis.del(rk("product:global:score"))
      await prisma.$disconnect()
    },
  },
  {
    name: "productsIndexed",
    description: "Products indexed in Typesense (Categorias)",
    apply: async () => {
      await StepRegistry["reindex"].run()
    },
    remove: async () => {
      // Drop the Typesense collection
      try {
        const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
        const ts = getTypesenseClient()
        await ts.collections(COLLECTION).delete()
      } catch { /* may not exist */ }
    },
  },
]

const searchExpectations: MatrixExpectation[] = [
  {
    section: "Pitmaster Pick",
    requires: ["chefChoiceProducts"],
    severity: "error",
    check: async () => {
      const products = await fetchAllProductsWithTags()
      const count = products.filter((p) => p.tags?.some((t) => t.value === "chef_choice")).length
      return { ok: count > 0, detail: `${count} products with chef_choice` }
    },
  },
  {
    section: "Em Alta",
    requires: ["popularProducts"],
    severity: "error",
    check: async () => {
      const products = await fetchAllProductsWithTags()
      const count = products.filter((p) => p.tags?.some((t) => t.value === "popular")).length
      return { ok: count > 0, detail: `${count} products with popular` }
    },
  },
  {
    section: "Mais Pedidos",
    requires: ["ordersPresent"],
    severity: "error",
    check: async () => {
      const redis = await getRedis()
      const count = await redis.zCard(rk("product:global:score"))
      return { ok: count > 0, detail: `${count} products in global score` }
    },
  },
  {
    section: "Categorias",
    requires: ["productsIndexed"],
    severity: "error",
    check: async () => {
      try {
        const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
        const ts = getTypesenseClient()
        const info = await ts.collections(COLLECTION).retrieve()
        const count = info.num_documents ?? 0
        return { ok: count > 0, detail: `${count} products indexed` }
      } catch {
        return { ok: false, detail: "Typesense collection not found" }
      }
    },
  },
]

// ── Product (PDP) Matrix — 4 variables → 16 states ─────────────────────────

const productVariables: StateVariable[] = [
  {
    name: "reviewsPresent",
    description: "Product has reviews (rating display)",
    apply: async () => {
      await StepRegistry["seed-homepage"].run()
      await StepRegistry["sync-reviews"].run()
    },
    remove: async () => {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.review.deleteMany()
      await prisma.$disconnect()
    },
  },
  {
    name: "copurchasePresent",
    description: "Co-purchase data exists (Also Added section)",
    apply: async () => {
      await StepRegistry["intel-copurchase"].run()
    },
    remove: async () => {
      const redis = await getRedis()
      await scanDelete(redis, rk("copurchase:*"))
    },
  },
  {
    name: "globalScorePresent",
    description: "Global scores exist (popularity ranking)",
    apply: async () => {
      await StepRegistry["intel-global-score"].run()
    },
    remove: async () => {
      const redis = await getRedis()
      await redis.del(rk("product:global:score"))
    },
  },
  {
    name: "tagsPresent",
    description: "Product has tags (tag badges displayed)",
    apply: () => applyTagToProducts(["brisket-americano"], "popular"),
    remove: async () => { await removeAllTagsFromAllProducts() },
  },
]

const productExpectations: MatrixExpectation[] = [
  {
    section: "Product Reviews",
    requires: ["reviewsPresent"],
    severity: "error",
    check: async () => {
      const { prisma } = await import("@ibatexas/domain")
      const count = await prisma.review.count()
      await prisma.$disconnect()
      return { ok: count > 0, detail: `${count} reviews` }
    },
  },
  {
    section: "Also Added",
    requires: ["copurchasePresent"],
    severity: "warning",
    check: async () => {
      const redis = await getRedis()
      const count = await scanCount(redis, rk("copurchase:*"))
      return { ok: count > 0, detail: `${count} copurchase relations` }
    },
  },
  {
    section: "Global Score",
    requires: ["globalScorePresent"],
    severity: "warning",
    check: async () => {
      const redis = await getRedis()
      const count = await redis.zCard(rk("product:global:score"))
      return { ok: count > 0, detail: `${count} products scored` }
    },
  },
  {
    section: "Tag Badges",
    requires: ["tagsPresent"],
    severity: "warning",
    check: async () => {
      const products = await fetchAllProductsWithTags()
      const withTags = products.filter((p) => (p.tags ?? []).length > 0).length
      return { ok: withTags > 0, detail: `${withTags} products with tags` }
    },
  },
]

// ── Intelligence Matrix — 4 variables → 16 states ──────────────────────────

const intelVariables: StateVariable[] = [
  {
    name: "ordersPresent",
    description: "Order history exists",
    apply: async () => {
      await StepRegistry["seed-orders"].run()
    },
    remove: async () => {
      const { prisma } = await import("@ibatexas/domain")
      await prisma.customerOrderItem.deleteMany()
      await prisma.$disconnect()
    },
  },
  {
    name: "copurchaseBuilt",
    description: "Co-purchase matrix has been rebuilt",
    apply: async () => {
      await StepRegistry["intel-copurchase"].run()
    },
    remove: async () => {
      const redis = await getRedis()
      await scanDelete(redis, rk("copurchase:*"))
    },
  },
  {
    name: "globalScoreBuilt",
    description: "Global scores have been rebuilt",
    apply: async () => {
      await StepRegistry["intel-global-score"].run()
    },
    remove: async () => {
      const redis = await getRedis()
      await redis.del(rk("product:global:score"))
    },
  },
  {
    name: "reviewStatsSync",
    description: "Review stats synced to Typesense",
    apply: async () => {
      await StepRegistry["sync-reviews"].run()
    },
    remove: async () => {
      // Reset Typesense rating fields
      try {
        const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
        const ts = getTypesenseClient()
        const products = await fetchAllProductsWithTags()
        for (const product of products) {
          try {
            await ts.collections(COLLECTION).documents(product.id).update({ rating: 0, reviewCount: 0 })
          } catch { /* skip */ }
        }
      } catch { /* Typesense unavailable */ }
    },
  },
]

const intelExpectations: MatrixExpectation[] = [
  {
    section: "Order Data",
    requires: ["ordersPresent"],
    severity: "error",
    check: async () => {
      const { prisma } = await import("@ibatexas/domain")
      const count = await prisma.customerOrderItem.count()
      await prisma.$disconnect()
      return { ok: count > 0, detail: `${count} order items` }
    },
  },
  {
    section: "Copurchase Matrix",
    requires: ["copurchaseBuilt"],
    severity: "error",
    check: async () => {
      const redis = await getRedis()
      const count = await scanCount(redis, rk("copurchase:*"))
      return { ok: count > 0, detail: `${count} copurchase keys` }
    },
  },
  {
    section: "Global Scores",
    requires: ["globalScoreBuilt"],
    severity: "error",
    check: async () => {
      const redis = await getRedis()
      const count = await redis.zCard(rk("product:global:score"))
      return { ok: count > 0, detail: `${count} products scored` }
    },
  },
  {
    section: "Review Stats",
    requires: ["reviewStatsSync"],
    severity: "warning",
    check: async () => {
      try {
        const { getTypesenseClient, COLLECTION } = await import("@ibatexas/tools")
        const ts = getTypesenseClient()
        const results = await ts.collections(COLLECTION).documents().search({
          q: "*",
          query_by: "title",
          filter_by: "reviewCount:>0",
          per_page: 1,
        })
        const count = results.found ?? 0
        return { ok: count > 0, detail: `${count} products with review stats` }
      } catch {
        return { ok: false, detail: "Typesense unavailable" }
      }
    },
  },
]

// ── Registry ─────────────────────────────────────────────────────────────────

export const MATRIX_DEFINITIONS: Record<string, MatrixDefinition> = {
  homepage: {
    name: "homepage",
    description: "Homepage UI sections — 5 variables → 32 states",
    category: "ui",
    baseSetup: ["seed-products", "reindex", "seed-domain"],
    variables: homepageVariables,
    expectations: homepageExpectations,
  },
  search: {
    name: "search",
    description: "Search browse mode — 4 variables → 16 states",
    category: "ui",
    baseSetup: ["seed-products"],
    variables: searchVariables,
    expectations: searchExpectations,
  },
  product: {
    name: "product",
    description: "Product detail page (PDP) — 4 variables → 16 states",
    category: "ui",
    baseSetup: ["seed-products", "reindex", "seed-domain", "seed-orders"],
    variables: productVariables,
    expectations: productExpectations,
  },
  intel: {
    name: "intel",
    description: "Intelligence layer — 4 variables → 16 states",
    category: "intel",
    baseSetup: ["seed-products", "reindex", "seed-domain", "seed-homepage", "seed-orders"],
    variables: intelVariables,
    expectations: intelExpectations,
  },
}

export const MATRIX_NAMES = Object.keys(MATRIX_DEFINITIONS)
