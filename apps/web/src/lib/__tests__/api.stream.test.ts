/**
 * BKL-286 — apiStream: credential headers + frame reassembly.
 *
 * This is a fetch-based SSE reader (NOT an EventSource), which is exactly why
 * the fix can put the session secret in a header instead of the URL. Both
 * properties are pinned here: headers reach the request, and a frame split
 * across TCP reads is still delivered — the denied-stream `error` frame is a
 * single frame, so losing it to a read boundary would leave the UI silent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiStream, ApiError } from '../api'

/** Build a Response whose body streams `parts` as separate reads. */
function sseResponse(parts: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p))
      controller.close()
    },
  })
  return { ok, status, statusText: ok ? 'OK' : 'Forbidden', body } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiStream — request shape', () => {
  it('sends the supplied credential headers', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"type":"done"}\n\n']))

    await apiStream('/api/chat/stream/s1', () => {}, undefined, {
      'x-session-secret': 'secret-1',
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).toEqual({ 'x-session-secret': 'secret-1' })
    expect(init.credentials).toBe('include')
    // The credential is not in the URL — URLs reach access logs and Referer.
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret-1')
  })

  it('omits headers entirely when none are given (unchanged legacy shape)', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"type":"done"}\n\n']))

    await apiStream('/api/chat/stream/s1', () => {})

    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined()
  })

  it('throws an ApiError carrying the status on a non-ok response', async () => {
    fetchMock.mockResolvedValue(sseResponse([], false, 403))

    await expect(apiStream('/api/chat/stream/s1', () => {})).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    })
    await expect(apiStream('/api/chat/stream/s1', () => {})).rejects.toBeInstanceOf(ApiError)
  })
})

describe('apiStream — frame reassembly across read boundaries', () => {
  it('delivers a frame split mid-JSON across two reads', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"type":"error","mess', 'age":"Acesso negado.","code":"session_denied"}\n\n']),
    )

    const chunks: unknown[] = []
    await apiStream('/api/chat/stream/s1', (c) => chunks.push(c))

    expect(chunks).toEqual([
      { type: 'error', message: 'Acesso negado.', code: 'session_denied' },
    ])
  })

  it('delivers a frame split exactly on the "data: " prefix', async () => {
    fetchMock.mockResolvedValue(sseResponse(['da', 'ta: {"type":"done"}\n\n']))

    const chunks: unknown[] = []
    await apiStream('/api/chat/stream/s1', (c) => chunks.push(c))

    expect(chunks).toEqual([{ type: 'done' }])
  })

  it('delivers a final frame that arrives with no trailing newline', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"type":"done"}']))

    const chunks: unknown[] = []
    await apiStream('/api/chat/stream/s1', (c) => chunks.push(c))

    expect(chunks).toEqual([{ type: 'done' }])
  })

  it('delivers every frame of a multi-frame stream, in order, across ragged reads', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"text_delta","delta":"Temos ',
        'costela"}\n\ndata: {"type":"text_de',
        'lta","delta":" defumada"}\n\ndata: {"type":"done"}\n\n',
      ]),
    )

    const chunks: unknown[] = []
    await apiStream('/api/chat/stream/s1', (c) => chunks.push(c))

    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'Temos costela' },
      { type: 'text_delta', delta: ' defumada' },
      { type: 'done' },
    ])
  })

  it('ignores heartbeat comments and malformed frames without dropping the rest', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([': ping\n\ndata: not-json\n\ndata: {"type":"done"}\n\n']),
    )

    const chunks: unknown[] = []
    await apiStream('/api/chat/stream/s1', (c) => chunks.push(c))

    expect(chunks).toEqual([{ type: 'done' }])
  })
})
