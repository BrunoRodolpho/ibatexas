// CustomerService — centralizes customer domain logic.
//
// Handles: customer upsert, preference updates (Prisma side), review creation.
// Cache (Redis profile hash) stays in the tools layer — services are pure Prisma.
//
// ── Task 15 (M3) — envelope-typed entry points ───────────────────────────
//
// Methods `*FromEnvelope` route through the adjudicate kernel via
// `withAdjudicate` against `customerOnboardingPolicyBundle` from
// `@ibatexas/pack-customer-onboarding`. Decision D8: parallel surface —
// existing methods remain (`@deprecated`).
//
// Covered intents:
//   - customer.create               → upsertFromPhone / upsertFromWhatsApp
//   - customer.preferences.update   → updatePreferences
//   - customer.pix.details.save     → updatePixDetails
//   - customer.anonymize            → anonymizeCustomer (module-level helper)
//   - order.review.submit           → submitReview (orders Pack — reviews are
//                                     order-related; the orders policy bundle
//                                     gates rating + orderId)

import { createHash, randomUUID } from "node:crypto"
import { Prisma } from "../generated/prisma-client/client.js"
import { prisma } from "../client.js"
import { publishNatsEvent } from "@ibatexas/nats-client"
import type { Channel } from "@ibatexas/types"
import {
  buildAuditRecord,
  buildEnvelope,
  decisionExecute,
  type AuditSink,
  type IntentEnvelope,
  type Supersession,
} from "@adjudicate/core"
import {
  customerOnboardingPolicyBundle,
  type CustomerCreatePayload,
  type CustomerPreferencesUpdatePayload,
  type CustomerPixDetailsSavePayload,
  type CustomerAnonymizePayload,
  type CustomerOnboardingState,
} from "@ibatexas/pack-customer-onboarding"
import {
  ordersPolicyBundle,
  type OrderReviewSubmitPayload,
  type OrderState,
} from "@ibatexas/pack-orders"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"

// ── Service ───────────────────────────────────────────────────────────────────

export interface CustomerServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: { readonly warn?: (...args: unknown[]) => void; readonly error?: (...args: unknown[]) => void }
}

