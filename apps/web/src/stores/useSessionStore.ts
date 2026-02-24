import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SessionState {
  sessionId: string
  customerId?: string
  authToken?: string
  channel: 'web' | 'whatsapp'
  userType: 'guest' | 'customer' | 'staff'
  permissions: string[]

  // Actions
  initSession: () => void
  login: (customerId: string, authToken: string) => void
  setCustomer: (customerId: string, userType: 'customer' | 'staff') => void
  logout: () => void
  setChannel: (channel: 'web' | 'whatsapp') => void
  setPermissions: (permissions: string[]) => void
  isAuthenticated: () => boolean
}

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      sessionId: '',
      channel: 'web',
      userType: 'guest',
      permissions: [],

      initSession: () => {
        const { sessionId } = get()
        if (sessionId) return
        set({ sessionId: generateSessionId(), userType: 'guest', customerId: undefined })
      },

      login: (customerId, authToken) =>
        set({ customerId, authToken, userType: 'customer' }),

      setCustomer: (customerId, userType) =>
        set({ customerId, userType }),

      logout: () =>
        set({
          customerId: undefined,
          authToken: undefined,
          userType: 'guest',
          permissions: [],
        }),

      setChannel: (channel) => set({ channel }),
      setPermissions: (permissions) => set({ permissions }),

      isAuthenticated: () => {
        const { customerId } = get()
        return !!customerId
      },
    }),
    {
      name: 'session_v1',
      version: 2,
      partialize: (state) => ({
        sessionId: state.sessionId,
        customerId: state.customerId,
        authToken: state.authToken,
        channel: state.channel,
        userType: state.userType,
        permissions: state.permissions,
      }),
    }
  )
)

// Initialize session on first load
if (typeof window !== 'undefined') {
  const state = useSessionStore.getState()
  if (!state.sessionId) {
    state.initSession()
  }
}
