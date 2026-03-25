// Unit tests for FirstVisitBanner component

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockDismiss = vi.hoisted(() => vi.fn())

const mockUseFirstVisit = vi.hoisted(() =>
  vi.fn(() => ({
    isFirstVisit: true,
    dismiss: mockDismiss,
  })),
)

const mockTrack = vi.hoisted(() => vi.fn())

vi.mock("@/domains/session/useFirstVisit", () => ({
  useFirstVisit: mockUseFirstVisit,
}))

vi.mock("@/domains/analytics/track", () => ({
  track: mockTrack,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("../atoms", () => ({
  LinkButton: ({ children, href }: { children: unknown; href: string }) => ({
    type: "a",
    props: { href, children },
  }),
}))

vi.mock("lucide-react", () => ({
  X: () => ({ type: "svg", props: {} }),
}))

// Minimal React mock
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

import { FirstVisitBanner } from "../../components/molecules/FirstVisitBanner"

beforeEach(() => {
  vi.clearAllMocks()
  // Reset env var
  process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = "5511999887766"
})

describe("FirstVisitBanner", () => {
  it("renders banner when isFirstVisit is true", () => {
    mockUseFirstVisit.mockReturnValue({ isFirstVisit: true, dismiss: mockDismiss })

    const result = FirstVisitBanner()

    expect(result).not.toBeNull()
  })

  it("returns null when not first visit", () => {
    mockUseFirstVisit.mockReturnValue({ isFirstVisit: false, dismiss: mockDismiss })

    const result = FirstVisitBanner()

    expect(result).toBeNull()
  })

  it("renders WhatsApp CTA link with wa.me href", () => {
    mockUseFirstVisit.mockReturnValue({ isFirstVisit: true, dismiss: mockDismiss })

    const result = FirstVisitBanner() as { props: { children: unknown[] } } | null
    expect(result).not.toBeNull()

    // The rendered output is a React element tree — serialize and check for wa.me
    const rendered = JSON.stringify(result)
    expect(rendered).toContain("wa.me")
    expect(rendered).toContain("5511999887766")
  })

  it("wa.me link uses NEXT_PUBLIC_WHATSAPP_NUMBER env var", () => {
    process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = "5521988776655"
    mockUseFirstVisit.mockReturnValue({ isFirstVisit: true, dismiss: mockDismiss })

    const rendered = JSON.stringify(FirstVisitBanner())
    expect(rendered).toContain("5521988776655")
  })

  it("falls back to placeholder when env var is not set", () => {
    delete process.env.NEXT_PUBLIC_WHATSAPP_NUMBER
    mockUseFirstVisit.mockReturnValue({ isFirstVisit: true, dismiss: mockDismiss })

    const rendered = JSON.stringify(FirstVisitBanner())
    expect(rendered).toContain("wa.me")
    // fallback value present
    expect(rendered).toContain("5500000000000")
  })
})