export function createCustomerService(options?: CustomerServiceOptions) {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
  } as const

  return {
    /**
     * Create or update a customer record from a verified phone number.
     * Called after OTP verification.
     */
    async upsertFromPhone(phone: string, name?: string) {
      return prisma.customer.upsert({
        where: { phone },
        create: { phone, name: name ?? null },
        update: { ...(name ? { name } : {}) },
      })
    },

    /**
     * Get or create customer preferences.
     * Allergens are always explicit arrays — never inferred (CLAUDE.md rule 1).
     *
     * @deprecated Use `updatePreferencesFromEnvelope` instead — the bare-arg
     *   entry point bypasses the kernel adjudication (allergen-explicit-array
     *   guard, audit emit, etc). Kept as the executor for the envelope
     *   wrapper above and for any remaining callers; will be removed once
     *   the M3 migration completes. See `customer.preferences.update` in
     *   `packages/pack-customer-onboarding`.
     */
    async updatePreferences(
      customerId: string,
      input: {
        dietaryRestrictions?: string[]
        allergenExclusions?: string[]
        favoriteCategories?: string[]
      },
    ) {
      const allergenExclusions = Array.isArray(input.allergenExclusions)
        ? input.allergenExclusions
        : []

      const dietaryRestrictions = Array.isArray(input.dietaryRestrictions)
        ? input.dietaryRestrictions
        : []

      const favoriteCategories = Array.isArray(input.favoriteCategories)
        ? input.favoriteCategories
        : []

      await prisma.customerPreferences.upsert({
        where: { customerId },
        create: { customerId, allergenExclusions, dietaryRestrictions, favoriteCategories },
        update: {
          ...(input.allergenExclusions === undefined ? {} : { allergenExclusions }),
          ...(input.dietaryRestrictions === undefined ? {} : { dietaryRestrictions }),
          ...(input.favoriteCategories === undefined ? {} : { favoriteCategories }),
        },
      })

      return { allergenExclusions, dietaryRestrictions, favoriteCategories }
    },

    /**
     * Submit or update a product review.
     * Returns the updated aggregate rating for the product.
     *
     * @deprecated Use `submitReviewFromEnvelope` instead — the bare-arg
     *   entry point bypasses the kernel adjudication (rating-range guard,
     *   audit emit, etc). Kept for any remaining callers; will be removed
     *   once the M3 migration completes. See `order.review.submit` in
     *   `packages/pack-orders`.
     */
    async submitReview(input: {
      customerId: string
      productId: string
      orderId: string
      rating: number
      comment?: string
      channel: Channel
    }) {
      const { customerId, productId, orderId, rating, comment, channel } = input

      await prisma.review.upsert({
        where: { orderId_customerId: { orderId, customerId } },
        create: {
          orderId,
          productId,
          productIds: [productId],
          customerId,
          rating,
          comment: comment ?? null,
          channel,
        },
        update: { rating, comment: comment ?? null },
      })

      const stats = await prisma.review.aggregate({
        where: { productId },
        _avg: { rating: true },
        _count: { rating: true },
      })

      return {
        avgRating: stats._avg.rating ?? rating,
        reviewCount: stats._count.rating,
      }
    },

    /**
     * Load customer profile data from Prisma (cache-miss path).
     * Returns preferences and order history for profile hydration.
     */
    async getProfileData(customerId: string) {
      const [customerPrefs, orderItems] = await Promise.all([
        prisma.customerPreferences.findUnique({ where: { customerId } }),
        prisma.customerOrderItem.findMany({
          where: { customerId },
          orderBy: { orderedAt: "desc" },
          take: 200,
        }),
      ])

      return { customerPrefs, orderItems }
    },

    /**
     * Bulk-insert order items for intelligence tracking.
     * Called by the order.placed NATS subscriber.
     */
    async recordOrderItems(
      customerId: string,
      orderId: string,
      items: Array<{ productId: string; variantId: string; quantity: number; priceInCentavos: number }>,
    ) {
      const now = new Date()
      await prisma.customerOrderItem.createMany({
        data: items.map(({ productId, variantId, quantity, priceInCentavos }) => ({
          customerId,
          productId,
          variantId,
          quantity,
          priceInCentavos,
          orderedAt: now,
          medusaOrderId: orderId,
        })),
        skipDuplicates: false,
      })
    },

    /**
     * Update PIX billing details (name, email, CPF) after successful PIX checkout.
     * Persists to DB so data survives Redis TTL expiry.
     *
     * @deprecated Use `updatePixDetailsFromEnvelope` instead — the bare-arg
     *   entry point bypasses the kernel adjudication (CPF-shape guard, audit
     *   emit, etc). Kept for any remaining callers; will be removed once the
     *   M3 migration completes. See `customer.pix.details.save` in
     *   `packages/pack-customer-onboarding`.
     */
    async updatePixDetails(customerId: string, data: { name?: string; email?: string; cpf?: string }) {
      await prisma.customer.update({
        where: { id: customerId },
        data: {
          ...(data.name ? { name: data.name } : {}),
          ...(data.email ? { email: data.email } : {}),
          ...(data.cpf ? { cpf: data.cpf } : {}),
        },
      })
    },

    /**
     * Fetch customer by ID. Used by GET /auth/me.
     */
    async getById(customerId: string) {
      return prisma.customer.findUniqueOrThrow({
        where: { id: customerId },
      })
    },

    /**
     * Upsert from WhatsApp (pre-verified phone). Sets source + firstContactAt.
     * Phone IS identity on WhatsApp — verified by Meta/Twilio.
     */
    async upsertFromWhatsApp(phone: string) {
      return prisma.customer.upsert({
        where: { phone },
        create: { phone, source: "whatsapp", firstContactAt: new Date() },
        update: {},
        select: { id: true },
      })
    },

    /**
     * Find customers who have ordered before but not within the last `thresholdDays` days.
     * Uses a raw query to GROUP BY customer and filter by MAX(ordered_at).
     * Returns up to `limit` customers ordered by most-recently-dormant first.
     */
    async findDormantCustomers(thresholdDays: number, limit = 200) {
      const cutoff = new Date(Date.now() - thresholdDays * 86400 * 1000)
      const dormant = await prisma.$queryRaw`
        SELECT c.id, c.phone, c.name
        FROM ibx_domain.customers c
        INNER JOIN ibx_domain.customer_order_items coi ON coi.customer_id = c.id
        WHERE c.phone IS NOT NULL
        GROUP BY c.id, c.phone, c.name
        HAVING MAX(coi.ordered_at) < ${cutoff}
        ORDER BY MAX(coi.ordered_at) DESC
        LIMIT ${limit}
      ` as Array<{ id: string; phone: string; name: string | null }>
      return dormant
    },

    /**
     * Co-purchase query: products this customer ordered alongside productId.
     * Returns grouped items ranked by frequency.
     */
    async getOrderedTogether(customerId: string, productId: string, limit = 5) {
      const ordersWithProduct = await prisma.customerOrderItem.findMany({
        where: { customerId, productId },
        select: { medusaOrderId: true },
        distinct: ["medusaOrderId"],
      })
      if (ordersWithProduct.length === 0) return []

      const orderIds = ordersWithProduct.map((o) => o.medusaOrderId)
      return prisma.customerOrderItem.groupBy({
        by: ["productId"],
        where: {
          customerId,
          medusaOrderId: { in: orderIds },
          productId: { not: productId },
        },
        _count: { productId: true },
        orderBy: { _count: { productId: "desc" } },
        take: limit,
      })
    },

    // ── Task 15: envelope-typed entry points ────────────────────────────

    /**
     * Envelope-typed entry point for `customer.create`. SYSTEM-only —
     * the OTP-verify completion hook is the sole emitter. The `phone`
     * is passed alongside the envelope (the pack's payload carries
     * `phoneHash` only — the raw phone never enters policy state per
     * PII discipline).
     */
    async createFromEnvelope(
      envelope: IntentEnvelope<"customer.create", CustomerCreatePayload>,
      state: CustomerOnboardingState,
      extras: { readonly phone: string; readonly name?: string },
    ): Promise<AdjudicatedResult<{ id: string }>> {
      return withAdjudicate(
        envelope,
        state,
        customerOnboardingPolicyBundle,
        async (payload) => {
          const source = payload.source === "wa-auto" ? "whatsapp" : null
          if (source === "whatsapp") {
            return prisma.customer.upsert({
              where: { phone: extras.phone },
              create: { phone: extras.phone, source, firstContactAt: new Date() },
              update: {},
              select: { id: true },
            })
          }
          // OTP source path.
          const row = await prisma.customer.upsert({
            where: { phone: extras.phone },
            create: { phone: extras.phone, name: extras.name ?? null },
            update: { ...(extras.name ? { name: extras.name } : {}) },
            select: { id: true },
          })
          return row
        },
        adjudicateOptions,
      )
    },

    /**
     * Envelope-typed entry point for `customer.preferences.update`.
     * UNTRUSTED-tolerant; pack enforces allergen-explicit-array safety
     * (CLAUDE.md rule #1).
     */
    async updatePreferencesFromEnvelope(
      envelope: IntentEnvelope<
        "customer.preferences.update",
        CustomerPreferencesUpdatePayload
      >,
      state: CustomerOnboardingState,
      extras: { readonly customerId: string },
    ): Promise<
      AdjudicatedResult<{
        allergenExclusions: string[]
        dietaryRestrictions: string[]
        favoriteCategories: string[]
      }>
    > {
      return withAdjudicate(
        envelope,
        state,
        customerOnboardingPolicyBundle,
        async (payload) => {
          // Pack's allergenExclusions / dietaryFlags / favoriteCategories are
          // ReadonlyArray<string>; service's update method accepts string[].
          return this.updatePreferences(extras.customerId, {
            allergenExclusions: payload.allergenExclusions as string[],
            ...(payload.dietaryFlags !== undefined
              ? { dietaryRestrictions: payload.dietaryFlags as string[] }
              : {}),
            ...(payload.favoriteCategories !== undefined
              ? { favoriteCategories: payload.favoriteCategories as string[] }
              : {}),
          })
        },
        adjudicateOptions,
      )
    },

    /**
     * Envelope-typed entry point for `order.review.submit`. UNTRUSTED-
     * tolerant; the pack-orders policy validates the rating range
     * (`order.review.rating_invalid`) and gates on `state.ctx.orderId`
     * being present (`order.not_found`). The executor delegates to the
     * legacy `submitReview()` for the Prisma upsert + aggregate stats
     * pass, returning the updated aggregate to the caller so the cache
     * layer in the tools package can refresh Typesense.
     *
     * Note: `order.review.submit` lives in the orders Pack (reviews are
     * order-related) — the policy bundle / state shape differ from the
     * customer-onboarding kinds above. We import both Packs here per
     * the kernel chokepoint pattern: each *FromEnvelope method picks
     * the Pack appropriate to its intent kind.
     */
    async submitReviewFromEnvelope(
      envelope: IntentEnvelope<"order.review.submit", OrderReviewSubmitPayload>,
      state: OrderState,
      extras: {
        readonly customerId: string
        readonly channel: Channel
      },
    ): Promise<AdjudicatedResult<{ avgRating: number; reviewCount: number }>> {
      return withAdjudicate(
        envelope,
        state,
        ordersPolicyBundle,
        async (payload) => {
          return this.submitReview({
            customerId: extras.customerId,
            productId: payload.productId,
            orderId: payload.orderId,
            rating: payload.rating,
            ...(payload.comment !== undefined ? { comment: payload.comment } : {}),
            channel: extras.channel,
          })
        },
        adjudicateOptions,
      )
    },

    /**
     * Envelope-typed entry point for `customer.pix.details.save`.
     * UNTRUSTED-tolerant. The pack validates CPF shape; PII redaction
     * for the audit emit happens in the upstream wiring layer (task 18).
     */
    async updatePixDetailsFromEnvelope(
      envelope: IntentEnvelope<
        "customer.pix.details.save",
        CustomerPixDetailsSavePayload
      >,
      state: CustomerOnboardingState,
      extras: { readonly customerId: string },
    ): Promise<AdjudicatedResult<void>> {
      return withAdjudicate(
        envelope,
        state,
        customerOnboardingPolicyBundle,
        async (payload) => {
          return this.updatePixDetails(extras.customerId, {
            name: payload.name,
            email: payload.email,
            cpf: payload.cpf,
          })
        },
        adjudicateOptions,
      )
    },
  }
}

