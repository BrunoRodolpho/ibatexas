// Unit tests for the IbateXas system prompt — verify intelligence tool coverage

import { describe, it, expect } from "vitest"

import { SYSTEM_PROMPT } from "../system-prompt.js"

describe("SYSTEM_PROMPT", () => {
  it("includes intelligence tools section", () => {
    expect(SYSTEM_PROMPT).toContain("get_customer_profile")
    expect(SYSTEM_PROMPT).toContain("get_recommendations")
  })

  it("includes all 5 intelligence tool names", () => {
    expect(SYSTEM_PROMPT).toContain("get_customer_profile")
    expect(SYSTEM_PROMPT).toContain("get_recommendations")
    expect(SYSTEM_PROMPT).toContain("get_ordered_together")
    expect(SYSTEM_PROMPT).toContain("get_also_added")
    expect(SYSTEM_PROMPT).toContain("update_preferences")
  })
})
