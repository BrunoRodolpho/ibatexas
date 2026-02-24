// Tests for embeddings client
// Mocks Claude API and Redis

import { describe, it, expect, beforeEach, vi } from "vitest"
import { cosineSimilarity } from "../../utils/vectors.js"

describe("Embeddings", () => {
  describe("cosineSimilarity", () => {
    it("should compute similarity for identical vectors", () => {
      const a = [1, 0, 0]
      const b = [1, 0, 0]
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0)
    })

    it("should compute similarity for orthogonal vectors", () => {
      const a = [1, 0, 0]
      const b = [0, 1, 0]
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0)
    })

    it("should compute similarity for opposite vectors", () => {
      const a = [1, 0, 0]
      const b = [-1, 0, 0]
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0)
    })

    it("should handle normalized vectors", () => {
      const a = [0.6, 0.8]
      const b = [0.6, 0.8]
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0)
    })

    it("should throw on dimension mismatch", () => {
      const a = [1, 0, 0]
      const b = [1, 0]
      expect(() => cosineSimilarity(a, b)).toThrow()
    })

    it("should handle zero vectors", () => {
      const a = [0, 0, 0]
      const b = [1, 1, 1]
      expect(cosineSimilarity(a, b)).toBe(0)
    })
  })
})
