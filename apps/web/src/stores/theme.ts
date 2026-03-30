'use client'
import { create } from 'zustand'

type Theme = 'light' | 'dark' | 'system'

interface ThemeStore {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: (typeof window !== 'undefined'
    ? (localStorage.getItem('ibx-theme') as Theme) || 'system'
    : 'system'),
  setTheme: (theme) => {
    localStorage.setItem('ibx-theme', theme)
    set({ theme })
    applyTheme(theme)
  },
}))

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}
