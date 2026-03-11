// lib/medusa.ts — shared Medusa admin API helpers.
// Extracted from db.ts, test.ts, tag.ts, api.ts to eliminate duplication.
// All Medusa-facing CLI code should import from this module.

import chalk from "chalk"

// ── Types ────────────────────────────────────────────────────────────────────

export interface MedusaTag {
  id: string
  value: string
}

export interface MedusaProduct {
  id: string
  title: string
  handle: string
  status?: string
  tags?: MedusaTag[]
  categories?: { name: string; id: string }[]
  variants?: unknown[]
}

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Read the Medusa backend URL from `MEDUSA_BACKEND_URL`.
 * Exits with code 1 if not set.
 */
export function getMedusaUrl(): string {
  const url = process.env.MEDUSA_BACKEND_URL
  if (!url) {
    console.error(chalk.red("MEDUSA_BACKEND_URL is not set. Run: ibx env check"))
    process.exit(1)
  }
  return url
}

/** Module-level cache — one auth per CLI invocation is enough. */
let _adminToken: string | null = null

/**
 * Authenticate with the Medusa admin API and cache the token for this CLI run.
 * Reads credentials from `MEDUSA_ADMIN_EMAIL` / `MEDUSA_ADMIN_PASSWORD`.
 */
export async function getAdminToken(): Promise<string> {
  if (_adminToken) return _adminToken
  const base = getMedusaUrl()
  const email = process.env.MEDUSA_ADMIN_EMAIL ?? "REDACTED_EMAIL"
  const password = process.env.MEDUSA_ADMIN_PASSWORD ?? "REDACTED_PASSWORD"

  const res = await fetch(`${base}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Admin auth failed (${res.status}): ${text}\n` +
      `Set MEDUSA_ADMIN_EMAIL and MEDUSA_ADMIN_PASSWORD or create an admin user:\n` +
      `  npx medusa user --email REDACTED_EMAIL --password 'REDACTED_PASSWORD'`,
    )
  }

  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error("Admin auth response missing token")
  _adminToken = data.token
  return _adminToken
}

/** Reset the cached admin token (useful in tests). */
export function resetAdminToken(): void {
  _adminToken = null
}

// ── Generic Medusa fetch ────────────────────────────────────────────────────

interface MedusaFetchOptions {
  method?: string
  body?: unknown
  token?: string
}

/**
 * Typed wrapper around `fetch` for the Medusa admin API.
 *
 * - Auto-authenticates if no `token` is provided in opts
 * - Logs HTTP calls when `IBX_DEBUG_HTTP=true`
 * - Returns parsed JSON cast to `T`
 */
