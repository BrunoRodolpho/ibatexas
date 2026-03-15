import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getApiBase } from '@/lib/api'

interface SessionState {
  sessionId: string
  customerId?: string
  channel: 'web' | 'whatsapp'
  userType: 'guest' | 'customer' | 'staff'
  permissions: string[]

  // Actions
  initSession: () => void
  /** Sync Zustand state after API login. Token is in httpOnly cookie — never passed to JS. */
  login: (customerId: string) => void
  setCustomer: (customerId: string, userType: 'customer' | 'staff') => void
  logout: () => Promise<void>
  hydrate: () => Promise<void>
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
  return '10000000-1000-4000-8000-100000000000'.replaceAll(/[018]/g, (c) =>
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

      login: (customerId) => {
        // Token is handled via httpOnly cookie set by the API.
        // Just sync Zustand state with the authenticated customer.
        set({ customerId, userType: 'customer' })
      },

      setCustomer: (customerId, userType) =>
        set({ customerId, userType }),

      logout: async () => {
        try {
          await fetch(`${getApiBase()}/api/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          })
        } catch {
          // Swallow — clear local state regardless
        }
        set({
          customerId: undefined,
          userType: 'guest',
          permissions: [],
        })
      },

      hydrate: async () => {
        // Skip network call for guests — no cookie will exist
        if (!get().customerId) return
        try {
          const res = await fetch(`${getApiBase()}/api/auth/me`, {
            credentials: 'include',
          })
          if (!res.ok) {
            // Cookie expired or invalid — clear auth state
            set({ customerId: undefined, userType: 'guest' })
            return
          }
          const data = await res.json() as { id: string; userType?: 'customer' | 'staff' }
          set({
            customerId: data.id,
            userType: data.userType ?? 'customer',
          })
        } catch {
          // Network error — leave state unchanged
        }
      },

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
        channel: state.channel,
        userType: state.userType,
        // permissions intentionally excluded — always hydrated from server
        // to prevent client-side spoofing via localStorage tampering.
      }),
    }
  )
)

// Initialize session on first load and hydrate auth state from server cookie
if (typeof window !== 'undefined') {
  const state = useSessionStore.getState()
  if (!state.sessionId) {
    state.initSession()
  }
  // Hydrate from API to sync cookie-based auth with Zustand
  void state.hydrate()
}
