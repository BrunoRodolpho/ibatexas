// LoyaltyService — punch-card loyalty program.
// 10 stamps = R$20 discount (coupon FIEL20 — must be created in Medusa admin).
// stamps resets to 0 after reward; totalEarned is a lifetime counter.
//
// ── Audit 2026-05-23 NEW-W9-V4 — kernel chokepoint for addStamp ─────────
//
// `addStamp` persists rows on the Prisma `loyaltyAccount` table — it is
// NOT a Redis-only analytics counter (the open-blockers carve-out
// previously misclassified it). The only caller today is
// `apps/api/src/subscribers/cart-intelligence.ts:order.placed`, a
// system-actor path. Per CLAUDE.md rule #9 + investigation 04, every
// subscriber-driven mutation flows through `adjudicate()` via the
// `*FromEnvelope` entry point on the service. The bare `addStamp` method
// is retained (legacy bare-arg shape, Decision D8) so the
// `addStampFromEnvelope` executor can reuse it.

import { prisma } from "../client.js"
import type { AuditSink, IntentEnvelope } from "@adjudicate/core"
import {
  loyaltyPolicyBundle,
  type LoyaltyStampAddPayload,
  type LoyaltyState,
} from "./__shared__/loyalty-policy.js"
import {
  withAdjudicate,
  type AdjudicatedResult,
} from "./__shared__/with-adjudicate.js"

const STAMPS_FOR_REWARD = 10

export interface LoyaltyServiceOptions {
  readonly auditSink?: AuditSink
  readonly log?: {
    readonly warn?: (...args: unknown[]) => void
    readonly error?: (...args: unknown[]) => void
  }
}

export function createLoyaltyService(options?: LoyaltyServiceOptions) {
  const adjudicateOptions = {
    ...(options?.auditSink ? { auditSink: options.auditSink } : {}),
    ...(options?.log ? { log: options.log } : {}),
  } as const

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

    // ── Audit 2026-05-23 NEW-W9-V4: envelope-typed entry point ────────

    /**
     * Envelope-typed entry point for `loyalty.stamp.add`. SYSTEM-only —
     * the `cart-intelligence` `order.placed` subscriber is the only
     * caller today. Routes through the kernel before mutating the
     * Prisma `loyaltyAccount` row.
     */
    async addStampFromEnvelope(
      envelope: IntentEnvelope<"loyalty.stamp.add", LoyaltyStampAddPayload>,
      state: LoyaltyState,
    ): Promise<AdjudicatedResult<{ stamps: number; rewarded: boolean }>> {
      return withAdjudicate(
        envelope,
        state,
        loyaltyPolicyBundle,
        async (payload) => {
          return this.addStamp(payload.customerId)
        },
        adjudicateOptions,
      )
    },
  }
}

export type LoyaltyService = ReturnType<typeof createLoyaltyService>
