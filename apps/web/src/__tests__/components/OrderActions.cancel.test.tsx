// BKL-146 / FE-D19 — customer two-phase cancel completion on the web surface.
//
// A PAID order.cancel PARKS (HTTP 202 {confirmationId, prompt}); the customer
// COMPLETES it via POST /api/orders/:id/cancel/confirm. handleCancel drives the
// domain helper (submitOrderCancel), advances to step-2 on a park (never a false
// success), and handleCancelConfirm (submitOrderCancelConfirm) completes it. The
// step-2 dialog restates ONLY the KERNEL's prompt — the fact of what will happen
// is never app-authored copy.
//
// Strategy mirrors AmendOrderDialog.add.test.tsx: node env, react hooks mocked
// (useState returns [override-or-init, setter] by call order; useCallback
// captures the callbacks), the real jsx-runtime builds a plain element tree.

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  submitOrderCancel: vi.fn(),
  submitOrderCancelConfirm: vi.fn(),
  onMutate: vi.fn(),
  overrides: {} as Record<number, unknown>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  callbacks: [] as Array<(...a: unknown[]) => unknown>,
  idx: { v: 0 },
}))

vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = h.idx.v++
    const setter = vi.fn()
    h.setters[i] = setter
    return [i in h.overrides ? h.overrides[i] : init, setter]
  },
  useCallback: (fn: (...a: unknown[]) => unknown) => {
    h.callbacks.push(fn)
    return fn
  },
  default: {},
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }))
vi.mock("@/domains/orders/cancelConfirm", () => ({
  submitOrderCancel: (...a: unknown[]) => h.submitOrderCancel(...(a as [])),
  submitOrderCancelConfirm: (...a: unknown[]) => h.submitOrderCancelConfirm(...(a as [])),
}))
vi.mock("@ibatexas/ui/atoms", () => ({ Button: "Button" }))
vi.mock("@ibatexas/ui/molecules", () => ({ Modal: "Modal" }))
vi.mock("./AmendOrderDialog", () => ({ AmendOrderDialog: "AmendOrderDialog" }))
vi.mock("../../components/molecules/AmendOrderDialog", () => ({ AmendOrderDialog: "AmendOrderDialog" }))
vi.mock("./SwitchTypeDialog", () => ({ SwitchTypeDialog: "SwitchTypeDialog" }))
vi.mock("../../components/molecules/SwitchTypeDialog", () => ({ SwitchTypeDialog: "SwitchTypeDialog" }))

import { OrderActions } from "../../components/molecules/OrderActions"

// useState call order: 0 cancelOpen, 1 amendOpen, 2 typeOpen, 3 activeAction,
// 4 errorMsg, 5 cancelNotice, 6 cancelConfirm.
const S = { cancelConfirm: 6 } as const

const PAID_CONFIRMED_PROPS = {
  orderId: "order_01",
  fulfillmentStatus: "confirmed",
  currentPayment: { id: "pay_01", method: "pix", status: "paid" },
  orderType: "pickup",
  items: [{ id: "i1", title: "Costela", quantity: 1, variant_id: "v1", unit_price: 5000, productType: "food" as const }],
  onMutate: h.onMutate,
}

function render(overrides: Record<number, unknown> = {}) {
  h.setters = []
  h.callbacks = []
  h.idx.v = 0
  h.overrides = overrides
  const tree = OrderActions(PAID_CONFIRMED_PROPS)
  // callbacks[0] = handleCancel, callbacks[1] = handleCancelConfirm.
  return { tree, handleCancel: h.callbacks[0]!, handleCancelConfirm: h.callbacks[1]! }
}

function anySetterCalledWith(pred: (v: unknown) => boolean): boolean {
  return h.setters.some((s) => s.mock.calls.some((c) => pred(c[0])))
}

// Flatten the element tree into props objects (handles arrays + nested children).
function flatten(node: unknown, acc: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const c of node) flatten(c, acc)
    return acc
  }
  if (!node || typeof node !== "object") return acc
  const props = (node as { props?: Record<string, unknown> }).props
  if (props) {
    acc.push(props)
    flatten(props.children, acc)
    if (props.footer !== undefined) flatten(props.footer, acc)
  }
  return acc
}

beforeEach(() => {
  vi.clearAllMocks()
  h.overrides = {}
})

