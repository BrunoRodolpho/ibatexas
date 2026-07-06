// Unit tests for the checkout page component (CheckoutContent / CheckoutForm).
//
// Strategy: this repo's web component tests run in the `node` vitest env with
// the React hooks mocked and the real `react/jsx-runtime` building a plain
// element tree (see CookieConsentBanner.test.tsx). CheckoutForm is hook-heavy,
// so we stub useState/useEffect/useRef:
//   - useState returns [overridable initial, captured setter] keyed by call
//     order, letting us drive `stage`, `paymentMethod`, etc. and assert which
//     setters fire.
//   - useEffect is a noop (no auto redirects / fetches on mount).
//   - useRef returns a plain { current } box.
// We then walk the rendered element tree to find the submit Button / confirm
// dialog and invoke their handlers against a mocked `fetch`, asserting the real
// request URLs, JSON bodies, analytics, store side-effects and decision
// branches (pix vs card vs cash, large-ticket 202 confirm, refusal errors).

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── useState call-order indices (CheckoutForm declares these unconditionally) ──
const S = {
  stage: 0,
  notes: 1,
  paymentMethod: 2,
  tipPercent: 3,
  deliveryType: 4,
  cepInput: 5,
  deliveryEstimate: 6,
  loadingEstimate: 7,
  loading: 8,
  error: 9,
  result: 10,
  confirmation: 11,
  pixName: 12,
  pixEmail: 13,
  pixCpf: 14,
  pixCpfMasked: 15,
  deliveryError: 16,
} as const

// ── Hoisted shared mock state ─────────────────────────────────────────────────
const h = vi.hoisted(() => ({
  cart: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  kitchen: { data: undefined } as { data: unknown },
  track: vi.fn(),
  getSessionId: vi.fn(() => "sess-1"),
  saveOrder: vi.fn(),
  routerPush: vi.fn(),
  useStripe: vi.fn(() => null as unknown),
  useElements: vi.fn(() => null as unknown),
  getApiBase: vi.fn(() => "http://api.test"),
  formatBRL: vi.fn((c: number) => `BRL:${c}`),
  hasKitchenOnlyFood: vi.fn(() => false),
  getKitchenItems: vi.fn(() => [] as Array<{ id: string }>),
  fetch: vi.fn(),
  sessionSetItem: vi.fn(),
  // useState plumbing
  overrides: {} as Record<number, unknown>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  idx: { v: 0 },
}))

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = h.idx.v++
    const value = Object.prototype.hasOwnProperty.call(h.overrides, i) ? h.overrides[i] : init
    const setter = vi.fn()
    h.setters[i] = setter
    return [value, setter]
  },
  useEffect: () => {},
  useRef: (init: unknown) => ({ current: init }),
  default: {},
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.routerPush }) }))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn() }))
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: "Elements",
  CardElement: "CardElement",
  useStripe: () => h.useStripe(),
  useElements: () => h.useElements(),
}))
vi.mock("@/domains/cart", () => ({
  useCartStore: () => h.cart,
  hasKitchenOnlyFood: (...a: unknown[]) => h.hasKitchenOnlyFood(...(a as [])),
  getKitchenItems: (...a: unknown[]) => h.getKitchenItems(...(a as [])),
}))
vi.mock("@/domains/cart/useOrderHistory", () => ({ useOrderHistory: () => ({ saveOrder: h.saveOrder }) }))
vi.mock("@/domains/session", () => ({ useSessionStore: () => h.session }))
vi.mock("@/domains/schedule", () => ({ useKitchenStatus: () => h.kitchen }))
vi.mock("@/i18n/navigation", () => ({ Link: "Link" }))
vi.mock("@/lib/api", () => ({ getApiBase: () => h.getApiBase() }))
vi.mock("@/lib/format", () => ({ formatBRL: (c: number) => h.formatBRL(c) }))
vi.mock("@/domains/analytics", () => ({ track: (...a: unknown[]) => h.track(...(a as [])), getSessionId: () => h.getSessionId() }))
vi.mock("@/components/atoms", () => ({
  Heading: "Heading",
  Text: "Text",
  Button: "Button",
  Checkbox: "Checkbox",
  ErrorBoundary: "ErrorBoundary",
  Container: "Container",
  ScrollReveal: "ScrollReveal",
}))
vi.mock("@/components/molecules/KitchenClosedBanner", () => ({ KitchenClosedBanner: "KitchenClosedBanner" }))
vi.mock("@/components/molecules/CheckoutConfirmDialog", () => ({ CheckoutConfirmDialog: "CheckoutConfirmDialog" }))
vi.mock("next/image", () => ({ default: "Image" }))
vi.mock("lucide-react", () => ({ Flame: "Flame", Lock: "Lock", ShieldCheck: "ShieldCheck" }))

