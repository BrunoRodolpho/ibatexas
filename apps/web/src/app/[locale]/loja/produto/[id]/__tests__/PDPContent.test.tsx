// Unit tests for PDPContent — the product-detail page client component.
//
// Strategy (matches the repo's established `environment: node` component-test
// pattern, e.g. AdminAnalisesPage.test.tsx / CookieConsentBanner.test.tsx):
// we mock React's element factory + a simplified hook set, mock every external
// module, then call the component function directly and inspect the returned
// plain-object JSX tree. No DOM, no network, no real stores — all side-effects
// flow through vi.fn() mocks we assert against.

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted shared state + mocks (referenced inside vi.mock factories) ───────
const H = vi.hoisted(() => {
  // Test-controlled context, read live by the mocked hooks at call time.
  const ctx = {
    productDetail: { data: null as unknown, loading: false, error: null as unknown },
    alsoAdded: [] as unknown[],
    cartItems: [] as Array<{ productId: string }>,
    crossSellData: { items: [] as unknown[] },
    allProductsData: { items: [] as unknown[] },
    crossSellCategory: "complementos",
    stateOverrides: {} as Record<number, unknown>,
  }

  // Simplified React hook controller. useState honours a per-render override
  // map (keyed by call order) so tests can drive selectedVariantId / sticky.
  let hookIndex = 0
  const react = {
    resetHooks: () => {
      hookIndex = 0
    },
    useState: (init: unknown) => {
      const i = hookIndex++
      const has = Object.prototype.hasOwnProperty.call(ctx.stateOverrides, i)
      return [has ? ctx.stateOverrides[i] : init, () => {}]
    },
  }

  const mocks = {
    addItem: vi.fn(),
    addToast: vi.fn(),
    openCartDrawer: vi.fn(),
    track: vi.fn(),
    trackOnceVisible: vi.fn(() => () => {}),
    trackScrollDepth: vi.fn(() => () => {}),
    tagToBadgeVariant: vi.fn(() => "bestseller"),
    getCrossSellCategory: vi.fn(() => ctx.crossSellCategory),
    // Cart-aware cross-sell mapping: carnes complement acompanhamentos.
    CROSS_SELL_MAP: { carnes: ["acompanhamentos"] } as Record<string, string[]>,
  }

  // Stable stub component identities so we can locate elements by `type`.
  const mk = (name: string) => {
    const f = (p: unknown) => ({ type: name, props: p })
    Object.defineProperty(f, "stubName", { value: name })
    return f
  }
  const stubNames = [
    "Heading", "Text", "Button", "Badge", "LinkButton", "Container",
    "SizeSelector", "ShippingEstimate", "QuantitySelector", "DeliveryPromise",
    "StickyBottomBar", "ProductGrid", "MediaGallery", "WishlistButton",
    "Skeleton", "Link",
  ]
  const stubs: Record<string, ReturnType<typeof mk>> = {}
  for (const n of stubNames) stubs[n] = mk(n)

  return { ctx, react, mocks, stubs }
})

// ── React + JSX runtime mocks (plain inspectable objects, simple hooks) ──────
vi.mock("react", () => {
  const api = {
    useState: (init: unknown) => H.react.useState(init),
    useEffect: () => {},
    useRef: (init: unknown) => ({ current: init ?? null }),
    useMemo: (fn: () => unknown) => fn(),
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...((props as Record<string, unknown>) || {}), children },
    }),
    Fragment: "Fragment",
  }
  return { ...api, default: api }
})

vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: unknown, key: unknown) => ({ type, props: props || {}, key }),
  jsxs: (type: unknown, props: unknown, key: unknown) => ({ type, props: props || {}, key }),
  Fragment: "Fragment",
}))
vi.mock("react/jsx-dev-runtime", () => ({
  jsxDEV: (type: unknown, props: unknown, key: unknown) => ({ type, props: props || {}, key }),
  jsx: (type: unknown, props: unknown, key: unknown) => ({ type, props: props || {}, key }),
  jsxs: (type: unknown, props: unknown, key: unknown) => ({ type, props: props || {}, key }),
  Fragment: "Fragment",
}))

