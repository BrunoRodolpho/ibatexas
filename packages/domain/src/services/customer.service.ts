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

import { prisma } from "../client.js"
import type { Channel } from "@ibatexas/types"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import {
  customerOnboardingPolicyBundle,
  type CustomerCreatePayload,
  type CustomerPreferencesUpdatePayload,
  type CustomerPixDetailsSavePayload,
  type CustomerAnonymizePayload,
  type CustomerOnboardingState,
} from "@ibatexas/pack-customer-onboarding"
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
          // Pack's allergenExclusions / dietaryFlags are ReadonlyArray<string>;
          // service's update method accepts string[].
          return this.updatePreferences(extras.customerId, {
            allergenExclusions: payload.allergenExclusions as string[],
            ...(payload.dietaryFlags !== undefined
              ? { dietaryRestrictions: payload.dietaryFlags as string[] }
              : {}),
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
      const result = await anonymizeCustomer(payload.customerId)
      return result as { success: true }
    },
    adjudicateOptions,
  )
}

/**
 * LGPD Art. 18 — Anonymize a customer's personal data.
 * Preserves order items (fiscal obligation) but delinks from profile.
 */
export async function anonymizeCustomer(customerId: string) {
  await prisma.$transaction(async (tx) => {
    // Anonymize profile
    await tx.customer.update({
      where: { id: customerId },
      data: { name: "Usuário Removido", email: null },
    })

    // Delete addresses
    await tx.address.deleteMany({ where: { customerId } })

    // Delete preferences
    await tx.customerPreferences.deleteMany({ where: { customerId } })

    // Delink order items (preserve for fiscal/analytics)
    await tx.customerOrderItem.updateMany({
      where: { customerId },
      data: { customerId: null },
    })
  })

  return { success: true }
}

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
