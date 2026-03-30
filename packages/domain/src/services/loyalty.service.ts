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
      const account = await this.getOrCreateAccount(customerId)
      const newStamps = account.stamps + 1

      if (newStamps >= STAMPS_FOR_REWARD) {
        // Reward earned — reset stamps, increment redeemed
        await prisma.loyaltyAccount.update({
          where: { customerId },
          data: { stamps: 0, totalEarned: { increment: 1 }, redeemed: { increment: 1 } },
        })
        return { stamps: 0, rewarded: true }
      }

      await prisma.loyaltyAccount.update({
        where: { customerId },
        data: { stamps: newStamps, totalEarned: { increment: 1 } },
      })
      return { stamps: newStamps, rewarded: false }
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
