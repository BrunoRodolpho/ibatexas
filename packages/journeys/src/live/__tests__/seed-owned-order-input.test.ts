// seed-owned-order-input.test.ts — BKL-141: the PURE planning logic of the
// governed customer-owned-order seeder (no Medusa / prisma / network). Pins
// the two things a happy-path / true-IDOR proof actually depends on: (1) the
// order metadata really stamps `customerId` (the ownership anchor
// assertOrderOwnership resolves from) and (2) the idempotency `seedKey` is
// deterministic + stable across runs.

import { describe, expect, it } from "vitest"
import {
  OWNED_ORDER_ITEM_PLAN,
  OWNED_ORDER_SEED_CUSTOMER_NAME,
  OWNED_ORDER_SEED_KEY_FIELD,
  SeedOwnedOrderInputError,
  buildOwnedOrderDraftPayload,
  buildOwnedOrderDryRunPlan,
  buildReservationSeedPlan,
  deriveOwnedOrderSeedKey,
  ownedOrderLookupPath,
} from "../seed-owned-order-input.js"

describe("deriveOwnedOrderSeedKey", () => {
  it("is deterministic — same (customer,label) always yields the same key", () => {
    const a = deriveOwnedOrderSeedKey("cust_1", "happy-path")
    const b = deriveOwnedOrderSeedKey("cust_1", "happy-path")
    expect(a).toBe(b)
  })

  it("distinguishes labels for the same customer (one customer, several owned orders)", () => {
    expect(deriveOwnedOrderSeedKey("cust_1", "happy-path")).not.toBe(
      deriveOwnedOrderSeedKey("cust_1", "idor-victim"),
    )
  })

  it("defaults the label to 'default'", () => {
    expect(deriveOwnedOrderSeedKey("cust_1")).toBe(deriveOwnedOrderSeedKey("cust_1", "default"))
  })

  it("sanitises characters unsafe in a URL query / metadata value", () => {
    const key = deriveOwnedOrderSeedKey("cus/t 1!", "a b")
    expect(key).toMatch(/^bkl141-owned-[A-Za-z0-9_-]+$/)
  })

  it("throws on an empty customerId", () => {
    expect(() => deriveOwnedOrderSeedKey("   ")).toThrow(SeedOwnedOrderInputError)
  })
})

describe("ownedOrderLookupPath", () => {
  it("filters /admin/orders on the seedKey metadata field", () => {
    const path = ownedOrderLookupPath("bkl141-owned-cust_1-default")
    expect(path).toContain(`/admin/orders?metadata[${OWNED_ORDER_SEED_KEY_FIELD}]=`)
    expect(path).toContain(encodeURIComponent("bkl141-owned-cust_1-default"))
    expect(path).toContain("limit=1")
  })
})

