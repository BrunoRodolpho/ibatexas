// Unit tests for /lista-desejos page — verify empty state and product grid rendering

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockUseWishlistStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { items: [] as string[] }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseProducts = vi.hoisted(() =>
  vi.fn(() => ({ data: null as unknown, loading: false, error: null })),
)

const mockUseCartStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { items: [], addItem: vi.fn() }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseUIStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { addToast: vi.fn(), openCartDrawer: vi.fn() }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseTranslations = vi.hoisted(() =>
  vi.fn(() => (key: string) => key),
)

const mockUseMemo = vi.hoisted(() =>
  vi.fn((fn: () => unknown) => fn()),
)

vi.mock("@/domains/wishlist", () => ({
  useWishlistStore: mockUseWishlistStore,
}))

vi.mock("@/domains/product", () => ({
  useProducts: mockUseProducts,
}))

vi.mock("@/domains/cart", () => ({
  useCartStore: mockUseCartStore,
}))

vi.mock("@/domains/ui", () => ({
  useUIStore: mockUseUIStore,
}))

vi.mock("next-intl", () => ({
  useTranslations: mockUseTranslations,
}))

const MockComponent = vi.hoisted(() =>
  class {
    props: unknown
    constructor(props: unknown) { this.props = props }
    render(): unknown { return null }
  }
)

const mockUseState = vi.hoisted(() =>
  vi.fn((initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()]),
)

const mockUseEffect = vi.hoisted(() => vi.fn())
const mockUseRef = vi.hoisted(() => vi.fn((initial: unknown) => ({ current: initial })))
const mockUseCallback = vi.hoisted(() => vi.fn((fn: unknown) => fn))

vi.mock("react", () => ({
  default: {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...((props as Record<string, unknown>) || {}), children },
    }),
    useMemo: mockUseMemo,
    useState: mockUseState,
    useEffect: mockUseEffect,
    useRef: mockUseRef,
    useCallback: mockUseCallback,
    Component: MockComponent,
  },
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...((props as Record<string, unknown>) || {}), children },
  }),
  useMemo: mockUseMemo,
  useState: mockUseState,
  useEffect: mockUseEffect,
  useRef: mockUseRef,
  useCallback: mockUseCallback,
  Component: MockComponent,
}))

vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: unknown) => {
    if (typeof type === "function") return (type as (p: unknown) => unknown)(props)
    return { type, props }
  },
  jsxs: (type: unknown, props: unknown) => {
    if (typeof type === "function") return (type as (p: unknown) => unknown)(props)
    return { type, props }
  },
  Fragment: (props: { children?: unknown }) => props.children,
}))

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children?: unknown; href?: string }) => ({
    type: "a",
    props: { href, children },
  }),
}))

vi.mock("@/domains/analytics", () => ({
  track: vi.fn(),
}))

vi.mock("@/components/organisms", () => ({
  ProductGrid: (props: unknown) => ({ type: "ProductGrid", props }),
}))

vi.mock("lucide-react", () => ({
  Heart: () => ({ type: "svg", props: {} }),
  ShoppingBag: () => ({ type: "svg", props: {} }),
}))

vi.mock("@/domains/recommendations", () => ({
  useRecommendations: vi.fn(() => ({ data: [], loading: false, error: null })),
}))

vi.mock("@/domains/analytics", () => ({
  track: vi.fn(),
}))

import WishlistPage from "../../app/[locale]/lista-desejos/page"

beforeEach(() => {
  vi.clearAllMocks()
  mockUseTranslations.mockReturnValue((key: string) => key)
})

describe("WishlistPage", () => {
  it("renders empty state when wishlist is empty", () => {
    mockUseWishlistStore.mockImplementation((selector?: unknown) => {
      const state = { items: [] as string[], _hydrated: true }
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
    })
    mockUseProducts.mockReturnValue({ data: null, loading: false, error: null })
    mockUseMemo.mockReturnValue([])

    const tree = WishlistPage() as { type?: { name?: string } }

    // JSX returns an element referencing the EmptyWishlist component function
    expect(tree?.type).toBeDefined()
    expect(typeof tree?.type === "function" ? tree.type.name : tree?.type).toBe("EmptyWishlist")
  })

  it("renders product grid when wishlist has items", () => {
    const mockItems = [
      { id: "prod-1", title: "Costela Bovina", variants: [], allergens: [] },
      { id: "prod-2", title: "Frango Grelhado", variants: [], allergens: [] },
    ]

    mockUseWishlistStore.mockImplementation((selector?: unknown) => {
      const state = { items: ["prod-1", "prod-2"], _hydrated: true }
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
    })
    mockUseProducts.mockReturnValue({
      data: { items: mockItems, total: 2 },
      loading: false,
      error: null,
    })
    mockUseMemo.mockReturnValue(mockItems)

    const tree = WishlistPage()

    // Recursively find a node with type matching typeName (string or function name)
    function findNode(node: unknown, typeName: string): boolean {
      if (node == null || typeof node !== "object") return false
      if (Array.isArray(node)) return node.some((child) => findNode(child, typeName))
      const n = node as { type?: unknown; props?: { children?: unknown } }
      if (n.type === typeName) return true
      if (typeof n.type === "function" && (n.type as { name?: string }).name === typeName) return true
      return findNode(n.props?.children, typeName)
    }

    expect(findNode(tree, "ProductGrid")).toBe(true)
  })
})
