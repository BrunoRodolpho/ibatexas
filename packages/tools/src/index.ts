// @ibatexas/tools
// Agent tool definitions and utilities.
// Each tool is an isolated module — definition + handler.

// ── Search tool ────────────────────────────────────────────────────────────────
export { searchProducts, SearchProductsTool } from "./search/search-products.js"

// ── Catalog tools ──────────────────────────────────────────────────────────────
export { getProductDetails, GetProductDetailsTool } from "./catalog/get-product-details.js"
export { estimateDelivery, EstimateDeliveryTool, invalidateDeliveryCache } from "./catalog/estimate-delivery.js"
export { reverseGeocode } from "./catalog/reverse-geocode.js"
export type { ReverseGeocodeResult } from "./catalog/reverse-geocode.js"
export { checkInventory, CheckInventoryTool } from "./catalog/check-inventory.js"
export { getNutritionalInfo, GetNutritionalInfoTool } from "./catalog/get-nutritional-info.js"

// ── Ownership guards ──────────────────────────────────────────────────────────
export { assertOrderOwnership, assertReservationOwnership } from "./guards/ownership.js"
export { withOrderOwnership, withReservationOwnership } from "./guards/with-ownership.js"

// ── Cart tools ─────────────────────────────────────────────────────────────────
export { assertCartOwnership } from "./cart/assert-cart-ownership.js"
export { getOrCreateCart, GetOrCreateCartTool } from "./cart/get-or-create-cart.js"
export { getCart, GetCartTool } from "./cart/get-cart.js"
export { addToCart, AddToCartTool } from "./cart/add-to-cart.js"
export { updateCart, UpdateCartTool } from "./cart/update-cart.js"
export { removeFromCart, RemoveFromCartTool } from "./cart/remove-from-cart.js"
export { applyCoupon, ApplyCouponTool } from "./cart/apply-coupon.js"
export { createCheckout, CreateCheckoutTool } from "./cart/create-checkout.js"
export { getOrderHistory, GetOrderHistoryTool } from "./cart/get-order-history.js"
export { checkOrderStatus, CheckOrderStatusTool } from "./cart/check-order-status.js"
export { cancelOrder, CancelOrderTool } from "./cart/cancel-order.js"
export { amendOrder, AmendOrderTool } from "./cart/amend-order.js"
export { reorder, ReorderTool } from "./cart/reorder.js"
export { regeneratePix, RegeneratePixTool } from "./cart/regenerate-pix.js"
export { cancelStalePaymentIntent } from "./cart/_stripe-helpers.js"
export { setPixDetails, SetPixDetailsTool, SetPixDetailsInputSchema } from "./cart/set-pix-details.js"
export type { SetPixDetailsInput } from "./cart/set-pix-details.js"

// ── Intelligence tools ─────────────────────────────────────────────────────────
export { getCustomerProfile, GetCustomerProfileTool } from "./intelligence/get-customer-profile.js"
export { getRecommendations, GetRecommendationsTool, buildPersonalizedQuery } from "./intelligence/get-recommendations.js"
export { updatePreferences, UpdatePreferencesTool } from "./intelligence/update-preferences.js"
export { submitReview, SubmitReviewTool } from "./intelligence/submit-review.js"
export { getAlsoAdded, GetAlsoAddedTool } from "./intelligence/get-also-added.js"
export { getOrderedTogether, GetOrderedTogetherTool } from "./intelligence/get-ordered-together.js"
export { scheduleFollowUp, ScheduleFollowUpTool } from "./intelligence/schedule-follow-up.js"
export { getLoyaltyBalance, GetLoyaltyBalanceTool } from "./intelligence/get-loyalty-balance.js"
export { syncReviewStats } from "./intelligence/sync-review-stats.js"
export { getAndConsumeWelcomeCredit } from "./intelligence/welcome-credit.js"
export { PROFILE_TTL_SECONDS, RECENTLY_VIEWED_MAX } from "./intelligence/types.js"

// ── Redis ──────────────────────────────────────────────────────────────────────
export { getRedisClient, closeRedisClient } from "./redis/client.js"
export { rk } from "./redis/key.js"

