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
// BKL-179 — checkInventory / getNutritionalInfo were dead ToolDefinitions
// (no conductor/route/internal caller, only these barrel re-exports); removed.

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
export { getPaymentHistory, GetPaymentHistoryTool } from "./cart/get-payment-history.js"
export { checkOrderStatus, CheckOrderStatusTool } from "./cart/check-order-status.js"
export { checkPaymentStatus, CheckPaymentStatusTool } from "./cart/check-payment-status.js"
export { cancelOrder, CancelOrderTool } from "./cart/cancel-order.js"
export { amendOrder, AmendOrderTool } from "./cart/amend-order.js"
export { changeDeliveryAddress } from "./cart/change-delivery-address.js"
export { switchOrderType } from "./cart/switch-order-type.js"
export { reorder, ReorderTool } from "./cart/reorder.js"
export { regeneratePix, RegeneratePixTool } from "./cart/regenerate-pix.js"
export { cancelStalePaymentIntent } from "./cart/_stripe-helpers.js"
export { setPixDetails, SetPixDetailsTool, SetPixDetailsInputSchema, isValidCpf, normalizeCpf, maskCpf } from "./cart/set-pix-details.js"
export type { SetPixDetailsInput } from "./cart/set-pix-details.js"
export { addOrderNote, AddOrderNoteTool } from "./cart/add-order-note.js"

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
export { createOrderAccessToken, verifyOrderAccessToken } from "./session/signed-claims.js"
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
export { acquireLock, withLock, type LockHandle } from "./redis/distributed-lock.js"

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
  getScheduleSignal,
  getTodayHoursText,
  getHoursTextForDate,
  type ScheduleSignal,
} from "./schedule/schedule-helpers.js"

// ── Schedule cache ──────────────────────────────────────────────────────────
export {
  getCachedSchedule,
  setCachedSchedule,
  invalidateScheduleCache,
  loadSchedule,
} from "./cache/schedule-cache.js"
export type { ScheduleCacheInvalidation } from "./cache/schedule-cache.js"

// ── Banner cache ──────────────────────────────────────────────────────────────
export {
  getBannerText,
  setBannerText,
  clearBannerText,
} from "./cache/banner-cache.js"

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

// ── Embeddings ─────────────────────────────────────────────────────────────────
// BKL-034 — the boot-time provider/dimension gate (apps consume it at bootstrap so
// an EMBEDDINGS_PROVIDER / EMBEDDING_DIMENSION misconfig fails loud instead of
// silently poisoning the Typesense index). Resolves cleanly when no provider is
// configured (keyword-only degrade stays legal).
export { assertEmbeddingProviderDimension } from "./embeddings/client.js"

// ── Typesense ──────────────────────────────────────────────────────────────────
export { getTypesenseClient, ensureCollectionExists, recreateCollection, PRODUCTS_COLLECTION_SCHEMA, COLLECTION } from "./typesense/client.js"
export { indexProduct, deleteProductFromIndex, indexProductsBatch } from "./typesense/index-product.js"

// ── Medusa HTTP client ────────────────────────────────────────────────────────
export { medusaAdmin, medusaStore, MedusaRequestError, reaisToCentavos } from "./medusa/client.js"
export {
  medusaAdjudicated,
  detectMedusaIntentKind,
  medusaWrapperPolicyBundle,
  MedusaAdjudicateRefusedError,
  MedusaAdjudicateDeferredError,
  MedusaAdjudicateNeedsReviewError,
  MEDUSA_INTENT_KINDS,
  type MedusaAdjudicatedArgs,
  type MedusaIntentKind,
  type MedusaWrapperState,
} from "./medusa/adjudicated.js"

// ── Medusa anonymize compensation tracking (audit-2026-05-24 H3 Wave-B) ──
// Redis-backed registry of in-flight `customer.anonymize.medusa.pending`
// events. Domain emits → subscriber confirms → retry job sweeps stragglers.
export {
  medusaAnonymizePendingKey,
  medusaAnonymizePendingIndexKey,
  recordMedusaAnonymizePending,
  readMedusaAnonymizePending,
  clearMedusaAnonymizePending,
  listMedusaAnonymizePendingCustomerIds,
  bumpMedusaAnonymizePendingAttempt,
  MEDUSA_ANONYMIZE_PENDING_TTL_SECONDS,
  type MedusaAnonymizePendingEntry,
} from "./medusa/anonymize-pending.js"

