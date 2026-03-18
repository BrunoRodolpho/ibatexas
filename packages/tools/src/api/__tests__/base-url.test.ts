import { describe, it, expect, vi, afterEach } from "vitest"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("getApiBase", () => {
  describe("SSR (no window)", () => {
    it("returns NEXT_PUBLIC_API_URL from env", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.ibatexas.com")
      // Ensure no window on globalThis
      vi.stubGlobal("window", undefined)

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("https://api.ibatexas.com")
    })

    it("returns http://localhost:3001 when env is unset", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "")
      vi.stubGlobal("window", undefined)

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("http://localhost:3001")
    })
  })

  describe("browser (window exists)", () => {
    it("returns configured URL origin when on localhost", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3001/v1")
      vi.stubGlobal("window", {})
      vi.stubGlobal("location", { hostname: "localhost" })

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("http://localhost:3001")
    })

    it("swaps hostname when configured is localhost but page is accessed from LAN IP", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3001")
      vi.stubGlobal("window", {})
      vi.stubGlobal("location", { hostname: "192.168.1.42" })

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("http://192.168.1.42:3001")
    })

    it("swaps hostname when configured is 127.0.0.1 but page is accessed from LAN IP", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://127.0.0.1:3001")
      vi.stubGlobal("window", {})
      vi.stubGlobal("location", { hostname: "10.0.0.5" })

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("http://10.0.0.5:3001")
    })

    it("does NOT swap when configured URL is not localhost/127.0.0.1", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.ibatexas.com")
      vi.stubGlobal("window", {})
      vi.stubGlobal("location", { hostname: "192.168.1.42" })

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("https://api.ibatexas.com")
    })

    it("does NOT swap when page hostname is localhost", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3001")
      vi.stubGlobal("window", {})
      vi.stubGlobal("location", { hostname: "localhost" })

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("http://localhost:3001")
    })

    it("returns configured value when URL constructor throws (invalid URL)", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_URL", "not-a-valid-url")
      vi.stubGlobal("window", {})
      vi.stubGlobal("location", { hostname: "192.168.1.42" })

      const { getApiBase } = await import("../base-url.js")
      expect(getApiBase()).toBe("not-a-valid-url")
    })
  })
})

describe("MEDUSA_ADMIN_URL", () => {
  it("uses NEXT_PUBLIC_MEDUSA_BACKEND_URL from env", async () => {
    vi.stubEnv("NEXT_PUBLIC_MEDUSA_BACKEND_URL", "https://admin.ibatexas.com")

    const { MEDUSA_ADMIN_URL } = await import("../base-url.js")
    expect(MEDUSA_ADMIN_URL).toBe("https://admin.ibatexas.com")
  })

  it("defaults to http://localhost:9000", async () => {
    vi.stubEnv("NEXT_PUBLIC_MEDUSA_BACKEND_URL", "")

    const { MEDUSA_ADMIN_URL } = await import("../base-url.js")
    expect(MEDUSA_ADMIN_URL).toBe("http://localhost:9000")
  })
})