// ── External module mocks ────────────────────────────────────────────────────
vi.mock("next-intl", () => ({
  // Return the i18n key (plus serialized params) so we can assert exact branches.
  useTranslations: () => (key: string, params?: unknown) =>
    params ? `${key}|${JSON.stringify(params)}` : key,
}))

vi.mock("@/domains/product", () => ({
  useProductDetail: () => H.ctx.productDetail,
  useProducts: (args: { limit?: number } | undefined) => ({
    data: args && args.limit === 50 ? H.ctx.allProductsData : H.ctx.crossSellData,
    loading: false,
    error: null,
  }),
  tagToBadgeVariant: H.mocks.tagToBadgeVariant,
  getCrossSellCategory: H.mocks.getCrossSellCategory,
  CROSS_SELL_MAP: H.mocks.CROSS_SELL_MAP,
}))

vi.mock("@/domains/cart", () => ({
  useCartStore: (selector: (s: unknown) => unknown) =>
    selector({ addItem: H.mocks.addItem, items: H.ctx.cartItems }),
}))

vi.mock("@/domains/ui", () => ({
  useUIStore: (selector?: (s: unknown) => unknown) => {
    const state = { addToast: H.mocks.addToast, openCartDrawer: H.mocks.openCartDrawer }
    return selector ? selector(state) : state
  },
}))

vi.mock("@/domains/recommendations", () => ({
  useAlsoAdded: () => ({ data: H.ctx.alsoAdded, loading: false, error: null }),
}))

vi.mock("@/domains/analytics", () => ({
  track: H.mocks.track,
  trackOnceVisible: H.mocks.trackOnceVisible,
  trackScrollDepth: H.mocks.trackScrollDepth,
}))

vi.mock("@/i18n/navigation", () => ({ Link: H.stubs.Link }))
vi.mock("lucide-react", () => ({ ChevronRight: "ChevronRight" }))
vi.mock("@ibatexas/types", () => ({
  AvailabilityWindow: { ALMOCO: "almoco", JANTAR: "jantar", CONGELADOS: "congelados", SEMPRE: "sempre" },
}))

vi.mock("@/components/atoms", () => ({
  Heading: H.stubs.Heading,
  Text: H.stubs.Text,
  Button: H.stubs.Button,
  Badge: H.stubs.Badge,
  LinkButton: H.stubs.LinkButton,
  Container: H.stubs.Container,
}))
vi.mock("@/components/atoms/Skeleton", () => ({ Skeleton: H.stubs.Skeleton }))
vi.mock("@/components/molecules", () => ({
  SizeSelector: H.stubs.SizeSelector,
  ShippingEstimate: H.stubs.ShippingEstimate,
  QuantitySelector: H.stubs.QuantitySelector,
  DeliveryPromise: H.stubs.DeliveryPromise,
}))
vi.mock("@/components/molecules/StickyBottomBar", () => ({ StickyBottomBar: H.stubs.StickyBottomBar }))
vi.mock("@/components/molecules/MediaGallery", () => ({ MediaGallery: H.stubs.MediaGallery }))
vi.mock("@/components/molecules/WishlistButton", () => ({ WishlistButton: H.stubs.WishlistButton }))
vi.mock("@/components/organisms", () => ({ ProductGrid: H.stubs.ProductGrid }))
// NOTE: @/lib/format is intentionally NOT mocked — it's a pure Intl helper, so
// we assert real pt-BR currency formatting end-to-end.

import PDPContent from "../PDPContent"

// ── Tree helpers ─────────────────────────────────────────────────────────────
interface Acc {
  text: string[]
  nodes: Array<{ type: unknown; props?: Record<string, unknown> }>
}
function collect(node: unknown, acc: Acc): void {
  if (node == null || node === false || node === true) return
  if (typeof node === "string" || typeof node === "number") {
    acc.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const n of node) collect(n, acc)
    return
  }
  if (typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> }
    acc.nodes.push(el as Acc["nodes"][number])
    if (el.props && "children" in el.props) collect(el.props.children, acc)
  }
}
function analyze(root: unknown): Acc {
  const acc: Acc = { text: [], nodes: [] }
  collect(root, acc)
  return acc
}
const textOf = (root: unknown) => analyze(root).text.join("␟")
const findByType = (root: unknown, type: unknown) =>
  analyze(root).nodes.find((n) => n.type === type)

