import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ConsentState {
  hasConsented: boolean
  accepted: boolean
}

interface ConsentActions {
  accept: () => void
  reject: () => void
  reset: () => void
}

export const useConsentStore = create<ConsentState & ConsentActions>()(
  persist(
    (set) => ({
      hasConsented: false,
      accepted: false,

      accept: () => set({ hasConsented: true, accepted: true }),
      reject: () => set({ hasConsented: true, accepted: false }),
      reset: () => set({ hasConsented: false, accepted: false }),
    }),
    {
      name: 'ibx-consent',
    }
  )
)
