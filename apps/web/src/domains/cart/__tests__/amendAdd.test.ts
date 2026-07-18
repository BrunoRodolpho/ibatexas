/**
 * Post-order add-item helper (CUS-039). The pure helpers gate the picker UI;
 * `submitAmendAdd` classifies the raw reply from the SINGLE kernel-governed
 * amend route so a 202 park is NEVER rendered as a confident success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@ibatexas/tools/api', () => ({ getApiBase: () => 'http://api.test' }))

import {
  isValidAddQuantity,
  resolveAddVariant,
  computeAddPriceDelta,
  buildAmendAddBody,
  submitAmendAdd,
  MAX_ADD_QUANTITY,
} from '../amendAdd'
import type { ProductDTO, ProductVariant } from '@ibatexas/types'

function variant(over: Partial<ProductVariant> = {}): ProductVariant {
  return { id: 'v1', title: 'Padrão', sku: null, price: 5000, ...over }
}

function product(over: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: 'p1',
    title: 'Costela',
    description: null,
    price: 8900,
    imageUrl: null,
    images: [],
    tags: [],
    availabilityWindow: 'sempre' as ProductDTO['availabilityWindow'],
    allergens: [],
    variants: [variant()],
    productType: 'food' as ProductDTO['productType'],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  }
}

describe('amendAdd — isValidAddQuantity', () => {
  it('accepts integers within [1, MAX]', () => {
    for (const q of [1, 2, MAX_ADD_QUANTITY]) expect(isValidAddQuantity(q)).toBe(true)
  })
  it('rejects zero, negatives, > MAX and non-integers', () => {
    for (const q of [0, -1, MAX_ADD_QUANTITY + 1, 2.5, Number.NaN]) {
      expect(isValidAddQuantity(q)).toBe(false)
    }
  })
})

describe('amendAdd — resolveAddVariant', () => {
  it('returns the explicitly chosen variant by id', () => {
    const p = product({ variants: [variant({ id: 'v1' }), variant({ id: 'v2', price: 7000 })] })
    expect(resolveAddVariant(p, 'v2')?.id).toBe('v2')
  })
  it('falls back to the first variant when the id is unknown or omitted', () => {
    const p = product({ variants: [variant({ id: 'v1' }), variant({ id: 'v2' })] })
    expect(resolveAddVariant(p, 'nope')?.id).toBe('v1')
    expect(resolveAddVariant(p)?.id).toBe('v1')
  })
  it('returns undefined when the product has no variants', () => {
    expect(resolveAddVariant(product({ variants: [] }))).toBeUndefined()
  })
})

describe('amendAdd — computeAddPriceDelta', () => {
  it('uses the variant price × quantity', () => {
    expect(computeAddPriceDelta(product(), variant({ price: 5000 }), 3)).toBe(15000)
  })
  it('falls back to the product price when no variant is given', () => {
    expect(computeAddPriceDelta(product({ price: 8900 }), undefined, 2)).toBe(17800)
  })
})

describe('amendAdd — buildAmendAddBody', () => {
  it('builds the single-route add body', () => {
    expect(buildAmendAddBody({ orderId: 'o1', variantId: 'v9', quantity: 4 })).toEqual({
      action: 'add',
      variantId: 'v9',
      quantity: 4,
    })
  })
})

describe('amendAdd — submitAmendAdd', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  function reply(status: number, body: unknown, ok?: boolean): Response {
    return {
      ok: ok ?? (status >= 200 && status < 300),
      status,
      json: async () => body,
    } as unknown as Response
  }

  it('POSTs the add body to the single amend route', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true }))
    await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 2 })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/orders/o1/amend',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ action: 'add', variantId: 'v1', quantity: 2 }),
      }),
    )
  })

  it('200 → executed', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true }))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({ kind: 'executed' })
  })

  it('202 confirmationRequired → confirmation_required (NOT executed)', async () => {
    fetchMock.mockResolvedValue(reply(202, { confirmationRequired: true, prompt: 'confirma?' }))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({
      kind: 'confirmation_required',
      prompt: 'confirma?',
    })
  })

  it('202 without confirmationRequired → executed', async () => {
    fetchMock.mockResolvedValue(reply(202, { status: 'deferred' }))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({ kind: 'executed' })
  })

  it('403 → not_allowed with server code + pt-BR message', async () => {
    fetchMock.mockResolvedValue(reply(403, { error: 'Não permitido.', code: 'ACTION_NOT_ALLOWED' }))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({
      kind: 'not_allowed',
      code: 'ACTION_NOT_ALLOWED',
      message: 'Não permitido.',
    })
  })

  it('422 → not_allowed', async () => {
    fetchMock.mockResolvedValue(reply(422, { error: 'Não é possível.' }))
    const r = await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })
    expect(r.kind).toBe('not_allowed')
  })

  it('429 → rate_limited', async () => {
    fetchMock.mockResolvedValue(reply(429, { code: 'RATE_LIMIT' }))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({ kind: 'rate_limited' })
  })

  it('500 → error', async () => {
    fetchMock.mockResolvedValue(reply(500, { error: 'boom' }))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({ kind: 'error' })
  })

  it('network throw → error', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({ kind: 'error' })
  })

  it('non-JSON body on a 2xx → executed (best-effort parse)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    expect(await submitAmendAdd({ orderId: 'o1', variantId: 'v1', quantity: 1 })).toEqual({ kind: 'executed' })
  })
})
