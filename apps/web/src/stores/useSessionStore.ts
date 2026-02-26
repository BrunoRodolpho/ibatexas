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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function generateSessionId(): string {
  // crypto.randomUUID() is not available on iOS Safari < 15.4
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback: build a v4 UUID from crypto.getRandomValues
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
  )
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
        // Migrate legacy non-UUID session IDs
        if (sessionId && !UUID_RE.test(sessionId)) {
          set({ sessionId: generateSessionId() })
          return
        }
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
