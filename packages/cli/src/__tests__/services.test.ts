// Tests for services.ts — service definitions and resolveServices.
// Pure data + logic; no mocks needed.
import { describe, it, expect } from "vitest"
import {
  SERVICES,
  resolveServices,
} from "../services.js"

// ── Service registry structure ───────────────────────────────────────────────

describe("SERVICES registry", () => {
  it("has at least commerce, api, web", () => {
    expect(SERVICES.commerce).toBeDefined()
    expect(SERVICES.api).toBeDefined()
    expect(SERVICES.web).toBeDefined()
  })

  for (const [key, svc] of Object.entries(SERVICES)) {
    describe(`service: ${key}`, () => {
      it("key field matches its registry key", () => {
        expect(svc.key).toBe(key)
      })

      it("has a non-empty name", () => {
        expect(svc.name.length).toBeGreaterThan(0)
      })

      it("has a non-empty filter (pnpm workspace)", () => {
        expect(svc.filter.length).toBeGreaterThan(0)
        expect(svc.filter).toContain("@ibatexas/")
      })

      it("has a non-empty script", () => {
        expect(svc.script.length).toBeGreaterThan(0)
      })

      it("port is a valid port number", () => {
        expect(svc.port).toBeGreaterThan(0)
        expect(svc.port).toBeLessThanOrEqual(65535)
      })

      it("logColor is a function", () => {
        expect(typeof svc.logColor).toBe("function")
      })

      it("logPrefix is a non-empty string", () => {
        expect(svc.logPrefix.length).toBeGreaterThan(0)
      })

      it("step is a positive integer", () => {
        expect(svc.step).toBeGreaterThan(0)
        expect(Number.isInteger(svc.step)).toBe(true)
      })

      it("urls is a non-empty array", () => {
        expect(svc.urls.length).toBeGreaterThan(0)
        for (const u of svc.urls) {
          expect(u.label.length).toBeGreaterThan(0)
          expect(u.url).toMatch(/^https?:\/\//)
        }
      })
    })
  }

  it("no duplicate ports across services", () => {
    const ports = Object.values(SERVICES).map((s) => s.port)
    const unique = new Set(ports)
    expect(unique.size).toBe(ports.length)
  })

  it("no duplicate logPrefixes across services", () => {
    const prefixes = Object.values(SERVICES).map((s) => s.logPrefix)
    const unique = new Set(prefixes)
    expect(unique.size).toBe(prefixes.length)
  })
})

// ── resolveServices ──────────────────────────────────────────────────────────

describe("resolveServices", () => {
  it("returns all available services when key is undefined", () => {
    const result = resolveServices(undefined)
    const available = Object.values(SERVICES).filter((s) => s.available)
    expect(result).toHaveLength(available.length)
  })

  it('returns all available services when key is "default"', () => {
    const result = resolveServices("default")
    const available = Object.values(SERVICES).filter((s) => s.available)
    expect(result).toHaveLength(available.length)
  })

  it('returns all available services when key is "all"', () => {
    const result = resolveServices("all")
    const available = Object.values(SERVICES).filter((s) => s.available)
    expect(result).toHaveLength(available.length)
  })

  it("returns a single service when key is a known service", () => {
    const result = resolveServices("commerce")
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("commerce")
  })

  it("returns a single service for api", () => {
    const result = resolveServices("api")
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("api")
  })

  it("throws for an unknown service key", () => {
    expect(() => resolveServices("nonexistent")).toThrow(
      /Unknown service "nonexistent"/,
    )
  })

  it("error message lists valid options", () => {
    try {
      resolveServices("bad-key")
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain("commerce")
      expect(msg).toContain("api")
      expect(msg).toContain("web")
      expect(msg).toContain("all")
    }
  })
})
