import { create } from 'zustand'

// Cap individual message content to prevent unbounded memory growth from long SSE streams
const MAX_MESSAGE_LENGTH = 10_000

const SESSION_SECRET_KEY = 'chat_session_secret'

/** Read guest session secret from sessionStorage (survives refresh, dies with tab) */
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
  /** Server-issued secret for guest session ownership (in-memory only) */
  sessionSecret?: string
  /** Server-issued JWT for authenticated session ownership (in-memory only) */
  sessionToken?: string

  // Actions
  addMessage: (message: ChatMessage) => void
  updateLastMessage: (delta: string) => void
  setLoading: (loading: boolean) => void
  setError: (error?: string) => void
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
  setError: (error) => set({ error }),
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
      sessionSecret: undefined,
      sessionToken: undefined,
    })
    clearSessionSecret()
  },
}))
