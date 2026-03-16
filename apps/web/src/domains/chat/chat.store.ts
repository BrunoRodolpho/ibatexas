import { create } from 'zustand'

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

  updateLastMessage: (delta) =>
    set((state) => {
      const last = state.messages.at(-1)
      if (last) {
        return {
          messages: [
            ...state.messages.slice(0, -1),
            { ...last, content: last.content + delta },
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
