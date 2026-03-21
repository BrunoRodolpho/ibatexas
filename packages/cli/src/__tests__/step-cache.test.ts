// Tests for lib/step-cache.ts — step input hashing and caching.
// Mocks filesystem and crypto internals; never touches real disk.
import { describe, it, expect, beforeEach, vi } from "vitest"

// ── Mock setup ───────────────────────────────────────────────────────────────

const mockReadFile = vi.hoisted(() => vi.fn())
const mockWriteFile = vi.hoisted(() => vi.fn())
const mockMkdir = vi.hoisted(() => vi.fn())
const mockRm = vi.hoisted(() => vi.fn())

vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  rm: mockRm,
}))

// Freeze time for deterministic timestamps
vi.useFakeTimers()
vi.setSystemTime(new Date("2025-06-01T12:00:00.000Z"))

// ── Import source after mocks ────────────────────────────────────────────────

import { isStepCached, cacheStep, invalidateCache } from "../lib/step-cache.js"

// ── Tests ────────────────────────────────────────────────────────────────────

describe("isStepCached", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns null for steps that always re-run (reindex, sync-reviews, intel-*)", async () => {
    // These steps have null in STEP_INPUT_FILES, meaning they depend on runtime state
    const alwaysRerun = ["reindex", "sync-reviews", "intel-copurchase", "intel-global-score"] as const
    for (const stepName of alwaysRerun) {
      const result = await isStepCached(stepName)
      expect(result, `${stepName} should always return null`).toBeNull()
    }
    // readFile should never be called for these
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it("returns null when cache file does not exist", async () => {
    // First call: read input file for hash
    mockReadFile.mockResolvedValueOnce("file-content-v1")
    // Second call: read cache file — does not exist
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"))

    const result = await isStepCached("seed-products")
    expect(result).toBeNull()
  })

  it("returns null when input hash does not match cached hash", async () => {
    // Input file content changed
    mockReadFile.mockResolvedValueOnce("file-content-v2-CHANGED")
    // Cache file exists but with old hash
    const cacheEntry = {
      stepName: "seed-products",
      inputHash: "old-hash-value",
      completedAt: "2025-05-01T00:00:00.000Z",
      durationMs: 500,
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheEntry))

    const result = await isStepCached("seed-products")
    expect(result).toBeNull()
  })

  it("returns cached entry when input hash matches", async () => {
    // We need to compute the hash to match.
    // Read input file, compute hash, then construct matching cache entry.
    const fileContent = "seed-data-content-stable"
    mockReadFile.mockResolvedValueOnce(fileContent)

    // Compute the expected hash by running the same logic
    const { createHash } = await import("node:crypto")
    const fileHash = createHash("sha256").update(fileContent).digest("hex").slice(0, 16)
    const inputHash = createHash("sha256").update(fileHash).digest("hex").slice(0, 16)

    const cacheEntry = {
      stepName: "seed-products",
      inputHash,
      completedAt: "2025-05-30T12:00:00.000Z",
      durationMs: 1234,
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheEntry))

    const result = await isStepCached("seed-products")
    expect(result).not.toBeNull()
    expect(result!.stepName).toBe("seed-products")
    expect(result!.durationMs).toBe(1234)
  })

  it("returns null when input file is missing (hashes to 'missing')", async () => {
    // First call: input file missing
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"))

    // Even if cache file exists, the hash will be based on "missing"
    const { createHash } = await import("node:crypto")
    const missingHash = createHash("sha256").update("missing").digest("hex").slice(0, 16)
    const _inputHash = createHash("sha256").update(missingHash).digest("hex").slice(0, 16)

    const cacheEntry = {
      stepName: "seed-products",
      inputHash: "different-hash",
      completedAt: "2025-05-30T12:00:00.000Z",
      durationMs: 500,
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheEntry))

    const result = await isStepCached("seed-products")
    expect(result).toBeNull()
  })
})

describe("cacheStep", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
  })

  it("does nothing for runtime-dependent steps", async () => {
    await cacheStep("reindex", 500)
    expect(mockWriteFile).not.toHaveBeenCalled()
    expect(mockMkdir).not.toHaveBeenCalled()
  })

  it("writes cache entry for cacheable steps", async () => {
    mockReadFile.mockResolvedValueOnce("seed-data-content")

    await cacheStep("seed-products", 1500)

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".ibx/cache/steps"),
      { recursive: true },
    )
    expect(mockWriteFile).toHaveBeenCalledTimes(1)

    const [path, content] = mockWriteFile.mock.calls[0]
    expect(path).toContain("seed-products.json")

    const entry = JSON.parse(content)
    expect(entry.stepName).toBe("seed-products")
    expect(entry.durationMs).toBe(1500)
    expect(entry.completedAt).toBe("2025-06-01T12:00:00.000Z")
    expect(entry.inputHash).toBeDefined()
    expect(entry.inputHash.length).toBe(16)
  })
})

describe("invalidateCache", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRm.mockResolvedValue(undefined)
  })

  it("removes the cache directory recursively", async () => {
    await invalidateCache()
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining(".ibx/cache/steps"),
      { recursive: true, force: true },
    )
  })

  it("does not throw when directory does not exist", async () => {
    mockRm.mockRejectedValueOnce(new Error("ENOENT"))
    await expect(invalidateCache()).resolves.not.toThrow()
  })
})
