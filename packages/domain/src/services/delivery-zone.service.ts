// DeliveryZoneService — centralizes delivery zone domain logic.
//
// Handles: CRUD operations, CEP prefix matching.
// Used by admin routes and estimate_delivery tool.

import { prisma } from "../client.js"

// ── Service ───────────────────────────────────────────────────────────────────

export function createDeliveryZoneService() {
  return {
    /** List all delivery zones ordered by name. */
    async listAll() {
      return prisma.deliveryZone.findMany({ orderBy: { name: "asc" } })
    },

    /** Create a new delivery zone. */
    async create(data: {
      name: string
      cepPrefixes: string[]
      feeInCentavos: number
      estimatedMinutes: number
      active?: boolean
    }) {
      return prisma.deliveryZone.create({ data })
    },

    /** Update an existing delivery zone. */
    async update(
      id: string,
      data: {
        name: string
        cepPrefixes: string[]
        feeInCentavos: number
        estimatedMinutes: number
        active?: boolean
      },
    ) {
      return prisma.deliveryZone.update({ where: { id }, data })
    },

    /** Delete a delivery zone. */
    async remove(id: string) {
      return prisma.deliveryZone.delete({ where: { id } })
    },

    /**
     * Find an active zone matching a CEP prefix.
     * Used by estimate_delivery tool.
     */
    async findActiveByPrefix(prefix5: string, fullCep: string) {
      const zones = await prisma.deliveryZone.findMany({ where: { active: true } })
      return (
        zones.find((z) =>
          z.cepPrefixes.some((p) => p === prefix5 || fullCep.startsWith(p)),
        ) ?? null
      )
    },

    /**
     * Find all active zones that have GPS center coordinates set.
     * Used by estimate_delivery Haversine fallback when CEP is unavailable.
     */
    async findActiveWithCoords() {
      return prisma.deliveryZone.findMany({
        where: {
          active: true,
          centerLat: { not: null },
          centerLng: { not: null },
          radiusKm: { not: null },
        },
      })
    },
  }
}

export type DeliveryZoneService = ReturnType<typeof createDeliveryZoneService>
