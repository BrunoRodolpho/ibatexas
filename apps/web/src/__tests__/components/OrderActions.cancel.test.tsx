// BKL-036 — the paid-cancel 202 must NOT read as success on the web surface.
//
// A paid order.cancel is PARKED by the kernel (HTTP 202 { confirmationRequired })
// — a 2xx, so apiFetch resolves without throwing. Before the fix, handleCancel
// treated any non-throwing response as success (close modal + onMutate), giving
// the customer a false "cancelled" experience while the order was NOT cancelled.
//
// Strategy mirrors CheckoutContent.test.tsx: node vitest env, react hooks mocked
// (useState captures setters by call order, useCallback captures the callbacks),
// the real jsx-runtime builds a plain element tree. handleCancel is the first
// useCallback, so we invoke h.callbacks[0] directly against a mocked apiFetch.

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  onMutate: vi.fn(),
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  callbacks: [] as Array<(...a: unknown[]) => unknown>,
  idx: { v: 0 },
}))

vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = h.idx.v++
    const setter = vi.fn()
    h.setters[i] = setter
    return [init, setter]
  },
  useCallback: (fn: (...a: unknown[]) => unknown) => {
    h.callbacks.push(fn)
    return fn
  },
  default: {},
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => h.apiFetch(...(a as [])) }))
vi.mock("@ibatexas/ui/atoms", () => ({ Button: "Button" }))
vi.mock("@ibatexas/ui/molecules", () => ({ Modal: "Modal" }))
vi.mock("./AmendOrderDialog", () => ({ AmendOrderDialog: "AmendOrderDialog" }))
vi.mock("../../components/molecules/AmendOrderDialog", () => ({ AmendOrderDialog: "AmendOrderDialog" }))
vi.mock("./SwitchTypeDialog", () => ({ SwitchTypeDialog: "SwitchTypeDialog" }))
vi.mock("../../components/molecules/SwitchTypeDialog", () => ({ SwitchTypeDialog: "SwitchTypeDialog" }))

import { OrderActions } from "../../components/molecules/OrderActions"

// A PAID order that is still cancellable (confirmed) — the cancel button shows,
// and the kernel parks the cancel behind a confirmation.
const PAID_CONFIRMED_PROPS = {
  orderId: "order_01",
  fulfillmentStatus: "confirmed",
  currentPayment: { id: "pay_01", method: "pix", status: "paid" },
  orderType: "pickup",
  items: [{ id: "i1", title: "Costela", quantity: 1, variant_id: "v1", unit_price: 5000, productType: "food" as const }],
  onMutate: h.onMutate,
}

function renderAndGetHandleCancel() {
  h.setters = []
  h.callbacks = []
  h.idx.v = 0
  OrderActions(PAID_CONFIRMED_PROPS)
  // handleCancel is the first useCallback declared in the component body.
  return h.callbacks[0]
}

function anySetterCalledWith(value: unknown): boolean {
  return h.setters.some((s) => s.mock.calls.some((c) => c[0] === value))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("OrderActions handleCancel — BKL-036 paid-cancel 202", () => {
  it("202 confirmationRequired → NO false success (modal stays open, onMutate not fired, honest notice set)", async () => {
    h.apiFetch.mockResolvedValue({ confirmationRequired: true, prompt: "confirma?" })

    const handleCancel = renderAndGetHandleCancel()
    await handleCancel()

    // The request went out to the cancel route.
    expect(h.apiFetch).toHaveBeenCalledWith(
      "/api/orders/order_01/cancel",
      expect.objectContaining({ method: "POST" }),
    )
    // NO false success: the parent is not told a mutation happened…
    expect(h.onMutate).not.toHaveBeenCalled()
    // …and the modal is NOT closed (no setter was called with `false`, which
    // is uniquely setCancelOpen(false) on the success path).
    expect(anySetterCalledWith(false)).toBe(false)
    // The honest "needs confirmation" notice was surfaced instead.
    expect(anySetterCalledWith("cancel_needs_confirmation")).toBe(true)
  })

  it("plain 2xx (no confirmationRequired) → real success: onMutate fired + modal closed", async () => {
    h.apiFetch.mockResolvedValue({ success: true })

    const handleCancel = renderAndGetHandleCancel()
    await handleCancel()

    expect(h.onMutate).toHaveBeenCalledTimes(1)
    expect(anySetterCalledWith(false)).toBe(true) // setCancelOpen(false)
    expect(anySetterCalledWith("cancel_needs_confirmation")).toBe(false)
  })

  it("network/API error → error path, no false success", async () => {
    h.apiFetch.mockRejectedValue(new Error("API error: 500"))

    const handleCancel = renderAndGetHandleCancel()
    await handleCancel()

    expect(h.onMutate).not.toHaveBeenCalled()
    expect(anySetterCalledWith("cancel_error")).toBe(true)
  })
})
