// Index products into Typesense
// Called from Medusa subscribers on product create/update/delete

import { medusaToTypesenseDoc, type MedusaProductInput, type TypesenseProductDoc } from "../mappers/product-mapper.js"
import { generateEmbedding } from "../embeddings/client.js"
import { rk } from "../redis/key.js"
import { getTypesenseClient, COLLECTION } from "./client.js"
import { isTypesenseError, type TypesenseImportResult } from "./types.js"

/**
 * Index (upsert) a single product into Typesense.
 * Generates and stores the embedding so vector search works.
 * If embedding fails, product is still indexed for keyword search.
 *
 * @param product — Raw Medusa product object
 * @param deps — Injectable dependencies (for testing without module mocking)
 */
export async function indexProduct(
  product: MedusaProductInput,
  deps: { generateEmbedding?: typeof generateEmbedding } = {}
): Promise<void> {
  const typesenseClient = getTypesenseClient()
  const doc: TypesenseProductDoc & { embedding?: number[] } = medusaToTypesenseDoc(product)
  const embedFn = deps.generateEmbedding ?? generateEmbedding

  // Generate embedding for vector search
  // Fallback: index without embedding if API is unavailable (keyword search still works)
  try {
    const embeddingText = [product.title, product.description || ""].join(". ")
    doc.embedding = await embedFn(
      embeddingText,
      rk(`product_embedding:${product.id}`),
      Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)
    )
  } catch (error) {
    console.warn(`[Typesense] Embedding generation failed for ${product.id} — indexing without embedding:`, (error as Error).message)
  }

  await typesenseClient.collections(COLLECTION).documents().upsert(doc)
  console.warn(`[Typesense] Indexed: ${product.id} (${product.title})`)
}

/**
 * Delete a product from Typesense by ID.
 * Idempotent — ignores 404 (already deleted or never indexed).
 */
export async function deleteProductFromIndex(productId: string): Promise<void> {
  try {
    const typesenseClient = getTypesenseClient()
    await typesenseClient.collections(COLLECTION).documents(productId).delete()
    console.warn(`[Typesense] Deleted from index: ${productId}`)
  } catch (err: unknown) {
    if (isTypesenseError(err) && err.httpStatus === 404) {
      console.warn(`[Typesense] Product not in index (already removed): ${productId}`)
      return
    }
    console.error(`[Typesense] Failed to delete product ${productId}:`, (err as Error).message)
    throw err
  }
}

/**
 * Batch index multiple products (e.g. after ibx db seed).
 * Uses Typesense import() API — single request for all docs.
 * Generates embeddings in parallel; failures are logged but don't abort the batch.
 */
export async function indexProductsBatch(
  products: MedusaProductInput[],
  deps: { generateEmbedding?: typeof generateEmbedding } = {}
): Promise<void> {
  const embedFn = deps.generateEmbedding ?? generateEmbedding
  const ttl = Number.parseInt(process.env.EMBEDDINGS_CACHE_TTL_SECONDS || "2592000", 10)

  const docs = await Promise.all(
    products.map(async (product) => {
      const doc: TypesenseProductDoc & { embedding?: number[] } = medusaToTypesenseDoc(product)
      try {
        const embeddingText = [product.title, product.description || ""].join(". ")
        doc.embedding = await embedFn(embeddingText, rk(`product_embedding:${product.id}`), ttl)
      } catch (error) {
        console.warn(`[Typesense] Embedding skipped for ${product.id}:`, (error as Error).message)
      }
      return doc
    })
  )

  const typesenseClient = getTypesenseClient()
  const results = await typesenseClient
    .collections(COLLECTION)
    .documents()
    .import(docs, { action: "upsert" }) as TypesenseImportResult[]

  const failures = results.filter((r) => !r.success)
  if (failures.length > 0) {
    console.error(`[Typesense] ${failures.length}/${docs.length} batch index failures:`, failures)
  }

  console.warn(`[Typesense] Batch indexed ${docs.length - failures.length}/${docs.length} products`)
}
