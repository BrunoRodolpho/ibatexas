// Tests for reverseGeocode helper
// Mocks global fetch — no network calls.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { reverseGeocode } from "../reverse-geocode.js"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function nominatimResponse(postcode?: string, displayName?: string) {
  return {
    address: postcode ? { postcode } : {},
    display_name: displayName ?? null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("reverseGeocode", () => {
  it("extracts and strips non-digit characters from postcode", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => nominatimResponse("01310-100", "Av. Paulista, São Paulo"),
    })

    const result = await reverseGeocode(-23.5613, -46.6561)

    expect(result.cep).toBe("01310100")
    expect(result.formattedAddress).toBe("Av. Paulista, São Paulo")
  })

  it("returns cep: null when response has no postcode", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => nominatimResponse(undefined, "Somewhere without postcode"),
    })

    const result = await reverseGeocode(-23.5613, -46.6561)

    expect(result.cep).toBeNull()
    expect(result.formattedAddress).toBe("Somewhere without postcode")
  })

  it("returns nulls on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

    const result = await reverseGeocode(-23.5613, -46.6561)

    expect(result).toEqual({ cep: null, formattedAddress: null })
  })

  it("returns nulls when fetch throws (timeout/network error)", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("Timeout", "TimeoutError"))

    const result = await reverseGeocode(-23.5613, -46.6561)

    expect(result).toEqual({ cep: null, formattedAddress: null })
  })
})
