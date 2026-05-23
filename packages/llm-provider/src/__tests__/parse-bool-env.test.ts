// Unit tests for parseBoolEnv (NEW-P1-ENV).
//
// Audit hidden bug #9: every `process.env.X === "true"` site silently
// returns false for "TRUE", "1", "yes", and whitespace variants. The
// helper centralises a tolerant + canonical truth table so all 7
// migration sites share the same semantics.

import { describe, it, expect } from "vitest"
import { parseBoolEnv } from "../parse-bool-env.js"

describe("parseBoolEnv — NEW-P1-ENV strict-yet-tolerant boolean env parsing", () => {
  // ── Truthy inputs ────────────────────────────────────────────────────
  it("accepts 'true' (lowercase)", () => {
    expect(parseBoolEnv("true", false)).toBe(true)
  })
  it("accepts 'True' (PascalCase)", () => {
    expect(parseBoolEnv("True", false)).toBe(true)
  })
  it("accepts 'TRUE' (uppercase)", () => {
    expect(parseBoolEnv("TRUE", false)).toBe(true)
  })
  it("accepts '1' (numeric flag)", () => {
    expect(parseBoolEnv("1", false)).toBe(true)
  })
  it("accepts 'yes'", () => {
    expect(parseBoolEnv("yes", false)).toBe(true)
  })
  it("accepts 'YES' uppercase", () => {
    expect(parseBoolEnv("YES", false)).toBe(true)
  })
  it("accepts 'on'", () => {
    expect(parseBoolEnv("on", false)).toBe(true)
  })
  it("trims leading + trailing whitespace then accepts truthy", () => {
    expect(parseBoolEnv("  true  ", false)).toBe(true)
    expect(parseBoolEnv("\ttrue\n", false)).toBe(true)
  })

  // ── Falsy inputs ────────────────────────────────────────────────────
  it("accepts 'false'", () => {
    expect(parseBoolEnv("false", true)).toBe(false)
  })
  it("accepts 'False'", () => {
    expect(parseBoolEnv("False", true)).toBe(false)
  })
  it("accepts 'FALSE'", () => {
    expect(parseBoolEnv("FALSE", true)).toBe(false)
  })
  it("accepts '0'", () => {
    expect(parseBoolEnv("0", true)).toBe(false)
  })
  it("accepts 'no'", () => {
    expect(parseBoolEnv("no", true)).toBe(false)
  })
  it("accepts 'off'", () => {
    expect(parseBoolEnv("off", true)).toBe(false)
  })

  // ── Default-value fallback ──────────────────────────────────────────
  it("returns defaultValue=true for undefined", () => {
    expect(parseBoolEnv(undefined, true)).toBe(true)
  })
  it("returns defaultValue=false for undefined", () => {
    expect(parseBoolEnv(undefined, false)).toBe(false)
  })
  it("returns defaultValue=true for empty string", () => {
    expect(parseBoolEnv("", true)).toBe(true)
  })
  it("returns defaultValue=false for empty string", () => {
    expect(parseBoolEnv("", false)).toBe(false)
  })
  it("returns defaultValue=true for whitespace-only", () => {
    expect(parseBoolEnv("   ", true)).toBe(true)
    expect(parseBoolEnv("\n\t", true)).toBe(true)
  })
  it("returns defaultValue for unrecognised text", () => {
    expect(parseBoolEnv("maybe", true)).toBe(true)
    expect(parseBoolEnv("maybe", false)).toBe(false)
    expect(parseBoolEnv("2", true)).toBe(true)
    expect(parseBoolEnv("typo", false)).toBe(false)
  })

  // ── Regression: the canonical audit-spec table ──────────────────────
  it("matches the audit spec table case-by-case", () => {
    const cases: Array<[string | undefined, boolean]> = [
      ["true", true],
      ["True", true],
      ["TRUE", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["False", false],
      ["0", false],
      ["no", false],
    ]
    for (const [input, expected] of cases) {
      expect(parseBoolEnv(input, !expected), `case=${input}`).toBe(expected)
    }
    // Empty + undefined fall through to defaultValue.
    expect(parseBoolEnv("", true)).toBe(true)
    expect(parseBoolEnv("", false)).toBe(false)
    expect(parseBoolEnv(undefined, true)).toBe(true)
    expect(parseBoolEnv(undefined, false)).toBe(false)
  })
})
