// Unit tests for Header component — auth-dependent rendering

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockUseSessionStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { userType: "guest" as "guest" | "customer" | "staff" }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseCartStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { items: [] }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseWishlistStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { items: [] as string[] }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseUIStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = { openCartDrawer: vi.fn() }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

const mockUseTranslations = vi.hoisted(() =>
  vi.fn(() => (key: string) => key),
)

const mockUsePathname = vi.hoisted(() => vi.fn(() => "/"))

const mockUseState = vi.hoisted(() => vi.fn((initial: unknown) => [initial, vi.fn()]))
const mockUseRef = vi.hoisted(() => vi.fn((initial: unknown) => ({ current: initial })))
const mockUseEffect = vi.hoisted(() => vi.fn())

vi.mock("@/domains/session", () => ({
  useSessionStore: mockUseSessionStore,
}))

vi.mock("@/domains/cart", () => ({
  useCartStore: mockUseCartStore,
}))

vi.mock("@/domains/wishlist", () => ({
  useWishlistStore: mockUseWishlistStore,
}))

vi.mock("@/domains/ui", () => ({
  useUIStore: mockUseUIStore,
}))

vi.mock("next-intl", () => ({
  useTranslations: mockUseTranslations,
}))

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, ...rest }: { children?: unknown; href?: string; [key: string]: unknown }) => ({
    type: "a",
    props: { href, ...rest, children },
  }),
  usePathname: mockUsePathname,
}))

vi.mock("@/domains/analytics", () => ({
  track: vi.fn(),
}))

vi.mock("lucide-react", () => ({
  Heart: () => ({ type: "svg", props: {} }),
}))

vi.mock("react", () => ({
  default: {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...((props as Record<string, unknown>) || {}), children },
    }),
    useState: mockUseState,
    useRef: mockUseRef,
    useEffect: mockUseEffect,
  },
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...((props as Record<string, unknown>) || {}), children },
  }),
  useState: mockUseState,
  useRef: mockUseRef,
  useEffect: mockUseEffect,
}))

import { Header } from "../../components/Header"

/** Recursively collect all string content from a JSX tree. */
function collectText(node: unknown): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(collectText).join("")
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { props?: { children?: unknown } }).props
    return collectText(props?.children)
  }
  return ""
}

/** Recursively collect all href values from link nodes. */
function collectHrefs(node: unknown): string[] {
  if (node == null || typeof node !== "object") return []
  if (Array.isArray(node)) return node.flatMap((child) => collectHrefs(child))
  const n = node as { type?: unknown; props?: { href?: string; children?: unknown } }
  const hrefs: string[] = []
  if (n.props?.href) hrefs.push(n.props.href)
  if (n.props?.children) hrefs.push(...collectHrefs(n.props.children))
  return hrefs
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseTranslations.mockReturnValue((key: string) => key)
  mockUsePathname.mockReturnValue("/")
  mockUseState.mockImplementation((initial: unknown) => [initial, vi.fn()])
  mockUseRef.mockImplementation((initial: unknown) => ({ current: initial }))
  mockUseEffect.mockImplementation(() => undefined)
})

describe("Header", () => {
  it("shows Entrar link when user is guest", () => {
    mockUseSessionStore.mockImplementation((selector?: unknown) => {
      const state = { userType: "guest" as const }
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
    })

    const tree = Header()
    const text = collectText(tree)

    expect(text).toContain("nav.login")
  })

  it("shows account icon when user is authenticated", () => {
    mockUseSessionStore.mockImplementation((selector?: unknown) => {
      const state = { userType: "customer" as const }
      return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
    })

    const tree = Header()
    const hrefs = collectHrefs(tree)

    expect(hrefs).toContain("/account")
  })
})