import CheckoutContent from "../../app/[locale]/checkout/CheckoutContent"

// ── Tree helpers (operate on real React elements: { type, props }) ────────────
type El = { type: unknown; props: { children?: unknown; [k: string]: unknown } }
function isEl(n: unknown): n is El {
  return !!n && typeof n === "object" && "type" in (n as object) && "props" in (n as object)
}
function collect(node: unknown, acc: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) collect(n, acc); return acc }
  if (isEl(node)) { acc.push(node); collect(node.props.children, acc) }
  return acc
}
function textOf(node: unknown): string {
  if (node == null || node === false) return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(" ")
  if (isEl(node)) return textOf(node.props.children)
  return ""
}
function renderForm(overrides: Record<number, unknown> = {}): El {
  h.overrides = overrides
  h.setters = []
  h.idx.v = 0
  const wrapper = CheckoutContent() as unknown as El
  // stripePromise is null (env unset) → wrapper.type === CheckoutForm
  return (wrapper.type as (p: unknown) => El)(wrapper.props)
}
function findSubmit(form: El): El {
  // The only atom <Button> with an onClick on the main checkout page is submit.
  return collect(form).find((n) => n.type === "Button" && typeof n.props.onClick === "function")!
}
function radioLabels(form: El): string[] {
  return collect(form)
    .filter((n) => n.type === "button" && (n.props as { role?: string }).role === "radio")
    .map((n) => textOf(n))
}