// ── Fixtures ─────────────────────────────────────────────────────────────────
const PRODUCT_ID = "prod_costela"
function baseProduct(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    title: "Costela Bovina Defumada",
    price: 8900,
    description: "Defumada lentamente.",
    variants: [{ id: "v1", price: 8900, title: "Inteira" }],
    images: [],
    imageUrl: null,
    tags: ["Mais Vendido"],
    categoryHandle: "carnes-defumadas",
    stockCount: 3,
    availabilityWindow: "almoco",
    servings: 4,
    weight: "1.2kg",
    reviewCount: 12,
    smokeHours: 14,
    woodType: "carvalho",
    ...over,
  }
}

function renderPDP(overrides: Record<number, unknown> = {}) {
  H.ctx.stateOverrides = overrides
  H.react.resetHooks()
  return PDPContent({ productId: PRODUCT_ID } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  H.ctx.productDetail = { data: null, loading: false, error: null }
  H.ctx.alsoAdded = []
  H.ctx.cartItems = []
  H.ctx.crossSellData = { items: [] }
  H.ctx.allProductsData = { items: [] }
  H.ctx.stateOverrides = {}
})

// ── Branch: loading ──────────────────────────────────────────────────────────
describe("PDPContent — loading branch", () => {
  it("renders the PDPSkeleton component (not product content) while loading", () => {
    H.ctx.productDetail = { data: null, loading: true, error: null }
    const tree = renderPDP() as { type: unknown }
    // Loading short-circuits to <PDPSkeleton /> — the element's `type` is the
    // skeleton component itself, distinct from the success <div> and error div.
    expect(typeof tree.type).toBe("function")
    expect((tree.type as { name: string }).name).toBe("PDPSkeleton")
    expect(tree.type).not.toBe("div")
    // No product CTA or product title while loading.
    expect(findByType(tree, H.stubs.Button)).toBeUndefined()
    expect(textOf(tree)).not.toContain("Costela Bovina Defumada")
  })
})

// ── Branch: error / not-found ────────────────────────────────────────────────
describe("PDPContent — error / not-found branch", () => {
  it("renders the not-found message + back-to-shop link on error", () => {
    H.ctx.productDetail = { data: null, loading: false, error: new Error("boom") }
    const tree = renderPDP() as { type: unknown }
    expect(tree.type).toBe("div")
    expect(textOf(tree)).toContain("shop.errors.product_not_found")
    const back = findByType(tree, H.stubs.LinkButton)
    expect(back?.props?.href).toBe("/loja")
    expect(textOf(tree)).toContain("shop.back_to_shop")
  })

  it("treats a null product (no error) as not-found too", () => {
    H.ctx.productDetail = { data: null, loading: false, error: null }
    const tree = renderPDP() as { type: unknown }
    expect(textOf(tree)).toContain("shop.errors.product_not_found")
  })
})

// ── Branch: success render ───────────────────────────────────────────────────
describe("PDPContent — success render", () => {
  beforeEach(() => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
  })

  it("renders the product title, real pt-BR price, and an enabled add-to-cart CTA", () => {
    const tree = renderPDP() as { type: unknown }
    expect(tree.type).toBe("div")
    const txt = textOf(tree)
    expect(txt).toContain("Costela Bovina Defumada")
    // splitBRL(8900) => "89,00" via the real Intl helper.
    expect(txt).toContain("89,00")

    const cta = findByType(tree, H.stubs.Button)
    expect(cta).toBeDefined()
    expect(typeof cta?.props?.onClick).toBe("function")
    expect(cta?.props?.disabled).toBe(false)
    // Not in the adding state -> shows the add label, not "adding".
    expect(txt).toContain("product.add_to_cart")
  })

  it("exercises the priced/scarcity/availability/servings/reviews/smoke branches", () => {
    const tree = renderPDP()
    const txt = textOf(tree)
    // Single priority badge derived from tags[0].
    expect(H.mocks.tagToBadgeVariant).toHaveBeenCalledWith("Mais Vendido")
    // Scarcity (stockCount 3, in 1..5).
    expect(txt).toContain("scarcity")
    // Availability window = ALMOCO.
    expect(txt).toContain("product.available_almoco")
    // Per-person + serves (servings 4 > 1).
    expect(txt).toContain("product.per_person_price")
    expect(txt).toContain("product.serves")
    // Smoke narrative (smokeHours + woodType present).
    expect(txt).toContain("product.smoke_narrative")
    // Reviews section renders its hardcoded pt-BR testimonials.
    expect(txt).toContain("Melhor costela que já comi. Carne desfiando no garfo!")
  })

  it("does NOT render the size selector for a single-variant product", () => {
    const tree = renderPDP()
    expect(findByType(tree, H.stubs.SizeSelector)).toBeUndefined()
    expect(textOf(tree)).not.toContain("product.select_size")
  })
})