describe("OrderActions handleCancel — two-phase park (BKL-146/FE-D19)", () => {
  it("202 needs_confirmation → advances to step-2 (sets cancelConfirm), NEVER a false success (modal not closed)", async () => {
    h.submitOrderCancel.mockResolvedValue({
      kind: "needs_confirmation",
      confirmationId: "rcpt_1",
      prompt: "Esse pedido já foi pago — confirma o cancelamento?",
    })
    const { handleCancel } = render()
    await handleCancel()

    expect(h.submitOrderCancel).toHaveBeenCalledWith("order_01")
    // step-2 armed with the receipt + the kernel prompt.
    expect(anySetterCalledWith((v) =>
      typeof v === "object" && v !== null && (v as { confirmationId?: string }).confirmationId === "rcpt_1",
    )).toBe(true)
    // NOT closed as success (setCancelOpen(false) is the unique close signal).
    expect(anySetterCalledWith((v) => v === false)).toBe(false)
  })

  it("executed (unpaid order) → real success: onMutate + modal closed", async () => {
    h.submitOrderCancel.mockResolvedValue({ kind: "executed" })
    const { handleCancel } = render()
    await handleCancel()
    expect(h.onMutate).toHaveBeenCalledTimes(1)
    expect(anySetterCalledWith((v) => v === false)).toBe(true) // setCancelOpen(false)
  })

  it("error → honest error message, no false success", async () => {
    h.submitOrderCancel.mockResolvedValue({ kind: "error" })
    const { handleCancel } = render()
    await handleCancel()
    expect(anySetterCalledWith((v) => v === "cancel_error")).toBe(true)
    expect(anySetterCalledWith((v) => v === false)).toBe(false)
  })
})

describe("OrderActions handleCancelConfirm — completion (BKL-146/FE-D19)", () => {
  const armed = { [S.cancelConfirm]: { confirmationId: "rcpt_1", prompt: "confirma?" } }

  it("posts the receipt to the confirm route and, on EXECUTE, closes + onMutate", async () => {
    h.submitOrderCancelConfirm.mockResolvedValue({ kind: "executed" })
    const { handleCancelConfirm } = render(armed)
    await handleCancelConfirm()
    expect(h.submitOrderCancelConfirm).toHaveBeenCalledWith("order_01", "rcpt_1")
    expect(h.onMutate).toHaveBeenCalledTimes(1)
    expect(anySetterCalledWith((v) => v === false)).toBe(true) // setCancelOpen(false)
  })

  it("expired receipt → drops step-2 + honest expiry notice (never a false cancel)", async () => {
    h.submitOrderCancelConfirm.mockResolvedValue({ kind: "expired" })
    const { handleCancelConfirm } = render(armed)
    await handleCancelConfirm()
    expect(anySetterCalledWith((v) => v === "cancel_confirmation_expired")).toBe(true)
    expect(anySetterCalledWith((v) => v === null)).toBe(true) // setCancelConfirm(null)
    expect(anySetterCalledWith((v) => v === false)).toBe(false) // NOT closed as success
  })

  it("not_allowed (past-PONR since park) → surfaces the server message honestly", async () => {
    h.submitOrderCancelConfirm.mockResolvedValue({ kind: "not_allowed", message: "Passou do ponto de cancelamento." })
    const { handleCancelConfirm } = render(armed)
    await handleCancelConfirm()
    expect(anySetterCalledWith((v) => v === "Passou do ponto de cancelamento.")).toBe(true)
    expect(anySetterCalledWith((v) => v === false)).toBe(false)
  })
})

describe("OrderActions step-2 dialog — restates ONLY the kernel prompt (FE-D19)", () => {
  it("renders the kernel's prompt VERBATIM (never an app-authored claim about what will happen)", () => {
    const kernelPrompt = "Esse pedido já foi pago (R$ 50,00). Cancelar implica reembolso — confirma?"
    const { tree } = render({ [S.cancelConfirm]: { confirmationId: "rcpt_1", prompt: kernelPrompt } })
    const nodes = flatten(tree)
    // The step-2 body carries the kernel prompt VERBATIM (data-testid pin), and
    // the app never substitutes a translation key for the fact of what happens.
    const promptNode = nodes.find((p) => p["data-testid"] === "cancel-kernel-prompt")
    expect(promptNode).toBeDefined()
    expect(promptNode!.children).toBe(kernelPrompt)
    // The step-1 app-copy body is NOT shown in step-2.
    const texts = nodes.map((p) => p.children)
    expect(texts).not.toContain("cancel_confirm_body")
    // The complete button label is present (an action label, not a fact claim).
    expect(texts).toContain("cancel_confirm_complete")
  })
})