// ── Session claims ───────────────────────────────────────────────────────────
export { createSessionToken, verifySessionToken, signSessionClaim } from "./session/signed-claims.js"
export type { SessionClaim } from "./session/signed-claims.js"
export { atomicIncr } from "./redis/atomic-rate-limit.js"
export {
  RedisCircuitBreaker,
  CircuitState,
  CircuitOpenError,
  getCircuitBreaker,
  resetCircuitBreaker,
  type CircuitBreakerOptions,
} from "./redis/circuit-breaker.js"
export { safeRedis } from "./redis/safe-redis.js"

// ── Tracing ──────────────────────────────────────────────────────────────────
export {
  createTrace,
  startSpan,
  endSpan,
  getTraceDuration,
  persistTrace,
  loadTrace,
  logSpan,
} from "./tracing/trace.js"
export type { TraceContext, Span } from "./tracing/trace.js"

// ── Replay ───────────────────────────────────────────────────────────────────
export { persistReplayEntry, loadReplayEntry, listRecentReplays } from "./replay/store.js"
export type { ReplayEntry } from "./replay/store.js"

// ── Mappers ────────────────────────────────────────────────────────────────────
export { medusaToTypesenseDoc, typesenseDocToDTO } from "./mappers/product-mapper.js"
export type { MedusaProductInput } from "./mappers/product-mapper.js"

// ── Schedule helpers ─────────────────────────────────────────────────────────
export {
  getLocalTime,
  getTimeStr,
  getMealPeriodFromSchedule,
  isAvailableFromSchedule,
  getNextOpenDay,
  getFrozenPickupMessage,
} from "./schedule/schedule-helpers.js"

// ── Schedule cache ──────────────────────────────────────────────────────────
export {
  getCachedSchedule,
  setCachedSchedule,
  invalidateScheduleCache,
  loadSchedule,
} from "./cache/schedule-cache.js"

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
  getCacheStats,
  type CacheFilterContext,
} from "./cache/query-cache.js"

// ── Typesense ──────────────────────────────────────────────────────────────────
export { getTypesenseClient, ensureCollectionExists, recreateCollection, PRODUCTS_COLLECTION_SCHEMA, COLLECTION } from "./typesense/client.js"
export { indexProduct, deleteProductFromIndex, indexProductsBatch } from "./typesense/index-product.js"

// ── Medusa HTTP client ────────────────────────────────────────────────────────
export { medusaAdmin, medusaStore, MedusaRequestError, reaisToCentavos } from "./medusa/client.js"

// ── Config ─────────────────────────────────────────────────────────────────────
export { EMBED_DIM } from "./config.js"

// ── Reservation tools ──────────────────────────────────────────────────────────
export { checkTableAvailability, CheckTableAvailabilityTool } from "./reservation/check-availability.js"
export { createReservation, CreateReservationTool } from "./reservation/create-reservation.js"
export { modifyReservation, ModifyReservationTool } from "./reservation/modify-reservation.js"
export { cancelReservation, CancelReservationTool } from "./reservation/cancel-reservation.js"
export { getMyReservations, GetMyReservationsTool } from "./reservation/get-my-reservations.js"
export { joinWaitlist, JoinWaitlistTool } from "./reservation/join-waitlist.js"
export {
  sendReservationConfirmation,
  sendReservationModified,
  sendReservationCancelled,
  sendReservationReminder,
  notifyWaitlistSpotAvailable,
} from "./reservation/notifications.js"

// ── Support tools ────────────────────────────────────────────────────────────
export { handoffToHuman, HandoffToHumanTool } from "./support/handoff-to-human.js"

// ── WhatsApp sender (dependency injection) ───────────────────────────────────
export { setWhatsAppSender, getWhatsAppSender } from "./whatsapp/sender.js"
export type { WhatsAppSender } from "./whatsapp/sender.js"

// ── API base URL ──────────────────────────────────────────────────────────────
export { getApiBase, MEDUSA_ADMIN_URL } from "./api/base-url.js"

// ── Re-export shared types consumed by CLI and other packages ─────────────────
export { Channel } from "@ibatexas/types"
