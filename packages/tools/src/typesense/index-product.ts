// Index products into Typesense
// Called from Medusa subscribers on product create/update/delete

import { getTypesenseClient, COLLECTION } from "./client.js"
import { medusaToTypesenseDoc } from "../mappers/product-mapper.js"
import { generateEmbedding } from "../embeddings/client.js"

/**
 * Index (upsert) a single product into Typesense.
 * Generates and stores the embedding so vector search works.
 * If embedding fails, product is still indexed for keyword search.
 *
 * @param product — Raw Medusa product object
 * @param deps — Injectable dependencies (for testing without module mocking)
 */
export async function indexProduct(
  product: any,
  deps: { generateEmbedding?: typeof generateEmbedding } = {}
): Promise<void> {
  const typesenseClient = getTypesenseClient()
  const doc = medusaToTypesenseDoc(product) as any
  const embedFn = deps.generateEmbedding ?? generateEmbedding

  // Generate embedding for vector search
  // Fallback: index without embedding if API is unavailable (keyword search still works)
  try {
    const embeddingText = [product.title, product.description || ""].join(". ")
    doc.embedding = await embedFn(
      embeddingText,
      `product_embedding:${product.id}`,
      Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)
    )
  } catch (error) {
    console.warn(`[Typesense] Embedding generation failed for ${product.id} — indexing without embedding:`, error)
  }

  await typesenseClient.collections(COLLECTION).documents().upsert(doc)
  console.log(`[Typesense] Indexed: ${product.id} (${product.title})`)
}

/**
 * Delete a product from Typesense by ID.
 * Idempotent — ignores 404 (already deleted or never indexed).
 */
export async function deleteProductFromIndex(productId: string): Promise<void> {
  try {
    const typesenseClient = getTypesenseClient()
    await typesenseClient.collections(COLLECTION).documents(productId).delete()
    console.log(`[Typesense] Deleted from index: ${productId}`)
  } catch (error: any) {
    if (error.httpStatus === 404) {
      console.log(`[Typesense] Product not in index (already removed): ${productId}`)
      return
    }
    console.error(`[Typesense] Failed to delete product ${productId}:`, error)
    throw error
  }
}

/**
 * Batch index multiple products (e.g. after ibx db seed).
 * Uses Typesense import() API — single request for all docs.
 * Generates embeddings in parallel; failures are logged but don't abort the batch.
 */
export async function indexProductsBatch(
  products: any[],
  deps: { generateEmbedding?: typeof generateEmbedding } = {}
): Promise<void> {
  const embedFn = deps.generateEmbedding ?? generateEmbedding
  const ttl = Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)

  const docs = await Promise.all(
    products.map(async (product) => {
      const doc = medusaToTypesenseDoc(product) as any
      try {
        const embeddingText = [product.title, product.description || ""].join(". ")
        doc.embedding = await embedFn(embeddingText, `product_embedding:${product.id}`, ttl)
      } catch (error) {
        console.warn(`[Typesense] Embedding skipped for ${product.id}:`, error)
      }
      return doc
    })
  )

  const typesenseClient = getTypesenseClient()
  const results = await typesenseClient
    .collections(COLLECTION)
    .documents()
    .import(docs, { action: "upsert" }) as any[]

  const failures = results.filter((r) => !r.success)
  if (failures.length > 0) {
    console.error(`[Typesense] ${failures.length}/${docs.length} batch index failures:`, failures)
  }

  console.log(`[Typesense] Batch indexed ${docs.length - failures.length}/${docs.length} products`)
}
