// Unit tests for isCheckoutState — pure function that detects checkout sub-states
// from XState snapshot values (both string and object forms).

import { describe, it, expect } from "vitest"
import { isCheckoutState } from "../machine/order-machine.js"

describe("isCheckoutState", () => {
  it("returns true for object form { checkout: 'confirming' }", () => {
    expect(isCheckoutState({ checkout: "confirming" })).toBe(true)
  })

  it("returns true for object form { checkout: 'processing_payment' }", () => {
    expect(isCheckoutState({ checkout: "processing_payment" })).toBe(true)
  })

  it("returns true for object form { checkout: 'order_placed' }", () => {
    expect(isCheckoutState({ checkout: "order_placed" })).toBe(true)
  })

  it("returns true for object form { checkout: 'checking_auth' }", () => {
    expect(isCheckoutState({ checkout: "checking_auth" })).toBe(true)
  })

  it("returns true for string form 'checkout'", () => {
    expect(isCheckoutState("checkout")).toBe(true)
  })

  it("returns false for object form { ordering: 'item_added' }", () => {
    expect(isCheckoutState({ ordering: "item_added" })).toBe(false)
  })

  it("returns false for string 'idle'", () => {
    expect(isCheckoutState("idle")).toBe(false)
  })

  it("returns false for string 'browsing'", () => {
    expect(isCheckoutState("browsing")).toBe(false)
  })

  it("returns false for string 'post_order'", () => {
    expect(isCheckoutState("post_order")).toBe(false)
  })

  it("returns false for null", () => {
    expect(isCheckoutState(null)).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(isCheckoutState(undefined)).toBe(false)
  })

  it("returns false for empty object {}", () => {
    expect(isCheckoutState({})).toBe(false)
  })
})
