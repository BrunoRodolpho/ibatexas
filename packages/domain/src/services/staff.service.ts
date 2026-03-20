// StaffService — centralizes staff domain logic.
//
// Handles: staff lookup by phone, staff lookup by ID.
// Staff records are created manually (seed or admin panel) — not via OTP flow.

import { prisma } from "../client.js"

// ── Service ───────────────────────────────────────────────────────────────────

export function createStaffService() {
  return {
    /**
     * Find a staff member by phone number.
     * Returns null if not found (caller decides whether to 404).
     */
    async findByPhone(phone: string) {
      return prisma.staff.findUnique({
        where: { phone },
      })
    },

    /**
     * Find a staff member by ID.
     * Throws if not found (used after JWT verification — staff must exist).
     */
    async getById(staffId: string) {
      return prisma.staff.findUniqueOrThrow({
        where: { id: staffId },
      })
    },
  }
}

export type StaffService = ReturnType<typeof createStaffService>