// ── add-to-cart handler ──────────────────────────────────────────────────────
describe("PDPContent — handleAddToCart", () => {
  it("adds the product + default variant, tracks, toasts FIRST-item, and opens the drawer", async () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    H.ctx.cartItems = [] // first item
    const tree = renderPDP()
    const cta = findByType(tree, H.stubs.Button)
    await (cta!.props!.onClick as () => Promise<void>)()

    expect(H.mocks.addItem).toHaveBeenCalledTimes(1)
    expect(H.mocks.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: PRODUCT_ID }),
      1,
      undefined,
      expect.objectContaining({ id: "v1" }),
    )
    expect(H.mocks.track).toHaveBeenCalledWith(
      "add_to_cart",
      expect.objectContaining({ productId: PRODUCT_ID, variantId: "v1", quantity: 1, source: "pdp" }),
    )
    expect(H.mocks.addToast).toHaveBeenCalledWith("toast.first_item_added", "success")
    expect(H.mocks.openCartDrawer).toHaveBeenCalledTimes(1)
  })

  it("uses the standard 'added' toast (not first-item) when the cart already has items", async () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    H.ctx.cartItems = [{ productId: "other" }]
    const tree = renderPDP()
    await (findByType(tree, H.stubs.Button)!.props!.onClick as () => Promise<void>)()

    expect(H.mocks.addItem).toHaveBeenCalledTimes(1)
    expect(H.mocks.addToast).toHaveBeenCalledWith("toast.added_to_cart", "cart")
    expect(H.mocks.addToast).not.toHaveBeenCalledWith("toast.first_item_added", "success")
  })

  it("toasts an error and does NOT open the drawer when addItem throws", async () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    H.mocks.addItem.mockImplementationOnce(() => {
      throw new Error("store down")
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const tree = renderPDP()
    await (findByType(tree, H.stubs.Button)!.props!.onClick as () => Promise<void>)()

    expect(H.mocks.addToast).toHaveBeenCalledWith("toast.add_to_cart_error", "error")
    expect(H.mocks.openCartDrawer).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("GUARDS: with variants present but none selected, it shakes the picker and does NOT add", async () => {
    vi.useFakeTimers()
    const multiVariant = baseProduct({
      variants: [
        { id: "v1", price: 8900, title: "Meia" },
        { id: "v2", price: 12900, title: "Inteira" },
      ],
    })
    H.ctx.productDetail = { data: multiVariant, loading: false, error: null }
    // Override selectedVariantId (useState #0) with a non-matching id.
    const tree = renderPDP({ 0: "does-not-exist" })

    // hasVariants -> size selector + select-size hint are shown.
    expect(findByType(tree, H.stubs.SizeSelector)).toBeDefined()
    expect(textOf(tree)).toContain("product.select_size")

    await (findByType(tree, H.stubs.Button)!.props!.onClick as () => Promise<void>)()

    expect(H.mocks.addItem).not.toHaveBeenCalled()
    expect(H.mocks.track).not.toHaveBeenCalledWith("add_to_cart", expect.anything())
    vi.runAllTimers()
    vi.useRealTimers()
  })
})

// ── Unified cross-sell ───────────────────────────────────────────────────────
describe("PDPContent — unified cross-sell suggestions", () => {
  it("adds the full product (with default variant) when the suggestion comes from the cross-sell pool", () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    H.ctx.crossSellData = {
      items: [
        { id: "cs1", title: "Linguiça Artesanal", price: 3900, imageUrl: null, variants: [{ id: "csv1", price: 3900 }] },
      ],
    }
    const tree = renderPDP()
    const grid = findByType(tree, H.stubs.ProductGrid)
    expect(grid).toBeDefined()
    // Suggestion surfaced in the grid.
    expect((grid!.props!.products as Array<{ id: string }>).map((p) => p.id)).toContain("cs1")

    const onAdd = grid!.props!.onAddToCart as (id: string) => void
    onAdd("cs1")

    expect(H.mocks.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs1" }),
      1,
      undefined,
      expect.objectContaining({ id: "csv1" }),
    )
    expect(H.mocks.track).toHaveBeenCalledWith(
      "pdp_cross_sell_added",
      expect.objectContaining({ productId: PRODUCT_ID, suggestedId: "cs1", source: "cross_sell" }),
    )
    expect(H.mocks.addToast).toHaveBeenCalledWith("toast.added_to_cart", "cart")
  })

  it("builds a minimal stub (no variant) when the suggestion is an also-added-only entry", () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    // also-added entries are minimal; not present in cross-sell / pool.
    H.ctx.alsoAdded = [{ id: "aa1", title: "Pão de Alho", price: 1500, imageUrl: "http://img/aa1.jpg" }]
    const tree = renderPDP()
    const grid = findByType(tree, H.stubs.ProductGrid)
    expect((grid!.props!.products as Array<{ id: string }>).map((p) => p.id)).toContain("aa1")

    ;(grid!.props!.onAddToCart as (id: string) => void)("aa1")

    // Stub shape, quantity 1, NO variant argument.
    expect(H.mocks.addItem).toHaveBeenCalledTimes(1)
    const call = H.mocks.addItem.mock.calls[0]
    expect(call[0]).toEqual(expect.objectContaining({ id: "aa1", title: "Pão de Alho", price: 1500, variants: [] }))
    expect(call[1]).toBe(1)
    expect(call).toHaveLength(2)
    expect(H.mocks.track).toHaveBeenCalledWith(
      "pdp_cross_sell_added",
      expect.objectContaining({ suggestedId: "aa1", source: "also_added" }),
    )
  })

  it("no-ops when onAddToCart is called with an unknown suggestion id", () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    H.ctx.alsoAdded = [{ id: "aa1", title: "Pão de Alho", price: 1500, imageUrl: null }]
    const tree = renderPDP()
    const grid = findByType(tree, H.stubs.ProductGrid)
    ;(grid!.props!.onAddToCart as (id: string) => void)("ghost")
    expect(H.mocks.addItem).not.toHaveBeenCalled()
  })

  it("derives cart-aware complementary picks (people_also_ordered) from the broad pool", () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    H.ctx.cartItems = [{ productId: "incart1" }]
    H.ctx.allProductsData = {
      items: [
        { id: "incart1", title: "Costela no carrinho", price: 8900, categoryHandle: "carnes" },
        { id: "comp1", title: "Farofa de Bacon", price: 1900, categoryHandle: "acompanhamentos", imageUrl: null },
      ],
    }
    const tree = renderPDP()
    const grid = findByType(tree, H.stubs.ProductGrid)
    expect(grid).toBeDefined()
    const ids = (grid!.props!.products as Array<{ id: string }>).map((p) => p.id)
    // Complementary acompanhamentos surfaces; the in-cart item itself does not.
    expect(ids).toContain("comp1")
    expect(ids).not.toContain("incart1")
  })

  it("does not render the cross-sell grid when there are no suggestions", () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    const tree = renderPDP()
    expect(findByType(tree, H.stubs.ProductGrid)).toBeUndefined()
  })
})

// ── Sticky CTA ───────────────────────────────────────────────────────────────
describe("PDPContent — sticky mobile CTA", () => {
  it("renders the sticky bar when shown and its action tracks + adds to cart", async () => {
    H.ctx.productDetail = { data: baseProduct(), loading: false, error: null }
    // useState #3 = showStickyCTA -> true.
    const tree = renderPDP({ 3: true })
    const sticky = findByType(tree, H.stubs.StickyBottomBar)
    expect(sticky).toBeDefined()

    await (sticky!.props!.onAction as () => void | Promise<void>)()

    expect(H.mocks.track).toHaveBeenCalledWith(
      "sticky_cta_used",
      expect.objectContaining({ productId: PRODUCT_ID, source: "pdp_sticky" }),
    )
    expect(H.mocks.addItem).toHaveBeenCalledTimes(1)
  })
})
