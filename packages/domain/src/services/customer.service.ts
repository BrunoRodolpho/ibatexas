// CustomerService — centralizes customer domain logic.
//
// Handles: customer upsert, preference updates (Prisma side), review creation.
// Cache (Redis profile hash) stays in the tools layer — services are pure Prisma.

import { prisma } from "../client.js"
import { toE164BR } from "../phone.js"
import type { Channel } from "@ibatexas/types"

// ── Service ───────────────────────────────────────────────────────────────────

export function createCustomerService() {
  return {
    /**
     * Create or update a customer record from a verified phone number.
     * Called after OTP verification.
     */
    async upsertFromPhone(phone: string, name?: string) {
      // P2-DATA-PHONENORM: canonicalize at the @unique boundary so the same
      // number never splits into two rows because a caller passed `whatsapp:+…`
      // or a formatted variant. Idempotent on the already-validated `+<digits>`
      // the callers pass today; never touches the BR 9th digit (no merge risk).
      const canonical = toE164BR(phone)
      return prisma.customer.upsert({
        where: { phone: canonical },
        create: { phone: canonical, name: name ?? null },
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
  }
}

/**
 * LGPD Art. 18 — Erase a customer's personal data.
 *
 * Erases the primary identifiers and free-text PII (phone, CPF, review prose,
 * conversation transcripts), not just name/email. Preserves order items (fiscal
 * obligation) but delinks them from the profile. Idempotent via the `erasedAt`
 * marker so a re-submit (or a retry) is a safe no-op rather than re-running.
 *
 * Returns `{ success, alreadyErased }`. `alreadyErased: true` means the marker
 * was already set (nothing to do); `success: false` means no such customer.
 */
export async function anonymizeCustomer(
  customerId: string,
): Promise<{ success: boolean; alreadyErased: boolean }> {
  return await prisma.$transaction(async (tx) => {
    const existing = await tx.customer.findUnique({
      where: { id: customerId },
      select: { erasedAt: true },
    })
    if (!existing) return { success: false, alreadyErased: false }
    if (existing.erasedAt) return { success: true, alreadyErased: true }

    // Anonymize profile. `phone` is @unique + NON-nullable (the WhatsApp identity
    // that re-links everything on re-contact), so it cannot be nulled — overwrite
    // it with a per-customer tombstone so the real number no longer resolves here.
    // `cpf` (Brazilian tax id) is nullable → null it.
    await tx.customer.update({
      where: { id: customerId },
      data: {
        name: "Usuário Removido",
        email: null,
        phone: `removed:${customerId}`,
        cpf: null,
        erasedAt: new Date(),
      },
    })

    // Delete addresses + preferences (PII).
    await tx.address.deleteMany({ where: { customerId } })
    await tx.customerPreferences.deleteMany({ where: { customerId } })

    // Redact free-text review prose; keep the numeric rating for analytics.
    await tx.review.updateMany({ where: { customerId }, data: { comment: null } })

    // Delete conversation transcripts. ConversationMessage cascades on the
    // conversation FK (onDelete: Cascade), so the message bodies go with it.
    await tx.conversation.deleteMany({ where: { customerId } })

    // Delink order items (preserve for fiscal/analytics).
    await tx.customerOrderItem.updateMany({
      where: { customerId },
      data: { customerId: null },
    })

    return { success: true, alreadyErased: false }
  })
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
