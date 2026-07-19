// NEW-014 — compile-time + runtime sync between the Prisma `FiscalStatus` enum
// (schema.prisma) and the `@ibatexas/types` FiscalStatus const (the
// PaymentStatus/OrderFulfillmentStatus discipline: the DB enum and the shared
// const must never drift).

import { describe, expect, it } from "vitest"
import { FiscalStatus as PrismaFiscalStatus } from "../generated/prisma-client/client.js"
import { FiscalStatus, TERMINAL_FISCAL_STATUSES } from "@ibatexas/types"

describe("NEW-014 — FiscalStatus enum sync (Prisma ⟷ @ibatexas/types)", () => {
  it("the two value sets are identical", () => {
    const prismaValues = Object.values(PrismaFiscalStatus).sort()
    const typeValues = Object.values(FiscalStatus).sort()
    expect(prismaValues).toEqual(typeValues)
  })

  it("terminal statuses are members (approved = done, rejected = never auto-retried)", () => {
    for (const s of TERMINAL_FISCAL_STATUSES) {
      expect(Object.values(PrismaFiscalStatus)).toContain(s)
    }
    expect(TERMINAL_FISCAL_STATUSES).toEqual(["approved", "rejected"])
  })
})
