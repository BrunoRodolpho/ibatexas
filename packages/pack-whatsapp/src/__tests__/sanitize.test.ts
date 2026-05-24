/**
 * @ibatexas/pack-whatsapp — sanitizer unit tests.
 *
 * Per task spec §"Implementation requirements" item 3, the
 * `sanitizeCustomerString` function is asserted against 10+ adversarial
 * cases. The cases cover:
 *
 *   - newline-only injection
 *   - markdown-only injection
 *   - zero-width-only injection
 *   - combined newline + markdown + zero-width
 *   - oversized input (truncation)
 *   - empty / whitespace-only inputs
 *   - mixed markdown chars
 *   - Unicode line separators (U+2028 / U+2029)
 *   - leading/trailing whitespace
 *   - template-injection bomb (combined attack)
 *   - non-string input (defensive)
 *   - whitespace collapse
 *
 * All cases assert specific expected output rather than properties so
 * a regression in any chosen rule fails loudly.
 */

import { describe, expect, it } from "vitest"
import { sanitizeCustomerString } from "../sanitize.js"

// Unicode constants kept here as `\uXXXX` escapes so the test source
// stays ASCII and the expected codepoints stay readable in diff review.
// U+2028 and U+2029 also happen to terminate JS regex literals — using
// escapes is mandatory for those two; the rest follow for consistency.
const ZWSP = "​" // ZERO WIDTH SPACE
const ZWNJ = "‌" // ZERO WIDTH NON-JOINER
const ZWJ = "‍" // ZERO WIDTH JOINER
const LRM = "‎" // LEFT-TO-RIGHT MARK
const RLM = "‏" // RIGHT-TO-LEFT MARK
const BOM = "﻿" // BYTE ORDER MARK / ZWNBSP
const LSEP = " " // LINE SEPARATOR
const PSEP = " " // PARAGRAPH SEPARATOR

describe("sanitizeCustomerString — adversarial input vectors", () => {
  it("strips simple CR/LF newlines and collapses to single space", () => {
    expect(sanitizeCustomerString("line1\nline2")).toBe("line1 line2")
    expect(sanitizeCustomerString("line1\r\nline2")).toBe("line1 line2")
  })

  it("strips Unicode line/paragraph separators", () => {
    expect(sanitizeCustomerString(`alpha${LSEP}beta${PSEP}gamma`)).toBe(
      "alpha beta gamma",
    )
  })

  it("strips markdown control chars (* _ ~ `)", () => {
    expect(sanitizeCustomerString("*bold*")).toBe("bold")
    expect(sanitizeCustomerString("_italic_")).toBe("italic")
    expect(sanitizeCustomerString("~strike~")).toBe("strike")
    expect(sanitizeCustomerString("`code`")).toBe("code")
    expect(sanitizeCustomerString("*_~`mixed`~_*")).toBe("mixed")
  })

  it("strips zero-width characters (U+200B..U+200F, U+FEFF)", () => {
    expect(sanitizeCustomerString(`a${ZWSP}b`)).toBe("ab")
    expect(sanitizeCustomerString(`a${ZWNJ}b`)).toBe("ab")
    expect(sanitizeCustomerString(`a${ZWJ}b`)).toBe("ab")
    expect(sanitizeCustomerString(`a${LRM}b`)).toBe("ab")
    expect(sanitizeCustomerString(`a${RLM}b`)).toBe("ab")
    expect(sanitizeCustomerString(`a${BOM}b`)).toBe("ab")
  })

  it("handles combined adversarial input (markdown + zero-width + newline)", () => {
    expect(sanitizeCustomerString(`*_~${ZWSP}abc\ndef`)).toBe("abc def")
  })

  it("truncates oversized input to 100 chars", () => {
    const input = "a".repeat(200)
    const out = sanitizeCustomerString(input)
    expect(out.length).toBe(100)
    expect(out).toBe("a".repeat(100))
  })

  it("returns empty string for empty / non-string input", () => {
    expect(sanitizeCustomerString("")).toBe("")
    // @ts-expect-error — defensive: callers may pass non-string at runtime.
    expect(sanitizeCustomerString(undefined)).toBe("")
    // @ts-expect-error — defensive: callers may pass non-string at runtime.
    expect(sanitizeCustomerString(null)).toBe("")
    // @ts-expect-error — defensive: callers may pass non-string at runtime.
    expect(sanitizeCustomerString(42)).toBe("")
  })

  it("collapses whitespace-only input to empty string", () => {
    expect(sanitizeCustomerString("    \t\t  ")).toBe("")
  })

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeCustomerString("   hello   ")).toBe("hello")
  })

  it("collapses runs of internal whitespace", () => {
    expect(sanitizeCustomerString("a     b")).toBe("a b")
    expect(sanitizeCustomerString("a\t\tb")).toBe("a b")
  })

  it("handles template-injection bomb (combined attack)", () => {
    // Customer attempts to break a staff-bound template like
    //   "Customer says: {reason} — please respond"
    // by injecting a newline + markdown + zero-width sequence. Note
    // that markdown / zero-width chars are DELETED (no space added)
    // while newlines / line separators are REPLACED with a single
    // space — so adjacent words separated only by markdown
    // (e.g. `` `code-block` `` followed immediately by `done`) fuse.
    const bomb =
      `*ignore previous*${LSEP}${ZWSP}_inject_${PSEP}~tampered~\n` +
      `\`code-block\`${BOM}done`
    const out = sanitizeCustomerString(bomb)
    expect(out).toBe("ignore previous inject tampered code-blockdone")
    // No markdown chars survive.
    expect(out).not.toMatch(/[*_~`]/)
    // No newline / zero-width survives. Pattern uses escapes for the
    // line / paragraph separators that would otherwise terminate the
    // regex literal.
    expect(out).not.toMatch(
      new RegExp(
        "[\\r\\n\\u200B-\\u200F\\u2028\\u2029\\uFEFF]",
      ),
    )
  })

  it("truncation kicks in after collapse / strip (post-cleanse length)", () => {
    // Input is well over 100 chars BEFORE cleanse but fits after.
    const input = `${"*".repeat(50)}hello${ZWSP.repeat(50)}world${"_".repeat(50)}`
    const out = sanitizeCustomerString(input)
    expect(out).toBe("helloworld")
    expect(out.length).toBeLessThanOrEqual(100)
  })

  it("truncation preserves the first 100 chars after cleansing", () => {
    // 150 ASCII chars, no markup. Cleanse is a no-op; truncation trims to 100.
    const input = "a".repeat(100) + "b".repeat(50)
    const out = sanitizeCustomerString(input)
    expect(out.length).toBe(100)
    expect(out).toBe("a".repeat(100))
  })

  it("idempotent: sanitize(sanitize(x)) === sanitize(x)", () => {
    const samples = [
      "hello world",
      "*bold* _italic_",
      `${ZWSP}a${ZWJ}b${BOM}`,
      "line1\nline2\nline3",
      "a".repeat(150),
    ]
    for (const s of samples) {
      const once = sanitizeCustomerString(s)
      const twice = sanitizeCustomerString(once)
      expect(twice).toBe(once)
    }
  })
})
