// Tests for the embeddings client (FE-D17 — fail honest, never a pseudo-vector).
// Mock-based; no Redis, no network.
//
// The load-bearing regression: with no OPENAI_API_KEY the client used to return
// a deterministic hash "embedding" (semantically meaningless), which made
// Typesense vector search "match" arbitrary products — live-demonstrated with
// 'coca' AND 'xyzzy' both hitting the same unrelated item. The client now THROWS
// a named EmbeddingsUnavailableError and RETHROWS every generation failure, so
// callers degrade to keyword-only search / index-without-embedding instead.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// ── Mutable mock controls ───────────────────────────────────────────────────
let getMock = vi.fn<(key: string) => Promise<string | null>>()
let setExMock = vi.fn<(key: string, ttl: number, value: string) => Promise<unknown>>()

vi.mock("../../redis/client.js", () => ({
  getRedisClient: async () => ({
    get: (k: string) => getMock(k),
    setEx: (k: string, ttl: number, v: string) => setExMock(k, ttl, v),
  }),
}))

// rk() passthrough — key namespacing is the caller's concern (asserted in the
// search-products / index-product suites); here we just need a stable key.
vi.mock("../../redis/key.js", () => ({
  rk: (s: string) => s,
}))

// Import AFTER mocks (vitest hoists vi.mock).
const { generateEmbedding, EmbeddingsUnavailableError, embeddingCacheVersion, assertEmbeddingProviderDimension } =
  await import("../client.js")

const ORIGINAL_KEY = process.env.OPENAI_API_KEY

describe("generateEmbedding", () => {
  beforeEach(() => {
    getMock = vi.fn(async () => null) // cache miss by default
    setExMock = vi.fn(async () => undefined)
    vi.stubGlobal("fetch", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY
  })

  describe("fail-honest when no key is configured (FE-D17)", () => {
    it("throws EmbeddingsUnavailableError — never returns a vector", async () => {
      delete process.env.OPENAI_API_KEY

      await expect(generateEmbedding("coca", "k:1")).rejects.toBeInstanceOf(
        EmbeddingsUnavailableError,
      )
    })

    it("never calls the OpenAI API when the key is unset", async () => {
      delete process.env.OPENAI_API_KEY
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      await expect(generateEmbedding("coca", "k:2")).rejects.toThrow()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("does not cache anything on failure", async () => {
      delete process.env.OPENAI_API_KEY

      await expect(generateEmbedding("coca", "k:3")).rejects.toBeInstanceOf(
        EmbeddingsUnavailableError,
      )
      expect(setExMock).not.toHaveBeenCalled()
    })

    it("the named error carries a stable .name for log/trace matching", () => {
      expect(new EmbeddingsUnavailableError().name).toBe("EmbeddingsUnavailableError")
    })
  })

  describe("rethrows OpenAI errors (never falls back to a pseudo-vector)", () => {
    it("rethrows when the OpenAI API returns a non-ok status", async () => {
      process.env.OPENAI_API_KEY = "sk-test"
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 500,
          statusText: "Server Error",
          text: async () => "boom",
        })),
      )

      await expect(generateEmbedding("coca", "k:4")).rejects.toThrow(/Embedding API failed/)
      expect(setExMock).not.toHaveBeenCalled()
    })

    it("rethrows when the fetch call itself rejects (network/timeout)", async () => {
      process.env.OPENAI_API_KEY = "sk-test"
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("network down")
        }),
      )

      await expect(generateEmbedding("coca", "k:5")).rejects.toThrow(/network down/)
    })
  })

  describe("cache-hit path (read before generate)", () => {
    it("returns the cached vector without generating — even with no key configured", async () => {
      delete process.env.OPENAI_API_KEY
      const cachedVector = [0.11, 0.22, 0.33]
      getMock = vi.fn(async () => JSON.stringify(cachedVector))
      const fetchMock = vi.fn()
      vi.stubGlobal("fetch", fetchMock)

      const result = await generateEmbedding("coca", "k:cached")

      expect(result).toEqual(cachedVector)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("reads the cache at the exact key it is handed (no rewriting)", async () => {
      getMock = vi.fn(async () => JSON.stringify([0.1]))

      await generateEmbedding("coca", "embedding:query:v2:abc")

      expect(getMock).toHaveBeenCalledWith("embedding:query:v2:abc")
    })
  })

  describe("input validation", () => {
    it("throws on empty text before touching Redis or OpenAI", async () => {
      await expect(generateEmbedding("", "k:empty")).rejects.toThrow(/empty text/)
      expect(getMock).not.toHaveBeenCalled()
    })
  })
})

// ── REVIEW FIX (2026-07-17): the success arm — generation → EMBED_DIM check →
// cache write — was untested (the suite covered only failure paths).
describe("success arm (generation → dim check → cache write)", () => {
  // This describe sits OUTSIDE the "generateEmbedding" block above, so its
  // beforeEach does not apply here — reset the shared mocks locally.
  beforeEach(() => {
    getMock = vi.fn(async () => null)
    setExMock = vi.fn(async () => undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY
  })

  it("resolves with the generated vector and caches it via setEx(key, ttl, JSON)", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    const { EMBED_DIM } = await import("../../config.js")
    const vector = Array.from({ length: EMBED_DIM }, (_, i) => i / EMBED_DIM)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      })),
    )

    const result = await generateEmbedding("costela", "k:ok", 123)

    expect(result).toEqual(vector)
    expect(setExMock).toHaveBeenCalledTimes(1)
    const [key, ttl, json] = setExMock.mock.calls[0]
    expect(key).toBe("k:ok")
    expect(ttl).toBe(123)
    expect(JSON.parse(json)).toEqual(vector)
  })

  it("rejects a wrong-dimension vector with /Invalid embedding/ and caches nothing", async () => {
    process.env.OPENAI_API_KEY = "test-key"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      })),
    )

    await expect(generateEmbedding("costela", "k:short")).rejects.toThrow(/Invalid embedding/)
    expect(setExMock).not.toHaveBeenCalled()
  })
})

