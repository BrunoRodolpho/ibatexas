import { afterEach, describe, expect, it } from "vitest"
import {
  _resetEnforceConfig,
  isEnforced,
  isShadowed,
} from "../intent-enforce-config.js"

describe("intent-enforce-config", () => {
  afterEach(() => {
    _resetEnforceConfig()
  })

  it("returns false for both when env vars are unset", () => {
    expect(isShadowed("order.submit", {})).toBe(false)
    expect(isEnforced("order.submit", {})).toBe(false)
  })

  it("parses comma-separated intent kinds for shadow", () => {
    const env = { IBX_KERNEL_SHADOW: "order.submit,payment.confirm" }
    expect(isShadowed("order.submit", env)).toBe(true)
    expect(isShadowed("payment.confirm", env)).toBe(true)
    expect(isShadowed("refund.issue", env)).toBe(false)
  })

  it("parses comma-separated intent kinds for enforce independently", () => {
    const env = {
      IBX_KERNEL_SHADOW: "order.submit",
      IBX_KERNEL_ENFORCE: "apply_coupon,update_preferences",
    }
    expect(isShadowed("order.submit", env)).toBe(true)
    expect(isShadowed("apply_coupon", env)).toBe(false)
    expect(isEnforced("apply_coupon", env)).toBe(true)
    expect(isEnforced("order.submit", env)).toBe(false)
  })

  it("supports wildcard `*` for blanket coverage", () => {
    expect(isShadowed("anything.at.all", { IBX_KERNEL_SHADOW: "*" })).toBe(true)
    expect(isEnforced("anything.at.all", { IBX_KERNEL_ENFORCE: "*" })).toBe(true)
  })

  it("trims whitespace around comma-separated values", () => {
    const env = { IBX_KERNEL_SHADOW: " order.submit ,  payment.confirm  " }
    expect(isShadowed("order.submit", env)).toBe(true)
    expect(isShadowed("payment.confirm", env)).toBe(true)
  })

  it("ignores empty entries", () => {
    const env = { IBX_KERNEL_SHADOW: ",order.submit,," }
    expect(isShadowed("order.submit", env)).toBe(true)
    expect(isShadowed("", env)).toBe(false)
  })

  it("recomputes when env values change between calls", () => {
    expect(isEnforced("order.submit", { IBX_KERNEL_ENFORCE: "" })).toBe(false)
    expect(
      isEnforced("order.submit", { IBX_KERNEL_ENFORCE: "order.submit" }),
    ).toBe(true)
  })
})
