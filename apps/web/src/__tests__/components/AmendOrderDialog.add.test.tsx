// AmendOrderDialog — add-item submit branch (CUS-039).
//
// Adds go through the SINGLE kernel-governed amend route via `submitAmendAdd`.
// This test drives `handleAddSubmit` (the 2nd useCallback) against a mocked
// `submitAmendAdd`, asserting each classified outcome maps to the right UI
// effect — and that a 202 park is NEVER treated as success (no close/onMutate
// beyond the honest refresh, an honest notice instead).
//
// Strategy mirrors OrderActions.cancel.test.tsx: node env, react hooks mocked
// (useState captures setters by call order; useMemo runs the factory; useCallback
// captures the callbacks). handleClose is callback[0], handleAddSubmit is [1].

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  submitAmendAdd: vi.fn(),
  apiFetch: vi.fn(),
  onMutate: vi.fn(),
  onClose: vi.fn(),
  overrides: {} as Record<number, unknown>,
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  callbacks: [] as Array<(...a: unknown[]) => unknown>,
  idx: { v: 0 },
}))

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = h.idx.v++
    const setter = vi.fn()
    h.setters[i] = setter
    if (i in h.overrides) return [h.overrides[i], setter]
    // Honor React's lazy initializer semantics (quantities/removedIds use `() => new Map()`).
    const value = typeof init === 'function' ? (init as () => unknown)() : init
    return [value, setter]
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: (...a: unknown[]) => unknown) => {
    h.callbacks.push(fn)
    return fn
  },
  default: {},
}))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@ibatexas/ui/atoms', () => ({ Button: 'Button' }))
vi.mock('@ibatexas/ui/molecules', () => ({ Modal: 'Modal' }))
vi.mock('@/lib/api', () => ({ apiFetch: (...a: unknown[]) => h.apiFetch(...(a as [])) }))
vi.mock('@/lib/format', () => ({ formatBRL: (c: number) => `R$ ${c}` }))
vi.mock('@/domains/cart', () => ({ submitAmendAdd: (...a: unknown[]) => h.submitAmendAdd(...(a as [])) }))
vi.mock('../../components/molecules/AddItemPicker', () => ({ AddItemPicker: 'AddItemPicker' }))
vi.mock('./AddItemPicker', () => ({ AddItemPicker: 'AddItemPicker' }))

import { AmendOrderDialog } from '../../components/molecules/AmendOrderDialog'

// useState call order: 0 step, 1 submitState, 2 errorMsg, 3 quantities, 4 removedIds, 5 confirmingRemoveId
const S = { step: 0, submitState: 1, errorMsg: 2 } as const

const PROPS = {
  orderId: 'order_01',
  items: [{ id: 'i1', title: 'Costela', quantity: 1, variant_id: 'v1', unit_price: 5000, productType: 'food' as const }],
  fulfillmentStatus: 'confirmed',
  isOpen: true,
  onClose: h.onClose,
  onMutate: h.onMutate,
}

function renderTree(overrides: Record<number, unknown> = {}) {
  h.setters = []
  h.callbacks = []
  h.idx.v = 0
  h.overrides = overrides
  const tree = AmendOrderDialog(PROPS)
  return { tree, flat: flatten(tree) }
}

function renderAndGetHandleAddSubmit() {
  h.overrides = {}
  const { tree } = renderTree()
  void tree
  // handleClose = callbacks[0], handleAddSubmit = callbacks[1]
  return h.callbacks[1] as (variantId: string, quantity: number) => Promise<void>
}

// Flatten the Modal children tree (handles nested `.map()` arrays).
function flatten(node: unknown, acc: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const c of node) flatten(c, acc)
    return acc
  }
  if (!node || typeof node !== 'object') return acc
  const props = (node as { props?: Record<string, unknown> }).props
  if (props) {
    acc.push(props)
    flatten(props.children, acc)
  }
  return acc
}

function findByType(nodes: unknown, type: string): Record<string, unknown> | undefined {
  const stack: unknown[] = [nodes]
  while (stack.length) {
    const cur = stack.pop()
    if (Array.isArray(cur)) { stack.push(...cur); continue }
    if (!cur || typeof cur !== 'object') continue
    const el = cur as { type?: unknown; props?: Record<string, unknown> }
    if (el.type === type) return el.props
    if (el.props?.children !== undefined) stack.push(el.props.children)
    if (el.props?.footer !== undefined) stack.push(el.props.footer)
  }
  return undefined
}

function setterCalledWith(index: number, value: unknown): boolean {
  return h.setters[index].mock.calls.some((c) => c[0] === value)
}

beforeEach(() => vi.clearAllMocks())

