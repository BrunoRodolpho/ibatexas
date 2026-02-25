// Tests for shared config — EMBED_DIM env var parsing with NaN guard

import { describe, it, expect } from "vitest"

describe("EMBED_DIM", () => {
  it("defaults to 1536 when EMBEDDING_DIMENSION is not set", async () => {
    // The module reads process.env at import time — our test env doesn't set it
    const { EMBED_DIM } = await import("../config.js")
    expect(EMBED_DIM).toBe(1536)
  })

  it("is a valid positive integer (never NaN)", async () => {
    const { EMBED_DIM } = await import("../config.js")
    expect(Number.isFinite(EMBED_DIM)).toBe(true)
    expect(EMBED_DIM).toBeGreaterThan(0)
  })
})