// ── BKL-034 — local Ollama embeddings provider ──────────────────────────────
describe("EMBEDDINGS_PROVIDER=ollama (local embedder, BKL-034)", () => {
  const SAVED = {
    provider: process.env.EMBEDDINGS_PROVIDER,
    url: process.env.OLLAMA_EMBED_URL,
    model: process.env.OLLAMA_EMBED_MODEL,
    key: process.env.OPENAI_API_KEY,
  }

  beforeEach(() => {
    getMock = vi.fn(async () => null)
    setExMock = vi.fn(async () => undefined)
    process.env.EMBEDDINGS_PROVIDER = "ollama"
    process.env.OLLAMA_EMBED_URL = "http://localhost:11434"
    process.env.OLLAMA_EMBED_MODEL = "nomic-embed-text"
    delete process.env.OPENAI_API_KEY // ollama needs no OpenAI key
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v)
    restore("EMBEDDINGS_PROVIDER", SAVED.provider)
    restore("OLLAMA_EMBED_URL", SAVED.url)
    restore("OLLAMA_EMBED_MODEL", SAVED.model)
    restore("OPENAI_API_KEY", SAVED.key)
  })

  it("routes to the Ollama /api/embeddings endpoint with { model, prompt } and returns { embedding }", async () => {
    // Return an EMBED_DIM-length vector so the per-call dimension guard passes
    // (default EMBED_DIM = 1536); the point of this test is the routing + body.
    const vec = Array.from({ length: 1536 }, () => 0.01)
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ embedding: vec }) }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await generateEmbedding("costela", "k:ollama")

    expect(result).toEqual(vec)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe("http://localhost:11434/api/embeddings")
    const body = JSON.parse(init.body)
    expect(body).toEqual({ model: "nomic-embed-text", prompt: "costela" })
  })

  it("throws EmbeddingsUnavailableError (never a vector, never a fetch) when OLLAMA_EMBED_URL/MODEL is unset", async () => {
    delete process.env.OLLAMA_EMBED_URL
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(generateEmbedding("coca", "k:noollama")).rejects.toBeInstanceOf(EmbeddingsUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rethrows on an Ollama non-ok status (fail-honest — no pseudo-vector, no cache write)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, statusText: "Server Error", text: async () => "boom" })),
    )
    await expect(generateEmbedding("coca", "k:ollamaerr")).rejects.toThrow(/Ollama embedding API failed/)
    expect(setExMock).not.toHaveBeenCalled()
  })
})

describe("embeddingCacheVersion (provider-derived namespace, BKL-034)", () => {
  const SAVED = process.env.EMBEDDINGS_PROVIDER
  afterEach(() => {
    if (SAVED === undefined) delete process.env.EMBEDDINGS_PROVIDER
    else process.env.EMBEDDINGS_PROVIDER = SAVED
  })

  it("is v2 for openai (default) and v3 for ollama — never the same space", () => {
    delete process.env.EMBEDDINGS_PROVIDER
    expect(embeddingCacheVersion()).toBe("v2")
    process.env.EMBEDDINGS_PROVIDER = "openai"
    expect(embeddingCacheVersion()).toBe("v2")
    process.env.EMBEDDINGS_PROVIDER = "ollama"
    expect(embeddingCacheVersion()).toBe("v3")
    // read at CALL time (not frozen at import)
    process.env.EMBEDDINGS_PROVIDER = "openai"
    expect(embeddingCacheVersion()).toBe("v2")
  })
})

describe("assertEmbeddingProviderDimension (startup sanity check, BKL-034)", () => {
  const SAVED = {
    provider: process.env.EMBEDDINGS_PROVIDER,
    url: process.env.OLLAMA_EMBED_URL,
    model: process.env.OLLAMA_EMBED_MODEL,
    key: process.env.OPENAI_API_KEY,
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v)
    restore("EMBEDDINGS_PROVIDER", SAVED.provider)
    restore("OLLAMA_EMBED_URL", SAVED.url)
    restore("OLLAMA_EMBED_MODEL", SAVED.model)
    restore("OPENAI_API_KEY", SAVED.key)
  })

  it("no-ops when no provider is configured (keyword-only degrade — nothing to check)", async () => {
    process.env.EMBEDDINGS_PROVIDER = "openai"
    delete process.env.OPENAI_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(assertEmbeddingProviderDimension()).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws a loud dimension-mismatch error when the model dim != EMBEDDING_DIMENSION", async () => {
    process.env.EMBEDDINGS_PROVIDER = "ollama"
    process.env.OLLAMA_EMBED_URL = "http://localhost:11434"
    process.env.OLLAMA_EMBED_MODEL = "nomic-embed-text"
    // Default EMBED_DIM is 1536; return a 768-vector → mismatch.
    const vec768 = Array.from({ length: 768 }, () => 0.01)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ embedding: vec768 }) })))
    await expect(assertEmbeddingProviderDimension()).rejects.toThrow(/dimension mismatch/i)
  })
})