// ── Task 15: envelope-typed anonymize entry point ───────────────────────

/**
 * Envelope-typed entry point for `customer.anonymize`. The pack DEFERs
 * with a `customer.anonymize.grace` signal (24h by default) before the
 * destructive operation runs. Adopter (route layer, task 14) decides how
 * to surface DEFER to the customer and how to schedule the resume.
 *
 * The EXECUTE branch invokes `anonymizeCustomer` — the legacy
 * module-level helper — preserving the existing transactional semantics.
 */
export async function anonymizeCustomerFromEnvelope(
  envelope: IntentEnvelope<"customer.anonymize", CustomerAnonymizePayload>,
  state: CustomerOnboardingState,
  options?: CustomerServiceOptions,
): Promise<AdjudicatedResult<{ success: true }>> {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
  } as const
  return withAdjudicate(
    envelope,
    state,
    customerOnboardingPolicyBundle,
    async (payload) => {
      // Thread the audit-scope-extension predecessor link so the per-surface
      // scrub records emitted by anonymizeCustomer's H3 wave-a1 extension
      // chain back to this `customer.anonymize` envelope.
      const anonymizeOptions: AnonymizeCustomerOptions = {
        ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
        ...(options?.log ? { log: options.log } : {}),
        predecessor: {
          predecessorIntentHash: envelope.intentHash,
          predecessorAt: envelope.createdAt,
        },
      }
      const result = await anonymizeCustomer(payload.customerId, anonymizeOptions)
      return result as { success: true }
    },
    adjudicateOptions,
  )
}

