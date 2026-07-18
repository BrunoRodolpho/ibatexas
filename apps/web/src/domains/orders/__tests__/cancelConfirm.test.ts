/**
 * Two-phase order cancel helper (BKL-146 / FE-D19). Classifies the raw replies
 * so the UI renders an honest outcome: a 202 park is NEVER a confident "cancelled"
 * success, and a 410 receipt-expiry is distinguished from a generic error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@ibatexas/tools/api', () => ({ getApiBase: () => 'http://api.test' }))

import { submitOrderCancel, submitOrderCancelConfirm } from '../cancelConfirm'

const fetchMock = vi.fn()

function reply(status: number, body: unknown, ok?: boolean): Response {
  return {
    ok: ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

describe('submitOrderCancel', () => {
  it('POSTs the cancel with the reason to the cancel route', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true }))
    await submitOrderCancel('o1', 'Mudei de ideia')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/orders/o1/cancel',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ reason: 'Mudei de ideia' }),
      }),
    )
  })

  it('omits reason when not given (empty body)', async () => {
    fetchMock.mockResolvedValue(reply(200, {}))
    await submitOrderCancel('o1')
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBe(JSON.stringify({}))
  })

  it('200 → executed', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true }))
    expect(await submitOrderCancel('o1')).toEqual({ kind: 'executed' })
  })

  it('202 confirmationRequired → needs_confirmation {confirmationId, prompt, ttlSeconds}', async () => {
    fetchMock.mockResolvedValue(
      reply(202, {
        confirmationRequired: true,
        confirmationId: 'rcpt_1',
        prompt: 'Esse pedido já foi pago — confirma o cancelamento?',
        ttlSeconds: 600,
      }),
    )
    expect(await submitOrderCancel('o1')).toEqual({
      kind: 'needs_confirmation',
      confirmationId: 'rcpt_1',
      prompt: 'Esse pedido já foi pago — confirma o cancelamento?',
      ttlSeconds: 600,
    })
  })

  it('202 park WITHOUT a usable confirmationId → error (never a dead-end confirm step)', async () => {
    fetchMock.mockResolvedValue(reply(202, { confirmationRequired: true, prompt: 'x' }))
    expect(await submitOrderCancel('o1')).toEqual({ kind: 'error' })
  })

  it('403/409/422 → not_allowed with server code + message', async () => {
    fetchMock.mockResolvedValue(reply(409, { error: 'Falha no pagamento.', code: 'PAYMENT_CANCEL_FAILED' }))
    expect(await submitOrderCancel('o1')).toEqual({
      kind: 'not_allowed',
      code: 'PAYMENT_CANCEL_FAILED',
      message: 'Falha no pagamento.',
    })
  })

  it('500 → error; network throw → error', async () => {
    fetchMock.mockResolvedValue(reply(500, { error: 'boom' }))
    expect(await submitOrderCancel('o1')).toEqual({ kind: 'error' })
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await submitOrderCancel('o1')).toEqual({ kind: 'error' })
  })
})

describe('submitOrderCancelConfirm', () => {
  it('POSTs the confirmationId to the confirm route', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true }))
    await submitOrderCancelConfirm('o1', 'rcpt_1')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/orders/o1/cancel/confirm',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ confirmationId: 'rcpt_1' }),
      }),
    )
  })

  it('200 → executed (the real cancel)', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true }))
    expect(await submitOrderCancelConfirm('o1', 'rcpt_1')).toEqual({ kind: 'executed' })
  })

  it('410 → expired (single-use receipt consumed / TTL passed)', async () => {
    fetchMock.mockResolvedValue(reply(410, { code: 'CONFIRMATION_EXPIRED' }))
    expect(await submitOrderCancelConfirm('o1', 'rcpt_1')).toEqual({ kind: 'expired' })
  })

  it('422 (order moved past the PONR since the park) → not_allowed', async () => {
    fetchMock.mockResolvedValue(reply(422, { error: 'Passou do ponto de cancelamento.', code: 'PONR_EXPIRED' }))
    const r = await submitOrderCancelConfirm('o1', 'rcpt_1')
    expect(r.kind).toBe('not_allowed')
    expect((r as { code?: string }).code).toBe('PONR_EXPIRED')
  })

  it('403 → not_allowed (IDOR / foreign receipt)', async () => {
    fetchMock.mockResolvedValue(reply(403, { error: 'Proibido.' }))
    expect((await submitOrderCancelConfirm('o1', 'rcpt_1')).kind).toBe('not_allowed')
  })

  it('500 → error; network throw → error', async () => {
    fetchMock.mockResolvedValue(reply(500, { error: 'boom' }))
    expect(await submitOrderCancelConfirm('o1', 'rcpt_1')).toEqual({ kind: 'error' })
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(await submitOrderCancelConfirm('o1', 'rcpt_1')).toEqual({ kind: 'error' })
  })
})
