/**
 * BKL-286 — useChat: stream credential propagation (leg 1) + error-path copy (leg 2).
 *
 * SEAM: the real `useChat` hook driving the REAL chat store, with only the two
 * transport functions (`apiFetch` / `apiStream`) doubled — so what is asserted
 * is the exact pair of requests the browser issues, in order, with their real
 * headers. The store is real because the defect lived precisely in the handoff
 * between "adopt the credential" and "open the stream".
 *
 * React is removed from the picture by swapping zustand's React binding for its
 * VANILLA store: `create` still runs the store's real initializer (so every
 * action under test is the production one), it simply no longer needs a
 * renderer to read state. Mocking `react` itself does not work here — zustand
 * resolves React through its own module path — and a hand-rolled dispatcher
 * would only prove things about the double.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Hoisted doubles ─────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiStream: vi.fn(),
  resetSession: vi.fn(),
  sessionId: 'sess-abc',
}))

vi.mock('zustand', async () => {
  const { createStore } = await import('zustand/vanilla')
  return {
    create: (initializer: Parameters<typeof createStore>[0]) => {
      const api = createStore(initializer)
      const useBoundStore = (selector?: (s: unknown) => unknown) =>
        selector ? selector(api.getState()) : api.getState()
      return Object.assign(useBoundStore, api)
    },
  }
})

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    // Keep the REAL ApiError: the hook branches on `instanceof`, so a doubled
    // class would make the 403 case pass for the wrong reason.
    ApiError: actual.ApiError,
    apiFetch: (...a: unknown[]) => h.apiFetch(...a),
    apiStream: (...a: unknown[]) => h.apiStream(...a),
  }
})

vi.mock('@/domains/session', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ sessionId: h.sessionId, resetSession: h.resetSession }),
}))

import { ApiError } from '@/lib/api'
import { useChat } from '../chat.hooks'
import { useChatStore } from '../chat.store'
import {
  CHAT_ERROR_CODE_SESSION_DENIED,
  CHAT_GENERIC_FAILURE_PTBR,
  CHAT_SESSION_EXPIRED_PTBR,
} from '../chat.errors'

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The hook under test. With zustand vanilla-backed (above) `useChat` performs
 * no dispatcher work, so it is an ordinary function here; aliasing it says so,
 * and keeps rules-of-hooks from reading these plain test calls as hook calls.
 */
const openChat = useChat as () => ReturnType<typeof useChat>

/** Headers the widget put on the SSE GET for the Nth stream (0-based). */
function streamHeaders(call = 0): Record<string, string> {
  return h.apiStream.mock.calls[call]?.[3] as Record<string, string>
}

/** Headers the widget put on the Nth POST (0-based). */
function postHeaders(call = 0): Record<string, string> {
  return (h.apiStream.mock.calls.length >= 0
    ? (h.apiFetch.mock.calls[call]?.[1] as { headers: Record<string, string> })
    : { headers: {} }
  ).headers
}