/**
 * LGPD Art. 18 — Anonymize a customer's personal data.
 *
 * Preserves order items (fiscal obligation) and aggregate analytics
 * shape (co-purchase matrix, dietary safety flags), but obliterates
 * every direct identifier from the customer record and its child
 * tables.
 *
 * ── W4 P0-13 — completeness fix ──────────────────────────────────────
 *
 * Pre-W4 the function:
 *   - Nulled `name` and `email` on Customer
 *   - DELETEd Address rows (good)
 *   - DELETEd CustomerPreferences (good for now — see note below)
 *   - Delinked CustomerOrderItem (good — fiscal preservation)
 *
 * BUT it did NOT:
 *   - Clear `phone` (LGPD-protected identifier most likely to be
 *     directly-linkable to a person; the phone is UNIQUE, so we MUST
 *     replace with a unique non-PII placeholder rather than null).
 *   - Clear `cpf` (Brazilian tax ID — full PII).
 *   - Anonymize `Review.comment` (customer-typed free-form text that
 *     can contain PII the customer entered).
 *   - Anonymize the relation on `Review.customerId` (FK is SetNull on
 *     delete; here we explicitly null it AND scrub comment text).
 *
 * The W4 fix:
 *   - phone → "anonymized:{first-8-hex-of-sha256(id)}" — unique by
 *     construction, recognisable as a sentinel, not reversible.
 *   - cpf → null
 *   - email → null (already done)
 *   - name → "Usuário Removido" (already done)
 *   - addresses → DELETE (already done)
 *   - preferences → DELETE (already done; allergens flagged below)
 *   - reviews → comment="", customerId=null (explicit delink + scrub)
 *   - order items → customerId=null (already done; fiscal preservation)
 *
 * ── Allergen safety note (legal review required) ─────────────────────
 *
 * `CustomerPreferences.allergenExclusions` is currently DELETEd along
 * with the row. This is a tension between LGPD's "right to erasure"
 * and the operational safety obligation NOT to lose allergen flags
 * for in-flight orders (CLAUDE.md rule #1).
 *
 * Practical reality: at the moment `anonymizeCustomer` fires (after
 * a 24h grace window), open orders for the customer should have
 * completed; allergen flags persist on the ORDER itself via the cart
 * snapshot taken at checkout, not via a join to CustomerPreferences.
 * So deleting CustomerPreferences does NOT compromise allergen safety
 * for past orders.
 *
 * The remaining concern is FUTURE orders if the customer-id is
 * recycled (it is not — anonymize is intended to be terminal). The
 * row is deleted; if the customer ever creates a new account with the
 * same phone (impossible — phone is now `anonymized:*`), they would
 * have to re-enter their allergens.
 *
 * **Legal review item:** confirm with LGPD counsel that scrubbing
 * dietaryFlags is permitted (it's PII-adjacent: dietary restriction =
 * health information, LGPD Art. 11 sensitive data). The audit
 * recommendation flagged we MUST preserve operational safety
 * (allergens stay until associated orders close), but the
 * preferences row at anonymize-time is no longer joined to any open
 * order. Document the decision in the next privacy-impact assessment.
 *
 * If legal asks us to preserve a hashed-allergen flag for future
 * orders, the implementation would set `allergenExclusions = []` and
 * preserve dietaryFlags hashed — for now we DELETE the row entirely
 * (matches the pre-W4 behaviour, no allergen-safety regression).
 */
// ── NEW-P0-X7: explicit transaction timeouts + review batching ─────────
//
// Pre-fix: `prisma.$transaction(async (tx) => { ... })` used Prisma's
// default 5 s interactive-transaction timeout. A customer with 10k+
// reviews would time out on the `tx.review.updateMany` step, Prisma
// would roll the whole transaction back, the customer row would stay
// un-anonymized — and the LGPD intake receipt (already in Redis) would
// outlive the rollback. From the operator console: queued. From the DB:
// nothing happened. The 15-day LGPD deadline starts ticking with no
// signal.
//
// Post-fix:
//   1. The core (small, deterministic) transaction handles the customer
//      profile + addresses + preferences + small review batch + order
//      items in a single 60 s `prisma.$transaction(..., { timeout, maxWait })`.
//   2. If the customer has > REVIEW_BATCH_HEAVY_THRESHOLD reviews, the
//      review scrub is split into REVIEW_BATCH_SIZE-sized batches
//      processed OUTSIDE the main transaction. Each batch is a small
//      `updateMany` with a `LIMIT` simulated via primary-key chunking.
//   3. The caller's "receipt cleanup" obligation lives in
//      `anonymizeCustomerFromEnvelope`'s adopter site (the route layer).
//      Returning `{ success: true }` only after every batch succeeds
//      preserves the contract that the Redis receipt is dropped only on
//      complete success.

/**
 * Heavy-customer threshold. Below this we keep the original single-tx
 * shape (one round trip, one Prisma tx). At/above this, we offload the
 * review scrub to batches outside the main tx so a long-running write
 * does not hold locks for ~minutes.
 */
const REVIEW_BATCH_HEAVY_THRESHOLD = 1000

/** Per-batch chunk size for the heavy path. */
const REVIEW_BATCH_SIZE = 500

/**
 * Heavy-customer threshold for the conversation-message scrub. Below this
 * the in-tx `updateMany` handles every message in one round-trip; at/above,
 * messages are pre-batched OUTSIDE the main tx to avoid holding locks.
 * audit-2026-05-24 H3 wave-a1.
 */
const CONVERSATION_MESSAGE_BATCH_HEAVY_THRESHOLD = 1000

/** Per-batch chunk size for the conversation-message heavy path. */
const CONVERSATION_MESSAGE_BATCH_SIZE = 500

/**
 * Placeholder content written to ConversationMessage.content during
 * anonymization. Free-form pt-BR text cannot be safely parsed for PII;
 * wholesale replacement is the safe option (SYNTHESIS §"surface 2").
 */
const CONVERSATION_MESSAGE_PLACEHOLDER = "[anonymized]"

/**
 * Heavy-customer threshold for the order-event-log scrub. Below this the
 * in-tx `updateMany` handles every row in one round-trip; at/above, rows
 * are pre-batched OUTSIDE the main tx. audit-2026-05-24 H3 wave-a1.
 */
const ORDER_EVENT_LOG_BATCH_HEAVY_THRESHOLD = 1000

/** Per-batch chunk size for the order-event-log heavy path. */
const ORDER_EVENT_LOG_BATCH_SIZE = 500

/**
 * Prisma interactive-transaction timeout for the main anonymize tx.
 * 60 s covers a customer with ~5k reviews + addresses/preferences on a
 * normally-loaded primary. Heavier customers route through the batched
 * review path below.
 */
const ANONYMIZE_TX_TIMEOUT_MS = 60_000

/** Prisma maxWait — how long the client waits for a free connection. */
const ANONYMIZE_TX_MAX_WAIT_MS = 5_000

/**
 * Per-surface scrub kinds emitted as audit records after the main
 * transaction commits. Each value mirrors the table the scrub targets so
 * audit consumers can filter by surface. audit-2026-05-24 H3 wave-a1.
 */
