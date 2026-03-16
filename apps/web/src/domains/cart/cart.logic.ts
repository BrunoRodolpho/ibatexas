/**
 * Cart domain — pure logic helpers.
 *
 * Extracted from cart.store.ts to keep the Zustand store thin.
 * All functions are pure with zero side effects.
 */
import type { ProductDTO, ProductVariant } from '@ibatexas/types'
import type { CartItem } from './cart.store'

// ── Variant Resolution ──────────────────────────────────────────────────

/** Pick the effective variant — explicit choice or first available. */
export function resolveVariant(
  product: ProductDTO,
  variant?: ProductVariant,
): ProductVariant | undefined {
  return variant ?? product.variants?.[0]
}

/** Build the composite cart item ID used for dedup. */
export function resolveCartItemId(productId: string, variantId?: string): string {
  return variantId ? `${productId}:${variantId}` : productId
}

// ── Item Construction ───────────────────────────────────────────────────

/** Build a new CartItem from a product + variant. Pure function. */
export function buildCartItem(
  product: ProductDTO,
  selectedVariant: ProductVariant | undefined,
  quantity: number,
  specialInstructions?: string,
): CartItem {
  return {
    id: resolveCartItemId(product.id, selectedVariant?.id),
    productId: product.id,
    title: product.title,
    price: selectedVariant?.price ?? product.price,
    imageUrl: product.imageUrl ?? undefined,
    quantity,
    specialInstructions,
    productType: product.productType,
    variantId: selectedVariant?.id ?? undefined,
    variantTitle: selectedVariant?.title ?? undefined,
  }
}

// ── Migration Pipeline ──────────────────────────────────────────────────

interface LegacyItem {
  id?: string
  productId?: string
  productType?: string
  variantId?: string
  [key: string]: unknown
}

/** v2 → v3: default existing items to "food" productType */
function migrateV2toV3(items: LegacyItem[]): LegacyItem[] {
  return items.map((item) => ({
    ...item,
    productType: item.productType ?? 'food',
  }))
}

/** v3 → v4: add productId field (was missing), ensure variantId exists */
function migrateV3toV4(items: LegacyItem[]): LegacyItem[] {
  return items.map((item) => ({
    ...item,
    productId: item.productId ?? item.id,
    variantId: item.variantId ?? undefined,
  }))
}

/**
 * Ordered migration pipeline. Each entry migrates FROM that version onward.
 * To add v4→v5: append `[4, migrateV4toV5]`.
 */
const MIGRATIONS: ReadonlyArray<[number, (items: LegacyItem[]) => LegacyItem[]]> = [
  [3, migrateV2toV3],
  [4, migrateV3toV4],
]

/**
 * Run all applicable migrations on persisted cart state.
 * Pure function — returns a new state object.
 */
export function migrateCartState(
  persistedState: unknown,
  fromVersion: number,
): Record<string, unknown> {
  const state: Record<string, unknown> = (persistedState ?? {}) as Record<string, unknown>
  if (!Array.isArray(state.items)) return state

  let items: LegacyItem[] = state.items as LegacyItem[]
  for (const [targetVersion, migrator] of MIGRATIONS) {
    if (fromVersion < targetVersion) {
      items = migrator(items)
    }
  }

  return { ...state, items }
}

// ── Cart Classification (extracted from cart.store.ts) ───────────────────

export type CartType = "food" | "merchandise" | "mixed" | "empty"

/** Classify items in a single pass with early break. Pure function. */
function classifyItems(items: ReadonlyArray<Pick<CartItem, 'productType'>>): { hasFood: boolean; hasMerch: boolean } {
  let hasFood = false
  let hasMerch = false
  for (const item of items) {
    if (item.productType === "food" || item.productType === "frozen") hasFood = true
    if (item.productType === "merchandise") hasMerch = true
    if (hasFood && hasMerch) break
  }
  return { hasFood, hasMerch }
}

/** Determine cart type from items. Pure function. */
export function getCartType(items: ReadonlyArray<Pick<CartItem, 'productType'>>): CartType {
  if (items.length === 0) return "empty"
  const { hasFood, hasMerch } = classifyItems(items)
  if (hasFood && hasMerch) return "mixed"
  if (hasMerch) return "merchandise"
  return "food"
}

/** Check if any items are merchandise. Pure function. */
export function hasMerchandise(items: ReadonlyArray<Pick<CartItem, 'productType'>>): boolean {
  return classifyItems(items).hasMerch
}

/** Check if any items are food or frozen. Pure function. */
export function hasFood(items: ReadonlyArray<Pick<CartItem, 'productType'>>): boolean {
  return classifyItems(items).hasFood
}