export async function medusaFetch<T = Record<string, unknown>>(
  path: string,
  opts?: MedusaFetchOptions,
): Promise<T> {
  const base = getMedusaUrl()
  const token = opts?.token ?? (await getAdminToken())
  const method = opts?.method ?? "GET"

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }

  const init: RequestInit = { method, headers }
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body)
  }

  if (process.env.IBX_DEBUG_HTTP) {
    console.error(chalk.dim(`  MEDUSA ${method} ${path}`))
  }

  const res = await fetch(`${base}${path}`, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Medusa API ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

export const ALLOWED_TAGS = [
  "popular",
  "chef_choice",
  "sem_gluten",
  "sem_lactose",
  "vegano",
  "vegetariano",
  "novo",
  "congelado",
  "defumado",
  "exclusivo",
  "edicao_limitada",
  "kit",
] as const

export type AllowedTag = (typeof ALLOWED_TAGS)[number]

export function validateTag(tag: string): tag is AllowedTag {
  return (ALLOWED_TAGS as readonly string[]).includes(tag)
}

export function printAllowedTags(): void {
  console.log(chalk.yellow("\n  Allowed tags:\n"))
  for (const t of ALLOWED_TAGS) {
    console.log(`    ${chalk.cyan(t)}`)
  }
  console.log()
}

/**
 * Look up a product by its handle via the Medusa admin API.
 * Returns `null` if no product matches.
 */
export async function findProductByHandle(
  handle: string,
  token?: string,
): Promise<MedusaProduct | null> {
  const tkn = token ?? (await getAdminToken())
  const data = await medusaFetch<{ products?: MedusaProduct[] }>(
    `/admin/products?handle=${encodeURIComponent(handle)}&fields=id,title,handle,*tags`,
    { token: tkn },
  )
  const products = data.products ?? []
  return products.find((p) => p.handle === handle) ?? null
}

/**
 * Find an existing product tag by value, or create it if missing.
 * Returns the tag's Medusa ID.
 */
export async function findOrCreateTag(
  tagValue: string,
  token?: string,
): Promise<string> {
  const tkn = token ?? (await getAdminToken())
  const base = getMedusaUrl()

  // Search for existing tag
  const searchRes = await fetch(
    `${base}/admin/product-tags?value=${encodeURIComponent(tagValue)}`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tkn}`,
      },
    },
  )

  if (searchRes.ok) {
    const data = (await searchRes.json()) as { product_tags?: MedusaTag[] }
    const existing = (data.product_tags ?? []).find((t) => t.value === tagValue)
    if (existing) return existing.id
  }

  // Create the tag
  const createRes = await fetch(`${base}/admin/product-tags`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tkn}`,
    },
    body: JSON.stringify({ value: tagValue }),
  })

  if (!createRes.ok) {
    throw new Error(`Failed to create tag "${tagValue}" (${createRes.status})`)
  }

  const created = (await createRes.json()) as { product_tag?: MedusaTag }
  if (!created.product_tag?.id) throw new Error("Tag creation response missing id")
  return created.product_tag.id
}

/**
 * Replace the full tag list for a product.
 * `tagIds` is the complete set — any tag not in the list is removed.
 *
 * Medusa v2 REST API expects `tags` as `{ id: string }[]`, not `tag_ids`.
 */
export async function updateProductTags(
  productId: string,
  tagIds: string[],
  token?: string,
): Promise<void> {
  const tkn = token ?? (await getAdminToken())
  await medusaFetch(`/admin/products/${productId}`, {
    method: "POST",
    body: { tags: tagIds.map((id) => ({ id })) },
    token: tkn,
  })
}

/**
 * Fetch all products (paginated) with their tag associations.
 */
export async function fetchAllProductsWithTags(
  token?: string,
): Promise<MedusaProduct[]> {
  const tkn = token ?? (await getAdminToken())
  const allProducts: MedusaProduct[] = []
  let offset = 0
  const limit = 100

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await medusaFetch<{ products?: MedusaProduct[] }>(
      `/admin/products?limit=${limit}&offset=${offset}&fields=id,title,handle,*tags`,
      { token: tkn },
    )
    const products = data.products ?? []
    allProducts.push(...products)
    if (products.length < limit) break
    offset += limit
  }

  return allProducts
}

/**
 * Remove a single tag from a product by handle.
 * No-op if the product doesn't have the tag.
 */
export async function removeTagFromProduct(
  handle: string,
  tagValue: string,
  token?: string,
): Promise<void> {
  const tkn = token ?? (await getAdminToken())
  const product = await findProductByHandle(handle, tkn)
  if (!product) throw new Error(`Product "${handle}" not found`)

  const existingTags = product.tags ?? []
  const tagToRemove = existingTags.find((t) => t.value === tagValue)
  if (!tagToRemove) return // tag not present — nothing to do

  const filteredIds = existingTags
    .filter((t) => t.id !== tagToRemove.id)
    .map((t) => t.id)

  await updateProductTags(product.id, filteredIds, tkn)
}

/**
 * Remove ALL tags from ALL products.
 * Used by scenario cleanup `reset-tags` action.
 */
export async function removeAllTagsFromAllProducts(
  token?: string,
): Promise<number> {
  const tkn = token ?? (await getAdminToken())
  const products = await fetchAllProductsWithTags(tkn)
  const withTags = products.filter((p) => p.tags && p.tags.length > 0)

  for (const product of withTags) {
    await updateProductTags(product.id, [], tkn)
  }

  return withTags.length
}
