// Index products into Typesense
// Called from Medusa subscribers on product create/update/delete

import { medusaToTypesenseDoc, type MedusaProductInput, type TypesenseProductDoc } from "../mappers/product-mapper.js"
import { generateEmbedding } from "../embeddings/client.js"
import { rk } from "../redis/key.js"
import { getTypesenseClient, COLLECTION } from "./client.js"
import { isTypesenseError, type TypesenseImportResult } from "./types.js"
import { toolLog } from "../logger.js"

const log = toolLog("tools:typesense")

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
    log.warn({ productId: product.id, err: (error as Error).message }, "Embedding generation failed — indexing without embedding")
  }

  await typesenseClient.collections(COLLECTION).documents().upsert(doc)
  log.debug({ productId: product.id, title: product.title }, "Indexed product")
}

/**
 * Delete a product from Typesense by ID.
 * Idempotent — ignores 404 (already deleted or never indexed).
 */
export async function deleteProductFromIndex(productId: string): Promise<void> {
  try {
    const typesenseClient = getTypesenseClient()
    await typesenseClient.collections(COLLECTION).documents(productId).delete()
    log.info({ productId }, "Deleted from index")
  } catch (err: unknown) {
    if (isTypesenseError(err) && err.httpStatus === 404) {
      log.debug({ productId }, "Product not in index (already removed)")
      return
    }
    log.error({ productId, err: (err as Error).message }, "Failed to delete product")
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
        log.warn({ productId: product.id, err: (error as Error).message }, "Embedding skipped")
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
    log.error({ failures: failures.length, total: docs.length, details: failures }, "Batch index failures")
  }

  log.info({ indexed: docs.length - failures.length, total: docs.length }, "Batch indexed products")
}
