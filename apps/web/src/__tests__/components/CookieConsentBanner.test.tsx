// Unit tests for CookieConsentBanner component

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockUseConsentStore = vi.hoisted(() =>
  vi.fn(() => ({
    hasConsented: false,
    accept: vi.fn(),
    reject: vi.fn(),
  })),
)

vi.mock("@/domains/consent", () => ({
  useConsentStore: mockUseConsentStore,
}))

// Minimal React mock for createElement/JSX
vi.mock("react", () => ({
  default: {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...((props as Record<string, unknown>) || {}), children },
    }),
  },
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...((props as Record<string, unknown>) || {}), children },
  }),
}))

import { CookieConsentBanner } from "../../components/molecules/CookieConsentBanner"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("CookieConsentBanner", () => {
  it("renders banner when consent not given", () => {
    mockUseConsentStore.mockReturnValue({
      hasConsented: false,
      accept: vi.fn(),
      reject: vi.fn(),
    })

    const result = CookieConsentBanner()

    // Component should return JSX (not null)
    expect(result).not.toBeNull()
  })

  it("does not render when consent already given", () => {
    mockUseConsentStore.mockReturnValue({
      hasConsented: true,
      accept: vi.fn(),
      reject: vi.fn(),
    })

    const result = CookieConsentBanner()

    // Component returns null when consent is already given
    expect(result).toBeNull()
  })
})