const SCRUB_AUDIT_KINDS = [
  "customer.anonymize.order_projection.scrubbed",
  "customer.anonymize.conversation_message.scrubbed",
  "customer.anonymize.conversation_link.scrubbed",
  "customer.anonymize.order_status_history.scrubbed",
  "customer.anonymize.order_event_log.scrubbed",
  "customer.anonymize.loyalty_account.scrubbed",
  "customer.anonymize.reservation_special_requests.scrubbed",
] as const

type ScrubAuditKind = (typeof SCRUB_AUDIT_KINDS)[number]

/**
 * Optional context for `anonymizeCustomer`. Adopters supply an `auditSink`
 * to emit the per-surface scrub records (H3 wave-a1). `predecessor` chains
 * each emitted record back to the original `customer.anonymize` envelope
 * via the AuditRecord `supersedes` field. Both are optional — call sites
 * predating the audit-scope expansion continue to work unchanged.
 */
export interface AnonymizeCustomerOptions {
  readonly auditSink?: AuditSink
  readonly predecessor?: {
    readonly predecessorIntentHash: string
    readonly predecessorAt: string
  }
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
}

export async function anonymizeCustomer(
  customerId: string,
  options?: AnonymizeCustomerOptions,
) {
  // Compute a stable anonymized phone placeholder. UNIQUE constraint on
  // Customer.phone means we cannot null it; we substitute a non-PII
  // sentinel that's still unique per record so the column constraint
  // holds. Using customerId in the hash means the same customer always
  // produces the same placeholder (idempotent retries land on the same
  // value), and different customers can never collide.
  const phoneSentinel =
    "anonymized:" + createHash("sha256").update(customerId).digest("hex").slice(0, 16)

  // audit-2026-05-24 H3 Wave-B: capture medusaId BEFORE the Prisma TX
  // nulls it. The Wave-B cross-DB compensation chain needs to PATCH the
  // Medusa-side customer row by id; once the TX scrubs Customer.medusaId
  // to null we can no longer recover the target. If the customer was
  // never linked to a Medusa row (medusaId === null), we skip the
  // compensation chain entirely — there's nothing to scrub on the
  // Medusa side.
  const customerForCompensation = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { medusaId: true },
  })
  const medusaIdForCompensation = customerForCompensation?.medusaId ?? null

  // Count reviews so we know whether to take the heavy-customer path.
  // `prisma.review.count` is cheap (covered by the customerId index).
  const reviewCount = await prisma.review.count({ where: { customerId } })

  if (reviewCount > REVIEW_BATCH_HEAVY_THRESHOLD) {
    // ── Heavy path ────────────────────────────────────────────────
    //
    // Strategy:
    //   1. Scrub review comments in batches OUTSIDE the main tx.
    //      Each batch is a small updateMany filtered to reviews that
    //      still carry a non-null comment for this customer, capped
    //      at REVIEW_BATCH_SIZE rows. This avoids holding locks for
    //      the duration of the long write.
    //   2. After every comment is scrubbed, run the core anonymize
    //      transaction (customer + address + preferences + a
    //      cleanup pass on reviews + order items) with the explicit
    //      60 s timeout. The cleanup pass is a no-op `updateMany`
    //      that catches any reviews inserted while batching was in
    //      flight — small operation, no timeout risk.
    //
    // If ANY batch fails the function throws — the caller MUST NOT
    // clean up the Redis receipt. A retry repeats the remaining
    // batches (the scrub is idempotent: comment=null updates remain
    // null) and reaches the core tx on success.

    let scrubbedSoFar = 0
    // Safety cap: at REVIEW_BATCH_SIZE per loop we visit at most
    // ceil(reviewCount / REVIEW_BATCH_SIZE) iterations before all
    // not-yet-scrubbed comments are null. Loop exits as soon as a
    // batch reports zero rows updated.
    const maxLoops = Math.ceil(reviewCount / REVIEW_BATCH_SIZE) + 1
    for (let i = 0; i < maxLoops; i++) {
      // Find the next batch by primary-key chunk. We re-query rather
      // than tracking offsets so concurrent inserts don't shift the
      // window — updateMany with a LIMIT can't express that in
      // Prisma directly, so we fetch ids first.
      const nextBatch = await prisma.review.findMany({
        where: { customerId, comment: { not: null } },
        select: { id: true },
        take: REVIEW_BATCH_SIZE,
        orderBy: { id: "asc" },
      })
      if (nextBatch.length === 0) break
      const ids = nextBatch.map((r) => r.id)
      const result = await prisma.review.updateMany({
        where: { id: { in: ids } },
        data: { comment: null },
      })
      scrubbedSoFar += result.count
      if (result.count === 0) break
    }
    void scrubbedSoFar
  }

  // ── H3 wave-a1: ConversationMessage heavy-path pre-scrub ───────
  //
  // ConversationMessage rows are linked to a customer indirectly through
  // Conversation.customerId — there is no direct FK on the messages
  // table. Look up the customer's conversation ids first; if the message
  // count exceeds the heavy threshold, batch the content scrub OUTSIDE
  // the main tx (same pattern as reviews).

  const customerConversationRows = await prisma.conversation.findMany({
    where: { customerId },
    select: { id: true },
  })
  const customerConversationIds = customerConversationRows.map((row) => row.id)

  if (customerConversationIds.length > 0) {
    const messageCount = await prisma.conversationMessage.count({
      where: { conversationId: { in: customerConversationIds } },
    })
    if (messageCount > CONVERSATION_MESSAGE_BATCH_HEAVY_THRESHOLD) {
      // Same loop shape as the review heavy path: re-query in id chunks
      // so concurrent inserts don't shift the window; exit when a batch
      // reports zero rows (every message already carries the placeholder).
      const maxLoops =
        Math.ceil(messageCount / CONVERSATION_MESSAGE_BATCH_SIZE) + 1
      for (let i = 0; i < maxLoops; i++) {
        const nextBatch = await prisma.conversationMessage.findMany({
          where: {
            conversationId: { in: customerConversationIds },
            content: { not: CONVERSATION_MESSAGE_PLACEHOLDER },
          },
          select: { id: true },
          take: CONVERSATION_MESSAGE_BATCH_SIZE,
          orderBy: { id: "asc" },
        })
        if (nextBatch.length === 0) break
        const ids = nextBatch.map((r) => r.id)
        const result = await prisma.conversationMessage.updateMany({
          where: { id: { in: ids } },
          // audit-2026-05-25 (I9): also scrub `metadata` (Json?). No
          // current production producer fills it (verified via
          // conversation-archiver.ts:76 which passes no extras), but the
          // column is schema-permitted for arbitrary JSON and any future
          // metadata writer would otherwise leak past anonymize.
          data: {
            content: CONVERSATION_MESSAGE_PLACEHOLDER,
            metadata: Prisma.JsonNull,
          },
        })
        if (result.count === 0) break
      }
    }
  }

  // ── H3 wave-a1: OrderEventLog heavy-path pre-scrub ─────────────
  //
  // OrderEventLog has NO customer FK — the link is via orderId →
  // OrderProjection.customerId. Look up the customer's order ids first;
  // if the event count exceeds the heavy threshold, batch the payload
  // scrub OUTSIDE the main tx.

  const customerOrderRows = await prisma.orderProjection.findMany({
    where: { customerId },
    select: { id: true },
  })
  const customerOrderIds = customerOrderRows.map((row) => row.id)

  if (customerOrderIds.length > 0) {
    const eventCount = await prisma.orderEventLog.count({
      where: { orderId: { in: customerOrderIds } },
    })
    if (eventCount > ORDER_EVENT_LOG_BATCH_HEAVY_THRESHOLD) {
      // The "already-scrubbed" predicate cannot trivially be expressed
      // against a JSON column in Prisma, so we paginate by id-greater-than
      // cursor and let the updateMany be idempotent on rerun (replacing
      // {anonymized:true} with {anonymized:true} is a no-op).
      const maxLoops =
        Math.ceil(eventCount / ORDER_EVENT_LOG_BATCH_SIZE) + 1
      let cursor: string | null = null
      for (let i = 0; i < maxLoops; i++) {
        const baseWhere = { orderId: { in: customerOrderIds } }
        const where =
          cursor === null
            ? baseWhere
            : { ...baseWhere, id: { gt: cursor } }
        const nextBatch: Array<{ id: string }> =
          await prisma.orderEventLog.findMany({
            where,
            select: { id: true },
            take: ORDER_EVENT_LOG_BATCH_SIZE,
            orderBy: { id: "asc" },
          })
        if (nextBatch.length === 0) break
        const ids = nextBatch.map((r) => r.id)
        const result = await prisma.orderEventLog.updateMany({
          where: { id: { in: ids } },
          data: { payload: { anonymized: true } },
        })
        if (result.count === 0) break
        cursor = ids[ids.length - 1] ?? null
      }
    }
  }

  // ── Core anonymize transaction ─────────────────────────────────
  //
  // The core tx is small + deterministic. We pass an explicit
  // `timeout` (60 s) so a moderately-loaded primary can finish; the
  // heavy-customer review path above keeps the per-tx work small even
  // for 10k-review customers.

  await prisma.$transaction(
    async (tx) => {
      // (1) Anonymize the profile row — scrub every direct identifier.
      // phone is UNIQUE-constrained so we substitute, not null.
      await tx.customer.update({
        where: { id: customerId },
        data: {
          name: "Usuário Removido",
          email: null,
          phone: phoneSentinel,
          cpf: null,
          medusaId: null,
        },
      })

      // (2) Delete addresses (no PII retained).
      await tx.address.deleteMany({ where: { customerId } })

      // (3) Delete preferences. See "Allergen safety note" above —
      // legal-review item; current behaviour preserved (DELETE) because
      // allergen flags on past orders persist on the cart snapshot at
      // checkout, not via CustomerPreferences.
      await tx.customerPreferences.deleteMany({ where: { customerId } })

      // (4) Anonymize reviews. The Review.customerId field is `String`
      // (not nullable) but `customer Customer? @relation(... onDelete:
      // SetNull)` — Prisma schema inconsistency. We CANNOT directly
      // null Review.customerId from app code without a schema migration.
      //
      // Instead we scrub the comment text (the customer-typed PII path)
      // and rely on the Customer row itself being anonymized (phone /
      // email / cpf / name all scrubbed by step 1) to break PII linkage.
      // Anyone querying the customer record via this Review's FK lands
      // on `name="Usuário Removido"` + sentinel phone — no PII reaches
      // the consumer.
      //
      // For the heavy path the bulk of comments are already null after
      // the batched pre-scrub; this updateMany cleans up any reviews
      // inserted during batching. Small operation, no timeout risk.
      await tx.review.updateMany({
        where: { customerId },
        data: { comment: null },
      })

      // (5) Delink order items (preserve for fiscal/analytics).
      await tx.customerOrderItem.updateMany({
        where: { customerId },
        data: { customerId: null },
      })

      // ── audit-2026-05-24 H3 wave-a1 — scope expansion (surfaces 1-7) ──
      //
      // The original 4-surface scrub (Customer + Address + CustomerPreferences
      // + Review) above leaves PII in 7 other in-process tables. SYNTHESIS
      // §G2 picks: full-replace JSON for shipping/payload, placeholder for
      // chat content, null-out for scalars + soft FKs, sentinel substitute
      // where UNIQUE / NOT NULL constraints block null. See
      // docs/adjudicate-migration/audit-2026-05-24/tasks/h3-investigation/SYNTHESIS.md
      //
      // Heavy-customer paths (ConversationMessage + OrderEventLog) are
      // pre-batched OUTSIDE this transaction (see "Heavy path" block above
      // the tx) to avoid holding locks for the duration of multi-thousand-
      // row updates. The in-tx updateMany below acts as the cleanup pass.

      // (6) Surface 1: OrderProjection — scrub denormalized customer fields
      // + full-replace shipping address JSON. customerId stays (FK SetNull
      // semantics; the row stays linked to the anonymized Customer).
      await tx.orderProjection.updateMany({
        where: { customerId },
        data: {
          customerEmail: null,
          customerName: null,
          customerPhone: null,
          shippingAddressJson: { anonymized: true },
        },
      })

      // (7) Surface 2: ConversationMessage.content — replace free-form
      // customer text with a placeholder. The heavy path above already
      // scrubbed bulk rows; this cleanup pass catches any messages that
      // landed during batching (e.g., from an in-flight LLM turn).
      // Filter by the customer's conversation ids — no direct customer
      // FK on the messages table.
      if (customerConversationIds.length > 0) {
        await tx.conversationMessage.updateMany({
          where: { conversationId: { in: customerConversationIds } },
          // audit-2026-05-25 (I9): also scrub `metadata` (Json?) —
          // defensive symmetric scrub with the heavy-path above.
          data: {
            content: CONVERSATION_MESSAGE_PLACEHOLDER,
            metadata: Prisma.JsonNull,
          },
        })
      }

      // (8) Surface 3: Conversation.customerId — null-out the FK. The
      // column is already nullable (SetNull cascade declared); messages
      // remain queryable via Conversation.sessionId for audit purposes.
      await tx.conversation.updateMany({
        where: { customerId },
        data: { customerId: null },
      })

      // (9) Surface 4: OrderStatusHistory.actorId — null-out where the
      // actor was the customer. The schema does NOT declare actorId as
      // a Prisma relation (it's a raw String column that can reference
      // Staff OR Customer, discriminated by the `actor` enum). The
      // SYNTHESIS recommendation: filter on `actor = "customer"` AND
      // `actorId = customerId` before nulling so we don't accidentally
      // null Staff actor references for actions on this customer's orders.
      await tx.orderStatusHistory.updateMany({
        where: { actor: "customer", actorId: customerId },
        data: { actorId: null },
      })

      // (10) Surface 5: OrderEventLog.payload — full-replace JSON for
      // every row whose orderId belongs to this customer. The heavy path
      // above already scrubbed bulk rows; this cleanup pass catches any
      // events written during batching. OrderEventLog has NO customer FK
      // — the link is via orderId → OrderProjection.customerId.
      if (customerOrderIds.length > 0) {
        await tx.orderEventLog.updateMany({
          where: { orderId: { in: customerOrderIds } },
          data: { payload: { anonymized: true } },
        })
      }

      // (11) Surface 6: LoyaltyAccount — null the customer linkage and
      // reset aggregate counters per G2-c pick ("scrub linkage + reset
      // balance to 0; don't delete"). The schema follow-up that made
      // `customerId` nullable + switched the FK to ON DELETE SET NULL
      // closes the prior deviation: linkage is now truly broken (column
      // set to NULL) rather than left pointing at the anonymized Customer
      // row. The row itself is retained so historical loyalty aggregates
      // (stamp velocity, redemption-rate cohorts) survive after PII is
      // purged. Counters (stamps/totalEarned/redeemed) are zeroed to
      // remove aggregate-stat reconstructability.
      // audit-2026-05-25 (I9): use a SCRUBBED:UUID sentinel instead of
      // null. Postgres treats NULL as non-distinct in UNIQUE indexes
      // (`customerId String? @unique`) so a post-anonymize upsert at
      // loyalty.service.ts:46 `loyaltyAccount.upsert({where:{customerId}})`
      // would MISS the scrubbed row (NULL != 'X') and CREATE a new
      // LoyaltyAccount pinned to the anonymized id — silently undoing
      // the G2-c "scrub linkage + reset balance" guarantee on the next
      // late-settling order.placed. The sentinel keeps the row visible
      // (operators can find scrubbed accounts), preserves UNIQUE
      // semantics (each scrub gets a fresh UUID), and the upsert finds
      // no matching row → safe create branch on legitimate post-scrub
      // calls.
      await tx.loyaltyAccount.updateMany({
        where: { customerId },
        data: {
          customerId: `SCRUBBED:${randomUUID()}`,
          stamps: 0,
          totalEarned: 0,
          redeemed: 0,
        },
      })

      // (12) Surface 7: Reservation.specialRequests — replace with empty
      // JSON array.
      //
      // Schema deviation from the task prompt: Reservation.specialRequests
      // is declared `Json @default("[]")` — NOT nullable. We cannot set it
      // to null. The schema-investigator recommendation (schema.md §"Surface
      // 7") explicitly handles this: "If empty array is semantically cleaner
      // than null, use `[]`. If null is preferred, make the field nullable
      // in a migration first (or just set to empty array)." Empty array is
      // the column's documented default — same semantic as "no special
      // requests" — and avoids a migration step that's out of Wave-A1
      // scope. The free-form pt-BR notes (allergies, accessibility) the
      // customer entered are obliterated.
      await tx.reservation.updateMany({
        where: { customerId },
        data: { specialRequests: [] },
      })
    },
    {
      timeout: ANONYMIZE_TX_TIMEOUT_MS,
      maxWait: ANONYMIZE_TX_MAX_WAIT_MS,
    },
  )

  // ── H3 wave-a1: per-surface audit emit ─────────────────────────
  //
  // Emit one AuditRecord per scrubbed surface. The records carry the
  // system-actor envelope (this is a non-LLM operator/scheduled action)
  // and an EXECUTE decision with a `business.rule_satisfied` basis
  // (the LGPD-erasure business rule was satisfied by the scrub).
  //
  // When `predecessor` is supplied, every record's `supersedes` field
  // chains back to the original `customer.anonymize` envelope so audit
  // readers can follow scrub-extension records back to the originating
  // request without join hops.
  //
  // Emission is best-effort: a failing sink does NOT fail the scrub
  // (the data is already mutated by the committed tx; failing here would
  // surface as a misleading "anonymize failed" up the stack).
  if (options?.auditSink) {
    emitScrubAuditRecords(customerId, options)
  }

  // ── H3 wave-b: Medusa cross-DB compensation kickoff ─────────────
  //
  // The 7 in-process Prisma surfaces are now scrubbed. Surface 8 — the
  // Medusa-side customer row — lives in a separate Postgres database
  // reachable only via HTTP admin API. Emit a NATS pending event so
  // the Wave-B subscriber (`customer-anonymize-medusa-resolver` in
  // apps/api) can complete the compensation chain. If the customer was
  // never linked to a Medusa row (medusaId === null, captured before
  // the TX), skip — there's nothing to scrub.
  //
  // audit-2026-05-25 (I9) — three fixes:
  //
  // 1. Drop `options?.predecessor` from the gate. The predecessor field
  //    is the audit-supersession chain pointer; coupling the cross-DB
  //    scrub kickoff to its presence meant any future caller (admin
  //    CLI, replay tool, bulk-scrub job) that omitted predecessor would
  //    silently skip the Medusa scrub. Now we publish whenever there's
  //    a medusaId to scrub.
  //
  // 2. Await the publish instead of fire-and-forget. NATS unreachable
  //    at publish time used to silently drop the event (only logged);
  //    no pending-tracking record gets written by the subscriber if
  //    the subscriber never receives the event, so the retry job
  //    finds nothing to retry. Now we await — and `customer.anonymize.
  //    medusa.pending` is in OUTBOX_EVENTS (see nats-client/index.ts)
  //    so a NATS failure writes to the Redis outbox, and the
  //    outbox-retry job re-publishes when NATS recovers. The publish
  //    promise no longer rejects on broker downtime; only catastrophic
  //    misconfig (no Redis at all) can fail, which we log + Sentry but
  //    do NOT fail the anonymize — the in-process scrub is already
  //    committed so the LGPD 30-day clock is satisfied.
  //
  // 3. Pass null predecessor when none supplied — the subscriber
  //    handles either shape (it uses parkedIntentHash for audit
  //    correlation but a null is acceptable for caller paths that
  //    don't have one).
  if (medusaIdForCompensation) {
    try {
      await publishNatsEvent("customer.anonymize.medusa.pending", {
        customerId,
        medusaId: medusaIdForCompensation,
        parkedIntentHash:
          options?.predecessor?.predecessorIntentHash ?? null,
        parkedAt: options?.predecessor?.predecessorAt ?? null,
        attempt: 1,
      })
    } catch (err) {
      // Outbox guarantees at-least-once delivery on broker recovery;
      // a thrown promise here means Redis itself is unreachable, which
      // is operationally severe but not enough to fail-back the
      // committed scrub. Log + Sentry alert.
      options?.log?.warn?.(
        "[anonymize-customer] medusa-pending publish failed (outbox unavailable):",
        (err as Error).message ?? String(err),
      )
    }
  }

  return { success: true }
}

