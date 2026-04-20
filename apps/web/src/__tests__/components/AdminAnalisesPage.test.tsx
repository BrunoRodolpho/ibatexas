// Unit tests for AdminAnalisesPage organism — new acquisition stat cards

import { describe, it, expect, vi } from "vitest"

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

// Mock lucide-react icons used by AdminAnalisesPage and StatCard
vi.mock("lucide-react", () => ({
  ShoppingCart: "ShoppingCart",
  DollarSign: "DollarSign",
  TrendingUp: "TrendingUp",
  ShoppingBag: "ShoppingBag",
  UserPlus: "UserPlus",
  MessageCircle: "MessageCircle",
  MessageSquare: "MessageSquare",
  Percent: "Percent",
  TrendingDown: "TrendingDown",
  Minus: "Minus",
  BarChart2: "BarChart2",
}))

import { AdminAnalisesPage } from "../../../../../packages/ui/src/organisms/AdminAnalisesPage"

const mockMetrics = {
  ordersToday: 12,
  revenueToday: 108000,
  aov: 9000,
  activeCarts: 3,
  newCustomers30d: 47,
  outreachWeekly: 82,
  waConversionRate: 40,
  avgMessagesToCheckout: 6,
}

describe("AdminAnalisesPage", () => {
  it("renders without throwing when metrics are provided", () => {
    expect(() => {
      AdminAnalisesPage({ metrics: mockMetrics, loading: false })
    }).not.toThrow()
  })

  it("renders without throwing when metrics are null (loading state)", () => {
    expect(() => {
      AdminAnalisesPage({ metrics: null, loading: true })
    }).not.toThrow()
  })

  it("renders without throwing when metrics are null and not loading", () => {
    expect(() => {
      AdminAnalisesPage({ metrics: null, loading: false })
    }).not.toThrow()
  })

  it("displays newCustomers30d value from metrics", () => {
    const result = AdminAnalisesPage({ metrics: mockMetrics, loading: false }) as {
      props: { children: unknown[] }
    }
    // Traverse JSX tree as plain objects to verify the value appears
    const json = JSON.stringify(result)
    expect(json).toContain("47")
    expect(json).toContain("Novos Clientes")
  })

  it("displays outreachWeekly value from metrics", () => {
    const result = AdminAnalisesPage({ metrics: mockMetrics, loading: false })
    const json = JSON.stringify(result)
    expect(json).toContain("82")
    expect(json).toContain("Outreach Semanal")
  })
})
