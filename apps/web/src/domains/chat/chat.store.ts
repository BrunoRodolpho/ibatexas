import { create } from 'zustand'

// Cap individual message content to prevent unbounded memory growth from long SSE streams
const MAX_MESSAGE_LENGTH = 10_000

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

  // Actions
  addMessage: (message: ChatMessage) => void
  updateLastMessage: (delta: string) => void
  setLoading: (loading: boolean) => void
  setError: (error?: string) => void
  clearHistory: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isLoading: false,

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

  clearHistory: () =>
    set({
      messages: [],
      isLoading: false,
      error: undefined,
    }),
}))