function emitScrubAuditRecords(
  customerId: string,
  options: AnonymizeCustomerOptions,
): void {
  const auditSink = options.auditSink
  if (!auditSink) return
  const supersedes: Supersession | undefined = options.predecessor
    ? {
        predecessorIntentHash: options.predecessor.predecessorIntentHash,
        predecessorAt: options.predecessor.predecessorAt,
        reason: "replay",
      }
    : undefined
  for (const kind of SCRUB_AUDIT_KINDS) {
    try {
      const envelope = buildEnvelope({
        kind,
        payload: { customerId },
        actor: {
          principal: "system",
          sessionId: `customer.anonymize:${customerId}`,
        },
        taint: "SYSTEM",
        nonce: `${customerId}:${kind}`,
      })
      const decision = decisionExecute([
        { category: "business", code: "rule_satisfied" },
      ])
      const record = buildAuditRecord({
        envelope,
        decision,
        durationMs: 0,
        ...(supersedes !== undefined ? { supersedes } : {}),
      })
      void auditSink.emit(record).catch((err: unknown) => {
        options.log?.error?.(
          "[anonymize-customer] audit emit failed:",
          kind,
          (err as Error).message ?? String(err),
        )
      })
    } catch (err) {
      options.log?.error?.(
        "[anonymize-customer] audit record build failed:",
        kind,
        (err as Error).message ?? String(err),
      )
    }
  }
}