describe('AmendOrderDialog handleAddSubmit (CUS-039)', () => {
  it('executed → onMutate + close (real success)', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'executed' })
    const handleAddSubmit = renderAndGetHandleAddSubmit()
    await handleAddSubmit('v9', 2)

    expect(h.submitAmendAdd).toHaveBeenCalledWith({ orderId: 'order_01', variantId: 'v9', quantity: 2 })
    expect(h.onMutate).toHaveBeenCalledTimes(1)
    expect(h.onClose).toHaveBeenCalledTimes(1) // handleClose ran
    expect(setterCalledWith(S.submitState, 'loading')).toBe(true)
  })

  it('confirmation_required (202 park) → honest notice, NO false success', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'confirmation_required', prompt: 'confirma?' })
    const handleAddSubmit = renderAndGetHandleAddSubmit()
    await handleAddSubmit('v9', 1)

    // NOT closed as success…
    expect(h.onClose).not.toHaveBeenCalled()
    // …honest pt-BR notice surfaced, returned to the edit step, and a refresh.
    expect(setterCalledWith(S.errorMsg, 'amend_add_needs_confirmation')).toBe(true)
    expect(setterCalledWith(S.step, 'edit')).toBe(true)
    expect(h.onMutate).toHaveBeenCalledTimes(1)
  })

  it('not_allowed → surfaces the server pt-BR message, stays on the add step', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'not_allowed', code: 'ACTION_NOT_ALLOWED', message: 'Não é possível.' })
    const handleAddSubmit = renderAndGetHandleAddSubmit()
    await handleAddSubmit('v9', 1)

    expect(setterCalledWith(S.errorMsg, 'Não é possível.')).toBe(true)
    expect(h.onClose).not.toHaveBeenCalled()
    expect(h.onMutate).not.toHaveBeenCalled()
  })

  it('not_allowed without a server message → generic pt-BR fallback', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'not_allowed' })
    const handleAddSubmit = renderAndGetHandleAddSubmit()
    await handleAddSubmit('v9', 1)
    expect(setterCalledWith(S.errorMsg, 'amend_add_not_allowed')).toBe(true)
  })

  it('rate_limited → rate-limit notice', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'rate_limited' })
    const handleAddSubmit = renderAndGetHandleAddSubmit()
    await handleAddSubmit('v9', 1)
    expect(setterCalledWith(S.errorMsg, 'amend_rate_limited')).toBe(true)
    expect(h.onClose).not.toHaveBeenCalled()
  })

  it('error → generic amend error', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'error' })
    const handleAddSubmit = renderAndGetHandleAddSubmit()
    await handleAddSubmit('v9', 1)
    expect(setterCalledWith(S.errorMsg, 'amend_error')).toBe(true)
    expect(h.onClose).not.toHaveBeenCalled()
  })
})

describe('AmendOrderDialog — add-step wiring (CUS-039)', () => {
  it('the edit step exposes an add-item affordance that opens the add step', () => {
    const { flat } = renderTree() // default step = 'edit'
    // Invoke every body onClick; the "+ add item" button sets step to 'add'.
    flat
      .filter((p) => typeof p.onClick === 'function')
      .forEach((p) => (p.onClick as () => void)())
    expect(setterCalledWith(S.step, 'add')).toBe(true)
  })

  it('the add step renders the picker and suppresses the Modal footer', () => {
    const { tree } = renderTree({ [S.step]: 'add' })
    const picker = findByType(tree, 'AddItemPicker')
    expect(picker).toBeDefined()
    expect(typeof picker!.onAdd).toBe('function')
    expect(typeof picker!.onBack).toBe('function')
    // Footer is undefined on the add step (the picker owns its own actions).
    const modal = tree as { props?: Record<string, unknown> }
    expect(modal.props?.footer).toBeUndefined()
    // onBack returns to the edit step.
    ;(picker!.onBack as () => void)()
    expect(setterCalledWith(S.step, 'edit')).toBe(true)
  })

  it('the picker onAdd wires straight into the single-route submit', async () => {
    h.submitAmendAdd.mockResolvedValue({ kind: 'executed' })
    const { tree } = renderTree({ [S.step]: 'add' })
    const picker = findByType(tree, 'AddItemPicker')!
    await (picker.onAdd as (v: string, q: number) => Promise<void>)('v7', 3)
    expect(h.submitAmendAdd).toHaveBeenCalledWith({ orderId: 'order_01', variantId: 'v7', quantity: 3 })
  })

  it('the review step keeps its own footer branch', () => {
    const { tree } = renderTree({ [S.step]: 'review' })
    const modal = tree as { props?: Record<string, unknown> }
    // A review-step footer element is present (not the add-step undefined).
    expect(modal.props?.footer).toBeDefined()
  })
})
