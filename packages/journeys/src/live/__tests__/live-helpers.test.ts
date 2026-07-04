// live-helpers.test.ts — unit coverage for the WS9 ops live suite's PURE
// builders (the seed input shape + the staff-JWT claim shape). No DB / prisma
// / network: these assert the money-seed contract and that the minted token is
// the exact HS256 + aud shape the api verifies.

import { describe, expect, it } from "vitest"
import { createVerifier } from "fast-jwt"
import {
  buildRefundableOrderSeed,
  WS9_DISPLAY_ID_BASE,
  WS9_ITEMS_SCHEMA_VERSION,
} from "../seed-input.js"
import {
  buildStaffJwtClaims,
  signStaffJwt,
  staffCookie,
  STAFF_COOKIE_NAME,
} from "../staff-jwt.js"

describe("buildRefundableOrderSeed", () => {
  const base = { amountInCentavos: 10_000, runId: "run-abc", displayId: 900_123 }

  it("threads the amount into the projection, full input and payment, in centavos", () => {
    const plan = buildRefundableOrderSeed(base)
    expect(plan.amountInCentavos).toBe(10_000)
    expect(plan.orderProjectionPayload.totalInCentavos).toBe(10_000)
    expect(plan.orderProjectionFullInput.totalInCentavos).toBe(10_000)
    expect(plan.orderProjectionFullInput.subtotalInCentavos).toBe(10_000)
    expect(plan.orderProjectionFullInput.itemsJson[0]?.priceInCentavos).toBe(10_000)
    expect(plan.paymentCreatePayload.amountInCentavos).toBe(10_000)
  })

  it("builds a collision-safe order id from the run id and a test-band display id", () => {
    const plan = buildRefundableOrderSeed({ ...base, displayId: 900_500 })
    expect(plan.orderId).toBe("order_ws9_refund_run-abc")
    expect(plan.displayId).toBe(900_500)
    expect(plan.displayId).toBeGreaterThanOrEqual(WS9_DISPLAY_ID_BASE)
  })

  it("defaults to a nullable-customer cash order and pins the paid transition + schema version", () => {
    const plan = buildRefundableOrderSeed(base)
    expect(plan.method).toBe("cash")
    expect(plan.customerId).toBeNull()
    expect(plan.orderProjectionPayload.customerId).toBeNull()
    expect(plan.orderProjectionFullInput.itemsSchemaVersion).toBe(WS9_ITEMS_SCHEMA_VERSION)
    expect(plan.orderProjectionFullInput.fulfillmentStatus).toBe("pending")
    expect(plan.paidTransition).toEqual({ newStatus: "paid", actor: "system" })
  })

  it("honours an explicit method and customer id", () => {
    const plan = buildRefundableOrderSeed({ ...base, method: "pix", customerId: "cust_1" })
    expect(plan.method).toBe("pix")
    expect(plan.paymentCreatePayload.method).toBe("pix")
    expect(plan.customerId).toBe("cust_1")
  })

  it("rejects a non-positive / non-integer amount", () => {
    expect(() => buildRefundableOrderSeed({ ...base, amountInCentavos: 0 })).toThrow()
    expect(() => buildRefundableOrderSeed({ ...base, amountInCentavos: -5 })).toThrow()
    expect(() => buildRefundableOrderSeed({ ...base, amountInCentavos: 1.5 })).toThrow()
  })

  it("rejects a bad display id or empty run id", () => {
    expect(() => buildRefundableOrderSeed({ ...base, displayId: 0 })).toThrow()
    expect(() => buildRefundableOrderSeed({ ...base, runId: "  " })).toThrow()
  })
})

describe("buildStaffJwtClaims + signStaffJwt", () => {
  it("produces the exact claim shape the api verifies", () => {
    const claims = buildStaffJwtClaims({ staffId: "staff_1", role: "OWNER", jti: "jti-1" })
    expect(claims).toEqual({
      sub: "staff_1",
      userType: "staff",
      role: "OWNER",
      jti: "jti-1",
      aud: "staff_token",
    })
  })

  it("rejects empty sub, unknown role, empty jti", () => {
    expect(() => buildStaffJwtClaims({ staffId: " ", role: "OWNER", jti: "j" })).toThrow()
    // @ts-expect-error — exercising the runtime guard with a bad role
    expect(() => buildStaffJwtClaims({ staffId: "s", role: "ADMIN", jti: "j" })).toThrow()
    expect(() => buildStaffJwtClaims({ staffId: "s", role: "OWNER", jti: "" })).toThrow()
  })

  it("signs a verifiable HS256 token carrying the aud the staff cookie binds to", () => {
    // A short, low-entropy dummy signing key (HS256 accepts any non-empty key);
    // deliberately NOT a long random-looking literal, so no secret scanner trips.
    const secret = "test-secret"
    const claims = buildStaffJwtClaims({ staffId: "staff_2", role: "MANAGER", jti: "jti-2" })
    const token = signStaffJwt(claims, { secret })
    const verify = createVerifier({ key: secret, allowedAud: STAFF_COOKIE_NAME })
    const decoded = verify(token) as Record<string, unknown>
    expect(decoded.sub).toBe("staff_2")
    expect(decoded.userType).toBe("staff")
    expect(decoded.role).toBe("MANAGER")
    expect(decoded.aud).toBe("staff_token")
    expect(typeof decoded.exp).toBe("number")
  })

  it("refuses to sign with an empty secret", () => {
    const claims = buildStaffJwtClaims({ staffId: "s", role: "OWNER", jti: "j" })
    expect(() => signStaffJwt(claims, { secret: "" })).toThrow()
  })

  it("staffCookie yields the single cookie pair the api reads", () => {
    expect(staffCookie("abc.def.ghi")).toBe("staff_token=abc.def.ghi")
  })
})
