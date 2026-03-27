// LoyaltyService — punch-card loyalty program.
// 10 stamps = R$20 discount (coupon FIEL20 — must be created in Medusa admin).
// stamps resets to 0 after reward; totalEarned is a lifetime counter.

import { prisma } from "../client.js"

const STAMPS_FOR_REWARD = 10

export function createLoyaltyService() {
  return {
    async getOrCreateAccount(customerId: string) {
      return prisma.loyaltyAccount.upsert({
        where: { customerId },
        create: { customerId },
        update: {},
      })
    },

    async addStamp(customerId: string): Promise<{ stamps: number; rewarded: boolean }> {
      // Atomic: upsert ensures account exists, then increment + check in a transaction
      return prisma.$transaction(async (tx) => {
        // Ensure account exists
        await tx.loyaltyAccount.upsert({
          where: { customerId },
          create: { customerId },
          update: {},
        })

        // Atomic increment — avoids TOCTOU race on concurrent order.placed events
        const updated = await tx.loyaltyAccount.update({
          where: { customerId },
          data: { stamps: { increment: 1 }, totalEarned: { increment: 1 } },
        })

        if (updated.stamps >= STAMPS_FOR_REWARD) {
          await tx.loyaltyAccount.update({
            where: { customerId },
            data: { stamps: 0, redeemed: { increment: 1 } },
          })
          return { stamps: 0, rewarded: true }
        }

        return { stamps: updated.stamps, rewarded: false }
      })
    },

    async getBalance(customerId: string) {
      const account = await this.getOrCreateAccount(customerId)
      return {
        stamps: account.stamps,
        stampsNeeded: STAMPS_FOR_REWARD - account.stamps,
        totalEarned: account.totalEarned,
        redeemed: account.redeemed,
      }
    },
  }
}

export type LoyaltyService = ReturnType<typeof createLoyaltyService>