// ── Shared fixtures ───────────────────────────────────────────────────────────
const FOOD_ITEM = {
  id: "i1", productId: "p1", title: "Costela", price: 5000, quantity: 1,
  productType: "food", variantId: "v1", variantTitle: "G", imageUrl: "img",
}
const MERCH_ITEM = {
  id: "m1", productId: "p2", title: "Caneca", price: 3000, quantity: 2,
  productType: "merchandise", variantId: "v2", variantTitle: null, imageUrl: null,
}

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Re-establish default mock return values (clearAllMocks keeps impls, but be explicit).
  h.useStripe.mockReturnValue(null)
  h.useElements.mockReturnValue(null)
  h.getApiBase.mockReturnValue("http://api.test")
  h.formatBRL.mockImplementation((c: number) => `BRL:${c}`)
  h.getSessionId.mockReturnValue("sess-1")
  h.hasKitchenOnlyFood.mockReturnValue(false)
  h.getKitchenItems.mockReturnValue([])

  h.cart = {
    items: [{ ...FOOD_ITEM }],
    getTotal: vi.fn(() => 5000),
    cep: "01001000",
    setCep: vi.fn(),
    deliveryFee: null,
    estimatedDeliveryMinutes: null,
    setDeliveryEstimate: vi.fn(),
    medusaCartId: "cart-1",
    setMedusaCartId: vi.fn(),
    clearCart: vi.fn(),
    termsAccepted: false,
    setTermsAccepted: vi.fn(),
    removeItem: vi.fn(),
  }
  h.session = { customerId: "c1", isAuthenticated: vi.fn(() => true) }
  h.kitchen = { data: undefined }

  // sessionStorage + window for persistOrderAccessToken (node env has neither).
  ;(globalThis as { window?: unknown }).window = {}
  ;(globalThis as { sessionStorage?: unknown }).sessionStorage = { setItem: h.sessionSetItem }
  ;(globalThis as { fetch?: unknown }).fetch = h.fetch
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — render branches", () => {
  it("renders the empty-cart state with a continue-shopping link when the cart is empty", () => {
    h.cart.items = []
    const form = renderForm()
    expect(textOf(form)).toContain("empty_cart")
    const link = collect(form).find((n) => n.type === "Link")!
    expect(link.props.href).toBe("/search")
    expect(textOf(link)).toContain("continue_shopping")
  })

  it("renders the main checkout page with all three payment methods and dine-in (cart has food)", () => {
    const form = renderForm()
    const labels = radioLabels(form)
    expect(labels.filter((l) => ["pix", "card", "cash"].includes(l))).toEqual(["pix", "card", "cash"])
    expect(labels).toContain("delivery_type_dinein")
    // Total panel renders subtotal via formatBRL (deliveryFee=0, tip=0 → total=5000).
    expect(textOf(form)).toContain("BRL:5000")
    // Terms acceptance copy is present (pt-BR).
    expect(textOf(form)).toContain("Li e aceito os")
  })

  it("hides dine-in for a merchandise-only cart", () => {
    h.cart.items = [{ ...MERCH_ITEM }]
    const form = renderForm()
    const delivery = radioLabels(form).filter((l) => l.startsWith("delivery_type_"))
    expect(delivery).toEqual(["delivery_type_delivery", "delivery_type_pickup"])
  })

  it("removes cash and shows the shipping notice when the CEP is outside the local zone", () => {
    const form = renderForm({
      [S.deliveryEstimate]: { feeInCentavos: 0, estimatedMinutes: 0, message: "", isLocalZone: false },
    })
    expect(radioLabels(form).filter((l) => ["pix", "card", "cash"].includes(l))).toEqual(["pix", "card"])
    expect(textOf(form)).toContain("payment_cash_unavailable")
    expect(textOf(form)).toContain("delivery_shipping_title")
  })

  it("renders the local-zone delivery estimate (message + formatted fee) and totals", () => {
    const form = renderForm({
      [S.deliveryEstimate]: { feeInCentavos: 1500, estimatedMinutes: 60, message: "Entrega em 60 min", isLocalZone: true },
    })
    const txt = textOf(form)
    expect(txt).toContain("Entrega em 60 min")
    expect(txt).toContain("BRL:1500") // delivery fee
    expect(txt).toContain("BRL:6500") // total = 5000 + 1500
  })

  it("computes the tip line and total when a tip percentage is selected", () => {
    const form = renderForm({ [S.tipPercent]: 20 })
    const txt = textOf(form)
    expect(txt).toContain("BRL:1000") // tip = round(5000 * 20%)
    expect(txt).toContain("BRL:6000") // total = 5000 + 1000
    expect(txt).toContain("fee_tip")
  })

  it("renders the confirmed ceremony screen with an order-tracking link", () => {
    const form = renderForm({ [S.stage]: "confirmed", [S.result]: { orderId: "ord-1", message: "" } })
    expect(textOf(form)).toContain("order_confirmation")
    const link = collect(form).find((n) => n.type === "Link" && n.props.href === "/pedido/ord-1")
    expect(link).toBeTruthy()
  })

  it("renders the pix waiting screen with the QR image, copy-paste code and tracking link", () => {
    const form = renderForm({
      [S.stage]: "pix_waiting",
      [S.result]: { pixQrCode: "data:image/png;base64,QR", pixCopyPaste: "PIXCODE123", orderId: "ord-2", message: "" },
    })
    const img = collect(form).find((n) => n.type === "Image")!
    expect(img.props.src).toBe("data:image/png;base64,QR")
    expect(textOf(form)).toContain("PIXCODE123")
    const link = collect(form).find((n) => n.type === "Link" && n.props.href === "/pedido/ord-2")
    expect(link).toBeTruthy()
  })

  it("shows the invalid-CPF hint when an 11-digit but invalid CPF is entered", () => {
    const form = renderForm({ [S.pixCpf]: "12345678900" })
    expect(textOf(form)).toContain("pix_cpf_invalid")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — submit gating", () => {
  it("disables the submit button by default (terms not accepted, pix fields blank)", () => {
    const form = renderForm()
    expect(findSubmit(form).props.disabled).toBe(true)
  })

  it("enables submit once terms are accepted, a local estimate exists and pix billing is valid", () => {
    h.cart.termsAccepted = true
    const form = renderForm({
      [S.deliveryEstimate]: { feeInCentavos: 0, estimatedMinutes: 60, message: "", isLocalZone: true },
      [S.pixName]: "Maria Silva",
      [S.pixEmail]: "maria@example.com",
      [S.pixCpf]: "529.982.247-25", // a valid CPF (exercises cpfCheckDigit both passes)
    })
    expect(findSubmit(form).props.disabled).toBe(false)
  })

  it("renders the live merged-notes character budget near the notes field", () => {
    const form = renderForm()
    expect(textOf(form)).toContain("notes_remaining")
  })

  it("disables submit and blocks the POST when merged notes overflow the cap (CUS-015: never truncate)", async () => {
    h.cart.termsAccepted = true
    // Per-item instruction alone exceeds the 500-char merged cap.
    h.cart.items = [{ ...FOOD_ITEM, specialInstructions: "a".repeat(600) }]
    const form = renderForm({
      [S.deliveryEstimate]: { feeInCentavos: 0, estimatedMinutes: 60, message: "", isLocalZone: true },
      [S.pixName]: "Maria Silva",
      [S.pixEmail]: "maria@example.com",
      [S.pixCpf]: "529.982.247-25",
    })
    const submit = findSubmit(form)
    expect(submit.props.disabled).toBe(true)
    // The overflow warning replaces the remaining-count budget line.
    expect(textOf(form)).toContain("notes_too_long")
    // Defense in depth: invoking the handler anyway must refuse before fetching.
    await (submit.props.onClick as () => Promise<void>)()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.setters[S.error]).toHaveBeenCalledWith("notes_too_long")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — handleCheckout (pix)", () => {
  it("POSTs the checkout body and parks into pix_waiting on success", async () => {
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "pix", orderId: "ord-1", accessToken: "tok", message: "" }))
    const form = renderForm()
    await findSubmit(form).props.onClick!()

    expect(h.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = h.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://api.test/api/cart/checkout")
    expect(opts.method).toBe("POST")
    expect(opts.credentials).toBe("include")
    const body = JSON.parse(opts.body as string)
    expect(body).toMatchObject({
      cartId: "cart-1",
      paymentMethod: "pix",
      deliveryType: "delivery",
      deliveryCep: "01001000",
      items: [{ variantId: "v1", quantity: 1, productType: "food" }],
    })
    // pix branch: clears the cart and advances to the waiting stage.
    expect(h.cart.clearCart).toHaveBeenCalledTimes(1)
    expect(h.setters[S.stage]).toHaveBeenCalledWith("pix_waiting")
    // Per-order access token persisted (keyed by orderId).
    expect(h.sessionSetItem).toHaveBeenCalledWith("order-access-token:ord-1", "tok")
  })

  it("folds per-item instructions into the checkout body notes, untruncated", async () => {
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "pix", orderId: "o", message: "" }))
    h.cart.items = [{ ...FOOD_ITEM, specialInstructions: "sem cebola" }]
    const form = renderForm()
    await (findSubmit(form).props.onClick as () => Promise<void>)()
    const body = JSON.parse((h.fetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.notes).toBe("1× Costela — G: sem cebola")
  })

  it("maps an outside-zone (shipping) cart to deliveryType=shipping in the body", async () => {
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "pix", orderId: "o", message: "" }))
    const form = renderForm({
      [S.deliveryEstimate]: { feeInCentavos: 0, estimatedMinutes: 0, message: "", isLocalZone: false },
    })
    await findSubmit(form).props.onClick!()
    const body = JSON.parse((h.fetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.deliveryType).toBe("shipping")
  })

  it("surfaces the pack's pt-BR refusal copy and emits checkout_error on a non-ok response", async () => {
    h.fetch.mockResolvedValue(okJson({ error: "Pedido acima de R$ 10.000 não permitido" }, 422))
    const form = renderForm()
    await findSubmit(form).props.onClick!()

    expect(h.cart.clearCart).not.toHaveBeenCalled()
    expect(h.setters[S.error]).toHaveBeenCalledWith("Pedido acima de R$ 10.000 não permitido")
    expect(h.track).toHaveBeenCalledWith(
      "checkout_error",
      expect.objectContaining({ step: "payment", errorType: "checkout_failed", errorMessage: "Pedido acima de R$ 10.000 não permitido" }),
    )
  })

  it("parks a large-ticket 202 response into the confirm dialog without proceeding", async () => {
    h.fetch.mockResolvedValue(okJson({ confirmationRequired: true, confirmationId: "cfm-9", prompt: "Confirmar R$ 1.500,00?" }, 202))
    const form = renderForm()
    await findSubmit(form).props.onClick!()

    expect(h.setters[S.confirmation]).toHaveBeenCalledWith({ confirmationId: "cfm-9", prompt: "Confirmar R$ 1.500,00?" })
    expect(h.cart.clearCart).not.toHaveBeenCalled()
    expect(h.track).not.toHaveBeenCalledWith("checkout_completed", expect.anything())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — ensureMedusaCartId fallback", () => {
  it("creates a Medusa cart when the store has none, then checks out with the new id", async () => {
    h.cart.medusaCartId = null
    h.fetch
      .mockResolvedValueOnce(okJson({ cart: { id: "cart-new" } })) // POST /api/cart
      .mockResolvedValueOnce(okJson({ paymentMethod: "pix", message: "" })) // checkout
    const form = renderForm()
    await findSubmit(form).props.onClick!()

    expect((h.fetch.mock.calls[0] as [string, RequestInit])[0]).toBe("http://api.test/api/cart")
    expect(h.cart.setMedusaCartId).toHaveBeenCalledWith("cart-new")
    const checkoutBody = JSON.parse((h.fetch.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(checkoutBody.cartId).toBe("cart-new")
  })

  it("errors with cart_not_found and skips checkout when cart creation fails", async () => {
    h.cart.medusaCartId = null
    h.fetch.mockResolvedValue(okJson({}, 500)) // cart creation fails
    const form = renderForm()
    await findSubmit(form).props.onClick!()

    expect(h.fetch).toHaveBeenCalledTimes(1) // no checkout call
    expect(h.setters[S.error]).toHaveBeenCalledWith("cart_not_found")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — cash & card branches", () => {
  it("records the order, saves history and confirms on a successful cash checkout", async () => {
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "cash", orderId: "ord-9", accessToken: "tok", message: "" }))
    const form = renderForm({ [S.paymentMethod]: "cash" })
    await findSubmit(form).props.onClick!()

    expect(h.track).toHaveBeenCalledWith("checkout_completed", expect.objectContaining({ orderId: "ord-9", paymentMethod: "cash", currency: "BRL" }))
    expect(h.saveOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: "ord-9", total: 5000 }))
    expect(h.cart.clearCart).toHaveBeenCalledTimes(1)
    expect(h.setters[S.stage]).toHaveBeenCalledWith("confirmed")
    expect(h.sessionSetItem).toHaveBeenCalledWith("order-access-token:ord-9", "tok")
  })

  it("shows stripe_unavailable when a card checkout returns a secret but Stripe is not ready", async () => {
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "card", stripeClientSecret: "cs_1", message: "" }))
    const form = renderForm({ [S.paymentMethod]: "card" }) // useStripe/useElements default → null
    await findSubmit(form).props.onClick!()

    expect(h.setters[S.error]).toHaveBeenCalledWith("stripe_unavailable")
    expect(h.routerPush).not.toHaveBeenCalled()
  })

  it("confirms the card payment inline and routes to the order page on success", async () => {
    const confirmCardPayment = vi.fn().mockResolvedValue({ paymentIntent: { id: "pi_77", status: "succeeded" } })
    h.useStripe.mockReturnValue({ confirmCardPayment })
    h.useElements.mockReturnValue({ getElement: vi.fn(() => ({})) })
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "card", stripeClientSecret: "cs_2", accessToken: "tok2", message: "" }))
    const form = renderForm({ [S.paymentMethod]: "card" })
    await findSubmit(form).props.onClick!()

    expect(confirmCardPayment).toHaveBeenCalledWith("cs_2", expect.any(Object))
    expect(h.track).toHaveBeenCalledWith("checkout_completed", expect.objectContaining({ orderId: "pi_77", paymentMethod: "card" }))
    expect(h.cart.clearCart).toHaveBeenCalledTimes(1)
    expect(h.routerPush).toHaveBeenCalledWith("/pedido/pi_77")
    expect(h.sessionSetItem).toHaveBeenCalledWith("order-access-token:pi_77", "tok2")
  })

  it("surfaces a Stripe card error without routing away", async () => {
    const confirmCardPayment = vi.fn().mockResolvedValue({ error: { message: "Cartão recusado" } })
    h.useStripe.mockReturnValue({ confirmCardPayment })
    h.useElements.mockReturnValue({ getElement: vi.fn(() => ({})) })
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "card", stripeClientSecret: "cs_3", message: "" }))
    const form = renderForm({ [S.paymentMethod]: "card" })
    await findSubmit(form).props.onClick!()

    expect(h.setters[S.error]).toHaveBeenCalledWith("Cartão recusado")
    expect(h.routerPush).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — handleConfirmCheckout (large-ticket resume)", () => {
  it("opens the confirm dialog with the parked prompt and resumes via the confirm endpoint", async () => {
    h.fetch.mockResolvedValue(okJson({ paymentMethod: "pix", orderId: "ord-x", message: "" }))
    const form = renderForm({ [S.confirmation]: { confirmationId: "cfm-1", prompt: "Confirmar pedido?" } })

    const dialog = collect(form).find((n) => n.type === "CheckoutConfirmDialog")!
    expect(dialog.props.isOpen).toBe(true)
    expect(dialog.props.prompt).toBe("Confirmar pedido?")

    await (dialog.props.onConfirm as () => Promise<void>)()

    const [url, opts] = h.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("http://api.test/api/cart/checkout/confirm")
    expect(JSON.parse(opts.body as string)).toEqual({ confirmationId: "cfm-1" })
    expect(h.setters[S.confirmation]).toHaveBeenCalledWith(null)
    expect(h.cart.clearCart).toHaveBeenCalledTimes(1)
    expect(h.setters[S.stage]).toHaveBeenCalledWith("pix_waiting")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe("CheckoutContent — kitchen closed", () => {
  it("renders the closed banner, blocks submit and disables pickup when the kitchen is closed with food in cart", () => {
    h.kitchen = { data: { mealPeriod: "closed", nextOpenDay: "2026-06-29" } }
    h.hasKitchenOnlyFood.mockReturnValue(true)
    h.getKitchenItems.mockReturnValue([{ id: "i1" }])
    const form = renderForm()

    expect(collect(form).find((n) => n.type === "KitchenClosedBanner")).toBeTruthy()
    expect(findSubmit(form).props.disabled).toBe(true)
    const pickup = collect(form).find(
      (n) => n.type === "button" && (n.props as { role?: string }).role === "radio" && textOf(n) === "delivery_type_pickup",
    )!
    expect(pickup.props.disabled).toBe(true)
  })

  it("removes kitchen items and tracks the removal when the banner action is invoked", () => {
    h.kitchen = { data: { mealPeriod: "closed", nextOpenDay: "2026-06-29" } }
    h.hasKitchenOnlyFood.mockReturnValue(true)
    h.getKitchenItems.mockReturnValue([{ id: "i1" }])
    // Cart has more items than kitchen items → onRemoveKitchenItems is wired.
    h.cart.items = [{ ...FOOD_ITEM }, { ...MERCH_ITEM }]
    const form = renderForm()

    const banner = collect(form).find((n) => n.type === "KitchenClosedBanner")!
    expect(typeof banner.props.onRemoveKitchenItems).toBe("function")
    ;(banner.props.onRemoveKitchenItems as () => void)()

    expect(h.cart.removeItem).toHaveBeenCalledWith("i1")
    expect(h.track).toHaveBeenCalledWith("kitchen_closed_items_removed", { count: 1 })
  })
})