/** @internal — exported for unit tests. */
export const _anonymizeCustomerInternals = {
  REVIEW_BATCH_HEAVY_THRESHOLD,
  REVIEW_BATCH_SIZE,
  ANONYMIZE_TX_TIMEOUT_MS,
  ANONYMIZE_TX_MAX_WAIT_MS,
  CONVERSATION_MESSAGE_BATCH_HEAVY_THRESHOLD,
  CONVERSATION_MESSAGE_BATCH_SIZE,
  CONVERSATION_MESSAGE_PLACEHOLDER,
  ORDER_EVENT_LOG_BATCH_HEAVY_THRESHOLD,
  ORDER_EVENT_LOG_BATCH_SIZE,
} as const

/**
 * LGPD Art. 18 — Export all personal data for a customer (portability).
 */
export async function exportCustomerData(customerId: string) {
  const [customer, addresses, preferences, reviews, orderHistory] = await Promise.all([
    prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { id: true, phone: true, name: true, email: true, source: true, firstContactAt: true },
    }),
    prisma.address.findMany({ where: { customerId } }),
    prisma.customerPreferences.findUnique({ where: { customerId } }),
    prisma.review.findMany({ where: { customerId } }),
    prisma.customerOrderItem.findMany({ where: { customerId } }),
  ])

  return { customer, addresses, preferences, reviews, orderHistory }
}

export type CustomerService = ReturnType<typeof createCustomerService>