/** Drive the stream double: feed `frames` to the hook's chunk callback. */
function streamYields(...frames: unknown[]): void {
  h.apiStream.mockImplementation(async (_url, onChunk: (c: unknown) => void) => {
    for (const f of frames) onChunk(f)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sessionId = 'sess-abc'
  useChatStore.setState({
    messages: [],
    isLoading: false,
    error: undefined,
    errorCanRestart: false,
    sessionSecret: undefined,
    sessionToken: undefined,
  })
  h.apiFetch.mockResolvedValue({ messageId: 'm1' })
  streamYields({ type: 'text_delta', delta: 'oi!' }, { type: 'done' })
})

// ── LEG 1 ───────────────────────────────────────────────────────────────────

describe('BKL-286 leg 1 — the SSE stream presents the CURRENT session secret', () => {
  it('sends the secret the POST just minted on the stream request', async () => {
    h.apiFetch.mockResolvedValue({ messageId: 'm1', sessionSecret: 'minted-1' })

    await openChat().sendMessage('quero costela')

    expect(h.apiStream).toHaveBeenCalledTimes(1)
    expect(streamHeaders()).toEqual({ 'x-session-secret': 'minted-1' })
    // ...and it was adopted for later turns.
    expect(useChatStore.getState().sessionSecret).toBe('minted-1')
  })

  it("the owner's double-message sequence heals: a RE-MINTED secret reaches BOTH streams", async () => {
    // The browser holds a secret Redis no longer knows (TTL elapsed / repair).
    useChatStore.setState({ sessionSecret: 'stale-from-last-visit' })

    // ── message 1: the server re-mints; the stream must use the NEW value ──
    h.apiFetch.mockResolvedValue({ messageId: 'm1', sessionSecret: 'reminted' })
    await openChat().sendMessage('primeira')

    expect(postHeaders(0)).toEqual({ 'x-session-secret': 'stale-from-last-visit' })
    expect(streamHeaders(0)).toEqual({ 'x-session-secret': 'reminted' })

    // ── message 2: nothing is re-minted; the adopted secret must persist ──
    h.apiFetch.mockResolvedValue({ messageId: 'm2' })
    await openChat().sendMessage('segunda')

    expect(postHeaders(1)).toEqual({ 'x-session-secret': 'reminted' })
    expect(streamHeaders(1)).toEqual({ 'x-session-secret': 'reminted' })

    // Neither turn showed the customer an error.
    expect(useChatStore.getState().error).toBeUndefined()
  })

  it('never puts a credential in the stream URL (logs/Referer leak)', async () => {
    h.apiFetch.mockResolvedValue({ messageId: 'm1', sessionSecret: 'minted-1' })

    await openChat().sendMessage('oi')

    const url = h.apiStream.mock.calls[0][0] as string
    expect(url).toBe('/api/chat/stream/sess-abc')
    expect(url).not.toContain('minted-1')
    expect(url).not.toContain('?')
  })

  it('forwards the session token too, for an authenticated stream', async () => {
    h.apiFetch.mockResolvedValue({ messageId: 'm1', sessionToken: 'jwt-1' })

    await openChat().sendMessage('oi')

    expect(streamHeaders()).toEqual({ 'x-session-token': 'jwt-1' })
  })

  it('sends no credential header when the client holds none', async () => {
    await openChat().sendMessage('oi')
    expect(streamHeaders()).toEqual({})
  })
})

// ── LEG 2 ───────────────────────────────────────────────────────────────────

describe('BKL-286 leg 2 — a denied stream renders human pt-BR recovery copy', () => {
  it('a coded denial frame becomes the session-expired message + restart affordance', async () => {
    streamYields({
      type: 'error',
      message: 'Acesso negado.',
      code: CHAT_ERROR_CODE_SESSION_DENIED,
    })

    await openChat().sendMessage('oi')

    const s = useChatStore.getState()
    expect(s.error).toBe(CHAT_SESSION_EXPIRED_PTBR)
    expect(s.errorCanRestart).toBe(true)
    // The raw server string is NOT what the customer sees.
    expect(s.error).not.toContain('Acesso negado.')
    expect(s.error).not.toContain(CHAT_ERROR_CODE_SESSION_DENIED)
    // ...and the widget is usable again rather than spinning forever.
    expect(s.isLoading).toBe(false)
  })

  it('a legacy denial frame (prose only, no code) maps to the same copy', async () => {
    streamYields({ type: 'error', message: 'Acesso negado.' })

    await openChat().sendMessage('oi')

    expect(useChatStore.getState().error).toBe(CHAT_SESSION_EXPIRED_PTBR)
    expect(useChatStore.getState().errorCanRestart).toBe(true)
  })

  it('a stream that ends with NEITHER error nor done still stops the spinner', async () => {
    streamYields() // connection closed silently

    await openChat().sendMessage('oi')

    const s = useChatStore.getState()
    expect(s.isLoading).toBe(false)
    expect(s.error).toBe(CHAT_GENERIC_FAILURE_PTBR)
  })

  it('a rejected POST (403) offers a new conversation instead of leaking "API error: 403"', async () => {
    h.apiFetch.mockRejectedValue(new ApiError(403, 'Forbidden'))

    await openChat().sendMessage('oi')

    const s = useChatStore.getState()
    expect(s.error).toBe(CHAT_SESSION_EXPIRED_PTBR)
    expect(s.errorCanRestart).toBe(true)
    expect(s.error).not.toContain('API error')
    expect(s.error).not.toContain('403')
    expect(s.isLoading).toBe(false)
  })

  it('any other transport failure shows the generic pt-BR copy, never the thrown text', async () => {
    h.apiFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.internal'))

    await openChat().sendMessage('oi')

    const s = useChatStore.getState()
    expect(s.error).toBe(CHAT_GENERIC_FAILURE_PTBR)
    expect(s.error).not.toContain('ENOTFOUND')
    expect(s.errorCanRestart).toBe(false)
  })

  it('a malformed text_delta never renders as a bubble: no "undefined", no "[object Object]", no JSON', async () => {
    streamYields(
      { type: 'text_delta' }, // delta missing
      { type: 'text_delta', delta: { messageId: 'm1' } }, // delta is a payload
      { type: 'text_delta', delta: 42 },
      { type: 'done' },
    )

    await openChat().sendMessage('oi')

    const rendered = useChatStore.getState().messages.map((m) => m.content).join('|')
    expect(rendered).not.toContain('undefined')
    expect(rendered).not.toContain('[object Object]')
    expect(rendered).not.toContain('messageId')
    expect(rendered).not.toContain('{')
    // The assistant bubble stayed empty rather than showing a non-sentence.
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('')
  })

  it('startNewConversation drops the dead credential, the transcript, and rotates the session', async () => {
    useChatStore.setState({
      sessionSecret: 'dead',
      error: CHAT_SESSION_EXPIRED_PTBR,
      errorCanRestart: true,
      messages: [{ id: 'x', role: 'user', content: 'oi', timestamp: new Date() }],
    })

    openChat().startNewConversation()

    const s = useChatStore.getState()
    expect(s.messages).toEqual([])
    expect(s.sessionSecret).toBeUndefined()
    expect(s.error).toBeUndefined()
    expect(s.errorCanRestart).toBe(false)
    expect(h.resetSession).toHaveBeenCalledTimes(1)
  })
})
