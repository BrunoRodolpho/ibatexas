// FE-D22 — the PURE read-tool scoring adapter (score.ts). No IO, no model.

import { describe, expect, it } from "vitest"
import { deepEqualArgs, scoreReadToolCase } from "../score.js"
import type { ReadToolCorpusCase } from "../schema.js"

function caseOf(over: Partial<ReadToolCorpusCase>): ReadToolCorpusCase {
  return { id: "c1", utterance: "u", expectArgs: {}, ...over }
}

describe("deepEqualArgs", () => {
  it("is key-order-insensitive for objects", () => {
    expect(deepEqualArgs({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })
  it("is order-SENSITIVE for arrays", () => {
    expect(deepEqualArgs({ x: [1, 2] }, { x: [1, 2] })).toBe(true)
    expect(deepEqualArgs({ x: [1, 2] }, { x: [2, 1] })).toBe(false)
  })
  it("compares nested structures + distinguishes missing/extra keys", () => {
    expect(deepEqualArgs({ a: { b: [{ c: "x" }] } }, { a: { b: [{ c: "x" }] } })).toBe(true)
    expect(deepEqualArgs({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(deepEqualArgs({ a: 1, b: 2 }, { a: 1 })).toBe(false)
  })
  it("distinguishes scalar mismatches and empty vs non-empty", () => {
    expect(deepEqualArgs({}, {})).toBe(true)
    expect(deepEqualArgs({ a: "1" }, { a: 1 })).toBe(false)
    expect(deepEqualArgs({}, { a: 1 })).toBe(false)
  })
})

describe("scoreReadToolCase — expectArgs modes", () => {
  it("null (sound abstain): ok iff the tool was NOT called", () => {
    const c = caseOf({ id: "abstain", expectArgs: null })
    expect(scoreReadToolCase("check_order_status", c, null).ok).toBe(true)
    const fired = scoreReadToolCase("check_order_status", c, { sanitizedInput: { orderReference: "IBX-1" } })
    expect(fired.ok).toBe(false)
    expect(fired.failures[0]).toContain("sound abstain")
  })

  it("{} (argless call expected): ok iff the tool was called with empty args", () => {
    const c = caseOf({ id: "argless", expectArgs: {} })
    expect(scoreReadToolCase("get_my_reservations", c, { sanitizedInput: {} }).ok).toBe(true)
    // not called → fail
    expect(scoreReadToolCase("get_my_reservations", c, null).ok).toBe(false)
    // called WITH args → fail (surplus)
    expect(scoreReadToolCase("get_my_reservations", c, { sanitizedInput: { x: 1 } }).ok).toBe(false)
  })

  it("concrete args: ok iff the sanitized input deep-equals expectArgs", () => {
    const c = caseOf({ id: "concrete", expectArgs: { orderReference: "IBX-42" } })
    expect(
      scoreReadToolCase("check_order_status", c, { sanitizedInput: { orderReference: "IBX-42" } }).ok,
    ).toBe(true)
    const mismatch = scoreReadToolCase("check_order_status", c, {
      sanitizedInput: { orderReference: "IBX-99" },
    })
    expect(mismatch.ok).toBe(false)
    expect(mismatch.failures[0]).toContain("args mismatch")
    // not called → fail (distinct message)
    const absent = scoreReadToolCase("check_order_status", c, null)
    expect(absent.ok).toBe(false)
    expect(absent.failures[0]).toContain("not called")
  })

  it("carries the accuracy key fields (capability=tool, caseId, utterance)", () => {
    const c = caseOf({ id: "k", utterance: "cadê meu pedido?", expectArgs: {} })
    const r = scoreReadToolCase("check_order_status", c, { sanitizedInput: {} })
    expect(r).toMatchObject({ capability: "check_order_status", caseId: "k", utterance: "cadê meu pedido?" })
  })
})
