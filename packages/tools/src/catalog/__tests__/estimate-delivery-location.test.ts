// Tests for GPS-pin path in estimateDelivery
// Mocks: @ibatexas/domain, ./reverse-geocode.js, global fetch (ViaCEP)
// No DB, no network.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { estimateDelivery } from "../estimate-delivery.js"

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mockFindActiveByPrefix = vi.hoisted(() => vi.fn())
const mockFindActiveWithCoords = vi.hoisted(() => vi.fn())
const mockReverseGeocode = vi.hoisted(() => vi.fn())
const mockFetch = vi.hoisted(() => vi.fn())

const mockListAll = vi.hoisted(() => vi.fn())

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    findActiveByPrefix: mockFindActiveByPrefix,
    findActiveWithCoords: mockFindActiveWithCoords,
    listAll: mockListAll,
  }),
}))

vi.mock("../reverse-geocode.js", () => ({
  reverseGeocode: mockReverseGeocode,
}))

vi.stubGlobal("fetch", mockFetch)

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ZONE_SP = {
  id: "zone_1",
  name: "Centro-SP",
  cepPrefixes: ["01310"],
  feeInCentavos: 500,
  estimatedMinutes: 40,
  active: true,
  centerLat: "-23.5505",
  centerLng: "-46.6333",
  radiusKm: 10,
  createdAt: new Date(),
  updatedAt: new Date(),
}

function mockViaCepOk(cep: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ cep, logradouro: "Av. Paulista" }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("estimateDelivery — GPS pin → reverse geocode → CEP match (happy path)", () => {
  it("resolves zone via geocoded CEP", async () => {
    mockReverseGeocode.mockResolvedValueOnce({ cep: "01310100", formattedAddress: "Av. Paulista" })
    mockViaCepOk("01310100")
    mockFindActiveByPrefix.mockResolvedValueOnce(ZONE_SP)

    const result = await estimateDelivery({ latitude: -23.5505, longitude: -46.6333 })

    expect(result.success).toBe(true)
    expect(result.zoneName).toBe("Centro-SP")
    expect(result.feeInCentavos).toBe(500)
    expect(result.estimatedMinutes).toBe(40)
    expect(mockFindActiveWithCoords).not.toHaveBeenCalled()
  })
})

describe("estimateDelivery — GPS pin → reverse geocode fails → Haversine fallback", () => {
  it("falls back to Haversine when geocoding returns no CEP", async () => {
    mockReverseGeocode.mockResolvedValueOnce({ cep: null, formattedAddress: null })
    mockFindActiveWithCoords.mockResolvedValueOnce([ZONE_SP])

    const result = await estimateDelivery({ latitude: -23.5505, longitude: -46.6333 })

    expect(result.success).toBe(true)
    expect(result.zoneName).toBe("Centro-SP")
    expect(mockFindActiveByPrefix).not.toHaveBeenCalled()
  })

  it("falls back to Haversine when CEP prefix match yields no zone", async () => {
    mockReverseGeocode.mockResolvedValueOnce({ cep: "01310100", formattedAddress: "Av. Paulista" })
    mockViaCepOk("01310100")
    // prefix match returns null — triggers Haversine
    mockFindActiveByPrefix.mockResolvedValueOnce(null)
    mockFindActiveWithCoords.mockResolvedValueOnce([ZONE_SP])

    const result = await estimateDelivery({ latitude: -23.5505, longitude: -46.6333 })

    expect(result.success).toBe(true)
    expect(result.zoneName).toBe("Centro-SP")
  })
})

describe("estimateDelivery — GPS pin → both paths fail → out-of-area", () => {
  it("returns out-of-area message when no zone matches", async () => {
    mockReverseGeocode.mockResolvedValueOnce({ cep: null, formattedAddress: null })
    mockFindActiveWithCoords.mockResolvedValueOnce([])

    const result = await estimateDelivery({ latitude: -15.7801, longitude: -47.9292 })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/área de entrega/)
  })
})

describe("estimateDelivery — Haversine accuracy", () => {
  it("matches a zone whose center is within radiusKm", async () => {
    // Coordinates ~1km from ZONE_SP center (-23.5505, -46.6333)
    mockReverseGeocode.mockResolvedValueOnce({ cep: null, formattedAddress: null })
    mockFindActiveWithCoords.mockResolvedValueOnce([ZONE_SP])

    const result = await estimateDelivery({ latitude: -23.5600, longitude: -46.6400 })

    expect(result.success).toBe(true)
  })

  it("does not match a zone whose center is beyond radiusKm", async () => {
    // Coordinates ~100km from ZONE_SP center
    mockReverseGeocode.mockResolvedValueOnce({ cep: null, formattedAddress: null })
    mockFindActiveWithCoords.mockResolvedValueOnce([ZONE_SP])

    const result = await estimateDelivery({ latitude: -22.9068, longitude: -43.1729 }) // Rio de Janeiro

    expect(result.success).toBe(false)
  })
})

describe("estimateDelivery — validation", () => {
  it("lists active delivery zones when neither cep nor lat/lng are provided", async () => {
    mockListAll.mockResolvedValueOnce([ZONE_SP])

    const result = await estimateDelivery({})

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/CEP/)
  })

  it("returns error when no active delivery zones exist", async () => {
    mockListAll.mockResolvedValueOnce([])

    const result = await estimateDelivery({})

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/retirada/)
  })
})