describe("buildOwnedOrderDraftPayload", () => {
  const resolved = {
    regionId: "reg_1",
    salesChannelId: "sc_1",
    lineItems: [
      { variant_id: "var_a", quantity: 1 },
      { variant_id: "var_b", quantity: 1 },
    ],
  }

  it("binds metadata.customerId to the target customer — the ownership anchor", () => {
    const payload = buildOwnedOrderDraftPayload({ customerId: "cust_owner" }, resolved)
    // This is THE reason BKL-141's seeder exists: assertOrderOwnership resolves
    // `customer_id ?? metadata.customerId` — so metadata.customerId MUST be set.
    expect(payload.metadata["customerId"]).toBe("cust_owner")
  })

  it("carries the deterministic seedKey in metadata for idempotency", () => {
    const payload = buildOwnedOrderDraftPayload({ customerId: "cust_owner", label: "hp" }, resolved)
    expect(payload.metadata[OWNED_ORDER_SEED_KEY_FIELD]).toBe(
      deriveOwnedOrderSeedKey("cust_owner", "hp"),
    )
  })

  it("passes the resolved line items + region + sales channel through verbatim", () => {
    const payload = buildOwnedOrderDraftPayload({ customerId: "cust_owner" }, resolved)
    expect(payload.region_id).toBe("reg_1")
    expect(payload.sales_channel_id).toBe("sc_1")
    expect(payload.items).toEqual(resolved.lineItems)
  })

  it("defaults name/email to synthetic values and honours overrides", () => {
    const dflt = buildOwnedOrderDraftPayload({ customerId: "cust_owner" }, resolved)
    expect(dflt.metadata["customerName"]).toBe(OWNED_ORDER_SEED_CUSTOMER_NAME)
    expect(dflt.email).toMatch(/@example\.com$/)

    const custom = buildOwnedOrderDraftPayload(
      { customerId: "cust_owner", customerName: "Fulano", customerEmail: "f@x.com", customerPhone: "+5511" },
      resolved,
    )
    expect(custom.metadata["customerName"]).toBe("Fulano")
    expect(custom.email).toBe("f@x.com")
    expect(custom.metadata["customerPhone"]).toBe("+5511")
  })

  it("omits customerPhone metadata when not provided", () => {
    const payload = buildOwnedOrderDraftPayload({ customerId: "cust_owner" }, resolved)
    expect(payload.metadata["customerPhone"]).toBeUndefined()
  })

  it("throws on an empty customerId", () => {
    expect(() => buildOwnedOrderDraftPayload({ customerId: "  " }, resolved)).toThrow(
      SeedOwnedOrderInputError,
    )
  })

  it("throws when there are no resolved line items (an owned order needs real lines)", () => {
    expect(() =>
      buildOwnedOrderDraftPayload({ customerId: "cust_owner" }, { ...resolved, lineItems: [] }),
    ).toThrow(/non-empty/)
  })
})

describe("buildOwnedOrderDryRunPlan", () => {
  it("returns the IO-free plan with the ownership anchor + stable key + item vocabulary", () => {
    const plan = buildOwnedOrderDryRunPlan({ customerId: "cust_owner", label: "hp" })
    expect(plan.customerId).toBe("cust_owner")
    expect(plan.metadata["customerId"]).toBe("cust_owner")
    expect(plan.seedKey).toBe(deriveOwnedOrderSeedKey("cust_owner", "hp"))
    expect(plan.itemPlan).toEqual(OWNED_ORDER_ITEM_PLAN)
    expect(plan.lookupPath).toBe(ownedOrderLookupPath(plan.seedKey))
  })

  it("throws on an empty customerId", () => {
    expect(() => buildOwnedOrderDryRunPlan({ customerId: "" })).toThrow(SeedOwnedOrderInputError)
  })
})

describe("buildReservationSeedPlan (optional reservation)", () => {
  it("builds the authed POST /api/reservations body", () => {
    const plan = buildReservationSeedPlan({ customerId: "cust_1", timeSlotId: "ts_1", partySize: 4 })
    expect(plan.customerId).toBe("cust_1")
    expect(plan.httpBody).toEqual({ timeSlotId: "ts_1", partySize: 4, specialRequests: [] })
  })

  it("passes structured special requests through", () => {
    const plan = buildReservationSeedPlan({
      customerId: "cust_1",
      timeSlotId: "ts_1",
      partySize: 2,
      specialRequests: [{ type: "birthday", notes: "bolo" }],
    })
    expect(plan.httpBody.specialRequests).toEqual([{ type: "birthday", notes: "bolo" }])
  })

  it.each([
    ["empty customerId", { customerId: "", timeSlotId: "ts_1", partySize: 2 }],
    ["empty timeSlotId", { customerId: "c", timeSlotId: " ", partySize: 2 }],
    ["zero partySize", { customerId: "c", timeSlotId: "ts_1", partySize: 0 }],
    ["non-integer partySize", { customerId: "c", timeSlotId: "ts_1", partySize: 2.5 }],
  ])("throws on %s", (_label, opts) => {
    expect(() => buildReservationSeedPlan(opts)).toThrow(SeedOwnedOrderInputError)
  })
})
