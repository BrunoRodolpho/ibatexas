/**
 * Chat store tests — pure logic only, no DOM.
 *
 * Tests zustand store actions via getState()/setState().
 * The chat store does NOT use persist middleware, so no storage mocking needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useChatStore, type ChatMessage } from '../chat.store'

// ── Fixtures ────────────────────────────────────────────────────────────

function createMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg_1',
    role: 'user',
    content: 'Quero uma costela defumada',
    timestamp: new Date('2026-03-16T12:00:00Z'),
    ...overrides,
  }
}

// ── Setup ───────────────────────────────────────────────────────────────

function resetStore() {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    error: undefined,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})

// ── addMessage ──────────────────────────────────────────────────────────

describe('addMessage', () => {
  it('adds a message to empty history', () => {
    const msg = createMessage()
    useChatStore.getState().addMessage(msg)

    const { messages } = useChatStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe('msg_1')
    expect(messages[0].content).toBe('Quero uma costela defumada')
  })

  it('appends messages in order', () => {
    useChatStore.getState().addMessage(createMessage({ id: 'msg_1', role: 'user' }))
    useChatStore.getState().addMessage(createMessage({ id: 'msg_2', role: 'assistant', content: 'Temos costela!' }))

    const { messages } = useChatStore.getState()
    expect(messages).toHaveLength(2)
    expect(messages[0].id).toBe('msg_1')
    expect(messages[1].id).toBe('msg_2')
    expect(messages[1].role).toBe('assistant')
  })

  it('preserves message metadata', () => {
    const msg = createMessage({
      metadata: { productId: 'prod_costela', action: 'view' },
    })
    useChatStore.getState().addMessage(msg)

    const stored = useChatStore.getState().messages[0]
    expect(stored.metadata?.productId).toBe('prod_costela')
    expect(stored.metadata?.action).toBe('view')
  })

  it('caps history at 50 messages (sliding window)', () => {
    for (let i = 0; i < 55; i++) {
      useChatStore.getState().addMessage(
        createMessage({ id: `msg_${i}`, content: `Mensagem ${i}` }),
      )
    }

    const { messages } = useChatStore.getState()
    expect(messages).toHaveLength(50)
    // Oldest 5 should have been dropped
    expect(messages[0].id).toBe('msg_5')
    expect(messages[49].id).toBe('msg_54')
  })

  it('keeps exactly 50 when adding the 51st message', () => {
    // Fill to 50
    for (let i = 0; i < 50; i++) {
      useChatStore.getState().addMessage(createMessage({ id: `msg_${i}` }))
    }
    expect(useChatStore.getState().messages).toHaveLength(50)

    // Add one more
    useChatStore.getState().addMessage(createMessage({ id: 'msg_50' }))
    const { messages } = useChatStore.getState()
    expect(messages).toHaveLength(50)
    expect(messages[0].id).toBe('msg_1') // msg_0 was dropped
    expect(messages[49].id).toBe('msg_50')
  })
})

// ── updateLastMessage ───────────────────────────────────────────────────

describe('updateLastMessage', () => {
  it('appends delta to the last message content (streaming)', () => {
    useChatStore.getState().addMessage(createMessage({ id: 'msg_1', role: 'assistant', content: 'Olá' }))
    useChatStore.getState().updateLastMessage(', como posso ajudar?')

    const last = useChatStore.getState().messages.at(-1)!
    expect(last.content).toBe('Olá, como posso ajudar?')
  })

  it('appends multiple deltas incrementally', () => {
    useChatStore.getState().addMessage(createMessage({ id: 'msg_1', role: 'assistant', content: '' }))
    useChatStore.getState().updateLastMessage('Temos ')
    useChatStore.getState().updateLastMessage('costela ')
    useChatStore.getState().updateLastMessage('defumada!')

    expect(useChatStore.getState().messages[0].content).toBe('Temos costela defumada!')
  })

  it('does nothing when there are no messages', () => {
    useChatStore.getState().updateLastMessage('delta')
    expect(useChatStore.getState().messages).toHaveLength(0)
  })

  it('only modifies the last message, not others', () => {
    useChatStore.getState().addMessage(createMessage({ id: 'msg_1', content: 'Primeira' }))
    useChatStore.getState().addMessage(createMessage({ id: 'msg_2', content: 'Segunda' }))
    useChatStore.getState().updateLastMessage(' atualizada')

    const { messages } = useChatStore.getState()
    expect(messages[0].content).toBe('Primeira')
    expect(messages[1].content).toBe('Segunda atualizada')
  })

  it('preserves other fields of the last message', () => {
    const msg = createMessage({
      id: 'msg_1',
      role: 'assistant',
      content: 'Base',
      metadata: { productId: 'prod_1' },
    })
    useChatStore.getState().addMessage(msg)
    useChatStore.getState().updateLastMessage(' extended')

    const last = useChatStore.getState().messages[0]
    expect(last.id).toBe('msg_1')
    expect(last.role).toBe('assistant')
    expect(last.metadata?.productId).toBe('prod_1')
    expect(last.content).toBe('Base extended')
  })
})

// ── setLoading ──────────────────────────────────────────────────────────

describe('setLoading', () => {
  it('sets isLoading to true', () => {
    useChatStore.getState().setLoading(true)
    expect(useChatStore.getState().isLoading).toBe(true)
  })

  it('sets isLoading to false', () => {
    useChatStore.setState({ isLoading: true })
    useChatStore.getState().setLoading(false)
    expect(useChatStore.getState().isLoading).toBe(false)
  })
})

// ── setError ────────────────────────────────────────────────────────────

describe('setError', () => {
  it('sets an error message', () => {
    useChatStore.getState().setError('Falha na conexão')
    expect(useChatStore.getState().error).toBe('Falha na conexão')
  })

  it('clears error when called with undefined', () => {
    useChatStore.setState({ error: 'Erro anterior' })
    useChatStore.getState().setError(undefined)
    expect(useChatStore.getState().error).toBeUndefined()
  })
})

// ── clearHistory ────────────────────────────────────────────────────────

describe('clearHistory', () => {
  it('removes all messages', () => {
    useChatStore.getState().addMessage(createMessage({ id: 'msg_1' }))
    useChatStore.getState().addMessage(createMessage({ id: 'msg_2' }))
    useChatStore.getState().clearHistory()

    expect(useChatStore.getState().messages).toEqual([])
  })

  it('resets isLoading to false', () => {
    useChatStore.setState({ isLoading: true })
    useChatStore.getState().clearHistory()
    expect(useChatStore.getState().isLoading).toBe(false)
  })

  it('clears error', () => {
    useChatStore.setState({ error: 'Erro anterior' })
    useChatStore.getState().clearHistory()
    expect(useChatStore.getState().error).toBeUndefined()
  })

  it('fully resets all chat state at once', () => {
    useChatStore.getState().addMessage(createMessage())
    useChatStore.setState({ isLoading: true, error: 'Erro' })

    useChatStore.getState().clearHistory()

    const state = useChatStore.getState()
    expect(state.messages).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.error).toBeUndefined()
  })

  it('is a no-op on already empty state', () => {
    useChatStore.getState().clearHistory()
    const state = useChatStore.getState()
    expect(state.messages).toEqual([])
    expect(state.isLoading).toBe(false)
    expect(state.error).toBeUndefined()
  })
})