// ── Medusa STORE-scope HTTP wrapper (W9 cart-egress epic) ─────────────────────
// Kernel-gated wrapper around customer-cart STORE-scope mutations. Sibling
// of `medusaAdjudicated` (which handles ADMIN-scope egress). Closes the
// 10 LLM-callable cart-tool bypasses inventoried in
// `docs/adjudicate-migration/correctness-remediation/WAVE9-CART-EGRESS-BACKLOG.md`.
// Apps and cart tools should import `medusaStoreAdjudicated` from
// `@ibatexas/tools` for all `/store/*` mutations.
export {
  medusaStoreAdjudicated,
  medusaStoreWrapperPolicyBundle,
  MEDUSA_STORE_INTENT_KINDS,
  MedusaStoreAdjudicateRefusedError,
  MedusaStoreAdjudicateDeferredError,
  MedusaStoreAdjudicateNeedsReviewError,
  type MedusaStoreIntentKind,
  type MedusaStoreWrapperState,
  type MedusaStoreAdjudicatedMeta,
  type MedusaStoreFetchLike,
  type MedusaStoreCartCreatePayload,
  type MedusaStoreCartLineItemAddPayload,
  type MedusaStoreCartLineItemUpdatePayload,
  type MedusaStoreCartLineItemRemovePayload,
  type MedusaStoreCartEmailUpdatePayload,
  type MedusaStoreCartPromotionAddPayload,
  type MedusaStoreCartCompletePayload,
  type MedusaStorePaymentCollectionCreatePayload,
  type MedusaStorePaymentSessionCreatePayload,
} from "./medusa/store-adjudicated.js"

// ── Stripe HTTP wrapper (W7-P5) ───────────────────────────────────────────────
// Promoted to the top-level barrel so apps/api routes (e.g. the Stripe
// webhook handler) can route bare `stripe.*` mutations through the
// kernel-gated wrapper. Previously only re-exported from
// `packages/tools/src/stripe/index.ts`; the webhook route was importing
// the bare `Stripe` SDK and bypassed the wrapper (NEW-W7-V2, closed in
// W8). Apps should import `stripeAdjudicated` from `@ibatexas/tools`.
export {
  stripeAdjudicated,
  stripeWrapperPolicyBundle,
  STRIPE_INTENT_KINDS,
  StripeAdjudicateRefusedError,
  StripeAdjudicateDeferredError,
  StripeAdjudicateNeedsReviewError,
  type StripeIntentKind,
  type StripeWrapperState,
  type StripeAdjudicatedArgs,
} from "./stripe/adjudicated.js"

// ── Twilio SDK wrapper (audit-2026-05-23) ─────────────────────────────────────
// Kernel-gated wrapper around `twilio.messages.create`. Closes the
// gate-blind 2× direct send in `apps/api/src/whatsapp/client.ts:132,204`
// surfaced by the 2026-05-23 coverage audit. Apps should import
// `twilioAdjudicated` from `@ibatexas/tools`.
export {
  twilioAdjudicated,
  twilioWrapperPolicyBundle,
  TWILIO_INTENT_KINDS,
  TwilioAdjudicateRefusedError,
  TwilioAdjudicateDeferredError,
  TwilioAdjudicateNeedsReviewError,
  type TwilioIntentKind,
  type TwilioWrapperState,
  type TwilioMessageSendPayload,
  type TwilioAdjudicatedMeta,
  type TwilioClientLike,
} from "./twilio/adjudicated.js"

// NEW-014 — the fiscal (NFC-e/NFe) provider port + mock/Focus NFe adapters +
// env-driven selection. The subscriber (PR2) imports `createFiscalProvider`.
export {
  createFiscalProvider,
  createMockFiscalProvider,
  createFocusNFeProvider,
  FiscalProviderNotConfiguredError,
  type FiscalProviderPort,
  type FiscalEmitInput,
  type FiscalEmitResult,
  type FiscalEmitStatus,
  type FiscalLineItem,
  type MockFiscalScenario,
  type MockFiscalProviderConfig,
  type FocusNFeConfig,
} from "./fiscal/index.js"

// ── Config ─────────────────────────────────────────────────────────────────────
export { EMBED_DIM } from "./config.js"

// ── Reservation tools ──────────────────────────────────────────────────────────
export { checkTableAvailability, CheckTableAvailabilityTool } from "./reservation/check-availability.js"
export { createReservation, CreateReservationTool } from "./reservation/create-reservation.js"
export { modifyReservation, modifyReservationPreAdjudicated, ModifyReservationTool } from "./reservation/modify-reservation.js"
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

// ── Infra address resolution (moved from packages/cli/src/services.ts, T1a-10) ─
// Port source of truth for `ibx dev urls` / `ibx svc status` (cli re-exports it)
// and the journeys harness pre-flight hostname denylist (journeys→tools only —
// journeys never imports the cli).
export { infraEndpoints, observabilityEndpoints } from "./infra/endpoints.js"
export type { InfraEndpoint } from "./infra/endpoints.js"

// ── Structured JSONL event emitter (ibx scenarios + journeys; IBX_EVENTS=json) ─
export {
  emit,
  onEvent,
  emitScenarioStart,
  emitScenarioFinish,
  emitStepStart,
  emitStepFinish,
  emitJourneyStart,
  emitJourneyEnd,
  emitActStart,
  emitActEnd,
  emitChatTurnStart,
  emitChatTurnEnd,
  emitJourneyAborted,
  emitEvidenceCapture,
  emitLlmCall,
  emitPreflightCheck,
} from "./events/emitter.js"
export type {
  IbxEvent,
  IbxEventBase,
  IbxEventType,
  ScenarioEvent,
  ScenarioEventType,
  JourneyEventType,
  LlmCallEvent,
  ActKindName,
} from "./events/emitter.js"

// ── Re-export shared types consumed by CLI and other packages ─────────────────
export { Channel } from "@ibatexas/types"
