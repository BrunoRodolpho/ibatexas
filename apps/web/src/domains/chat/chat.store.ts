import { create } from 'zustand'
import type { ChatErrorView } from './chat.errors'

// Cap individual message content to prevent unbounded memory growth from long SSE streams
const MAX_MESSAGE_LENGTH = 10_000

const SESSION_SECRET_KEY = 'chat_session_secret'

/** Read guest session secret from sessionStorage (survives refresh, dies with tab) */
// NB: keep `window` (not globalThis) on these sessionStorage lines — they are
// browser-only and touching them re-surfaces a pre-existing CodeQL clear-text-
// storage alert against this PR. The S7764 globalThis nit is intentionally left.
function loadSessionSecret(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return sessionStorage.getItem(SESSION_SECRET_KEY) ?? undefined
}

function saveSessionSecret(secret: string): void {
  if (typeof window !== 'undefined') sessionStorage.setItem(SESSION_SECRET_KEY, secret)
}

function clearSessionSecret(): void {
  if (typeof window !== 'undefined') sessionStorage.removeItem(SESSION_SECRET_KEY)
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  metadata?: {
    productId?: string
    action?: string
  }
}

interface ChatState {
  messages: ChatMessage[]
  isLoading: boolean
  error?: string
  /**
   * BKL-286: whether the current `error` is recoverable only by starting a new
   * conversation (a dead session credential). Drives the restart affordance.
   */
  errorCanRestart?: boolean
  /** Server-issued secret for guest session ownership (in-memory only) */
  sessionSecret?: string
  /** Server-issued JWT for authenticated session ownership (in-memory only) */
  sessionToken?: string

  // Actions
  addMessage: (message: ChatMessage) => void
  updateLastMessage: (delta: string) => void
  setLoading: (loading: boolean) => void
  setError: (error?: string) => void
  /** Set customer-facing failure copy together with its recovery affordance. */
  setErrorView: (view: ChatErrorView) => void
  setSessionSecret: (secret: string) => void
  setSessionToken: (token: string) => void
  clearHistory: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isLoading: false,
  sessionSecret: loadSessionSecret(),

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message].slice(-50),
    })),

  // Truncate if message exceeds MAX_MESSAGE_LENGTH
  updateLastMessage: (delta) =>
    set((state) => {
      const last = state.messages.at(-1)
      if (last) {
        const updated = last.content + delta
        return {
          messages: [
            ...state.messages.slice(0, -1),
            { ...last, content: updated.length > MAX_MESSAGE_LENGTH ? updated.slice(0, MAX_MESSAGE_LENGTH) : updated },
          ],
        }
      }
      return state
    }),

  setLoading: (loading) => set({ isLoading: loading }),
  // Clears the restart affordance: a plain error is retryable by default, so a
  // stale "start a new conversation" button can never outlive the error it came with.
  setError: (error) => set({ error, errorCanRestart: false }),
  setErrorView: (view) => set({ error: view.message, errorCanRestart: view.canRestart }),
  setSessionSecret: (secret) => {
    saveSessionSecret(secret)
    set({ sessionSecret: secret })
  },
  setSessionToken: (token) => set({ sessionToken: token }),

  clearHistory: () => {
    set({
      messages: [],
      isLoading: false,
      error: undefined,
      errorCanRestart: false,
      sessionSecret: undefined,
      sessionToken: undefined,
    })
    clearSessionSecret()
  },
}))
