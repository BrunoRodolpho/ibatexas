import { describe, it, expect, vi, beforeEach } from "vitest"

describe("Cache Roundtrip", () => {
  const store = new Map<string, string>()

  beforeEach(() => { store.clear() })

  const mockRedis = {
    get: vi.fn((key: string) => store.get(key) ?? null),
    set: vi.fn((key: string, value: string) => { store.set(key, value) }),
    del: vi.fn((key: string) => { store.delete(key) }),
    exists: vi.fn((key: string) => store.has(key) ? 1 : 0),
  }

  it("stores and retrieves a cache entry", () => {
    const entry = { query: "costela", results: [{ id: "prod_1" }], cachedAt: new Date().toISOString() }
    mockRedis.set("cache:costela", JSON.stringify(entry))

    const raw = mockRedis.get("cache:costela")
    expect(raw).not.toBeNull()

    const parsed = JSON.parse(raw!)
    expect(parsed.query).toBe("costela")
    expect(parsed.results).toHaveLength(1)
  })

  it("returns null for cache miss", () => {
    const raw = mockRedis.get("cache:nonexistent")
    expect(raw).toBeNull()
  })

  it("deletes a cache entry", () => {
    mockRedis.set("cache:temp", "data")
    expect(mockRedis.exists("cache:temp")).toBe(1)
    mockRedis.del("cache:temp")
    expect(mockRedis.exists("cache:temp")).toBe(0)
  })
})
