'use client'

import { type ReactNode, useRef, useSyncExternalStore } from 'react'
import type { ToastType, ToastData } from '../types/ui'

/* ── Public API types ──────────────────────────────────────────────── */

export interface AddToastOpts {
  type: ToastType
  message: string
  title?: string
  duration?: number
  icon?: ReactNode
  dedupeKey?: string
}

export interface ToastStore {
  toasts: ToastData[]
  addToast: (opts: AddToastOpts) => string
  removeToast: (id: string) => void
  clearAll: () => void
}

/* ── Constants ─────────────────────────────────────────────────────── */

const MAX_TOASTS = 5

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  error: 0,
  warning: 8000,
  success: 5000,
  info: 5000,
  cart: 3000,
}

/* ── Module-level store (singleton) ────────────────────────────────── */

let toasts: ToastData[] = []
let counter = 0
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function getSnapshot(): ToastData[] {
  return toasts
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function addToast(opts: AddToastOpts): string {
  const { type, message, title, duration, icon, dedupeKey } = opts

  // Deduplication: if key already exists, update in place
  if (dedupeKey) {
    const existing = toasts.find((t) => t.dedupeKey === dedupeKey)
    if (existing) {
      toasts = toasts.map((t) =>
        t.dedupeKey === dedupeKey
          ? { ...t, type, message, title, duration: duration ?? DEFAULT_DURATIONS[type], icon }
          : t,
      )
      emit()
      return existing.id
    }
  }

  const id = `toast-${++counter}`
  const toast: ToastData = {
    id,
    type,
    message,
    title,
    duration: duration ?? DEFAULT_DURATIONS[type],
    icon,
    dedupeKey,
  }

  // Eviction: if at capacity, remove the oldest non-error toast
  if (toasts.length >= MAX_TOASTS) {
    const evictIndex = toasts.findIndex((t) => t.type !== 'error')
    if (evictIndex !== -1) {
      toasts = [...toasts.slice(0, evictIndex), ...toasts.slice(evictIndex + 1)]
    }
  }

  toasts = [...toasts, toast]
  emit()
  return id
}

function removeToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

function clearAll(): void {
  toasts = []
  emit()
}

/* ── React hook ────────────────────────────────────────────────────── */

/**
 * Subscribe to the global toast store.
 *
 * Returns a stable reference — the store object itself never changes,
 * only the `toasts` array inside it triggers re-renders.
 */
export function useToast(): ToastStore {
  const currentToasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Stable ref so consumers don't re-render on identity change
  const storeRef = useRef<ToastStore>({
    toasts: currentToasts,
    addToast,
    removeToast,
    clearAll,
  })

  storeRef.current.toasts = currentToasts
  return storeRef.current
}

/* ── Global error capture (opt-in) ─────────────────────────────────── */

/**
 * Installs a global `unhandledrejection` handler that surfaces promise
 * rejections as error toasts.  Call once at app bootstrap.
 *
 * Returns a cleanup function that removes the listener.
 */
export function setupGlobalErrorCapture(): () => void {
  const handler = (e: PromiseRejectionEvent) => {
    const message =
      (e.reason instanceof Error ? e.reason.message : undefined) ??
      (typeof e.reason === 'string' ? e.reason : undefined) ??
      'Erro inesperado'

    addToast({ type: 'error', message, dedupeKey: 'global-unhandled' })
  }

  window.addEventListener('unhandledrejection', handler)
  return () => window.removeEventListener('unhandledrejection', handler)
}
