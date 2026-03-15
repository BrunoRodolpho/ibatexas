// @ibatexas/tools
// Agent tool definitions and utilities.
// Each tool is an isolated module — definition + handler.

// ── Search tool ────────────────────────────────────────────────────────────────
export { searchProducts, SearchProductsTool } from "./search/search-products.js"

// ── Catalog tools ──────────────────────────────────────────────────────────────
export { getProductDetails, GetProductDetailsTool } from "./catalog/get-product-details.js"
export { estimateDelivery, EstimateDeliveryTool } from "./catalog/estimate-delivery.js"

// ── Cart tools ─────────────────────────────────────────────────────────────────
export { getCart, GetCartTool } from "./cart/get-cart.js"
export { addToCart, AddToCartTool } from "./cart/add-to-cart.js"
export { updateCart, UpdateCartTool } from "./cart/update-cart.js"
export { removeFromCart, RemoveFromCartTool } from "./cart/remove-from-cart.js"
export { applyCoupon, ApplyCouponTool } from "./cart/apply-coupon.js"
export { createCheckout, CreateCheckoutTool } from "./cart/create-checkout.js"
export { getOrderHistory, GetOrderHistoryTool } from "./cart/get-order-history.js"
export { checkOrderStatus, CheckOrderStatusTool } from "./cart/check-order-status.js"
export { cancelOrder, CancelOrderTool } from "./cart/cancel-order.js"
export { reorder, ReorderTool } from "./cart/reorder.js"

// ── Intelligence tools ─────────────────────────────────────────────────────────
export { getCustomerProfile, GetCustomerProfileTool } from "./intelligence/get-customer-profile.js"
export { getRecommendations, GetRecommendationsTool, buildPersonalizedQuery } from "./intelligence/get-recommendations.js"
export { updatePreferences, UpdatePreferencesTool } from "./intelligence/update-preferences.js"
export { submitReview, SubmitReviewTool } from "./intelligence/submit-review.js"
export { getAlsoAdded, GetAlsoAddedTool } from "./intelligence/get-also-added.js"
export { getOrderedTogether, GetOrderedTogetherTool } from "./intelligence/get-ordered-together.js"
export { syncReviewStats } from "./intelligence/sync-review-stats.js"
export { PROFILE_TTL_SECONDS, RECENTLY_VIEWED_MAX } from "./intelligence/types.js"

// ── Embeddings ─────────────────────────────────────────────────────────────────
export { generateEmbedding, generateEmbeddingsBatch } from "./embeddings/client.js"

// ── Redis ──────────────────────────────────────────────────────────────────────
export { getRedisClient, closeRedisClient } from "./redis/client.js"
export { rk } from "./redis/key.js"

// ── Vector utilities ───────────────────────────────────────────────────────────
export { cosineSimilarity } from "./utils/vectors.js"

// ── Mappers ────────────────────────────────────────────────────────────────────
export { medusaToTypesenseDoc, typesenseDocToDTO } from "./mappers/product-mapper.js"

// ── Query cache ────────────────────────────────────────────────────────────────
export {
  getQueryCache,
  setQueryCache,
  getExactQueryCache,
  setExactQueryCache,
  incrementQueryCacheHits,
  logQuery,
  embeddingToBucket,
  allergenFilterHash,
  invalidateAllQueryCache,
} from "./cache/query-cache.js"

// ── Embedding cache ────────────────────────────────────────────────────────────
export {
  getEmbeddingCache,
  setEmbeddingCache,
  deleteEmbeddingCache,
  batchSetEmbeddingCache,
  clearEmbeddingCache,
} from "./cache/embedding-cache.js"

// ── Typesense ──────────────────────────────────────────────────────────────────
export { getTypesenseClient, ensureCollectionExists, recreateCollection, PRODUCTS_COLLECTION_SCHEMA, COLLECTION } from "./typesense/client.js"
export { indexProduct, deleteProductFromIndex, indexProductsBatch } from "./typesense/index-product.js"

// ── Config ─────────────────────────────────────────────────────────────────────
export { EMBED_DIM } from "./config.js"

// ── Reservation tools ──────────────────────────────────────────────────────────
export { checkTableAvailability, CheckTableAvailabilityTool } from "./reservation/check-availability.js"
export { createReservation, CreateReservationTool } from "./reservation/create-reservation.js"
export { modifyReservation, ModifyReservationTool } from "./reservation/modify-reservation.js"
export { cancelReservation, CancelReservationTool } from "./reservation/cancel-reservation.js"
export { getMyReservations, GetMyReservationsTool } from "./reservation/get-my-reservations.js"
export { joinWaitlist, JoinWaitlistTool } from "./reservation/join-waitlist.js"

// ── WhatsApp sender (dependency injection) ───────────────────────────────────
export { setWhatsAppSender, getWhatsAppSender } from "./whatsapp/sender.js"
export type { WhatsAppSender } from "./whatsapp/sender.js"

// ── Re-export shared types consumed by CLI and other packages ─────────────────
export { Channel } from "@ibatexas/types"
