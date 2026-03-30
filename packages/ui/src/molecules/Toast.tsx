'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { ToastType, ToastPosition, ToastData } from '../types/ui'
import { toastVariants } from '../theme/cva'

/* ── Duration defaults ─────────────────────────────────────────────── */

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  error: 0,
  warning: 8000,
  success: 5000,
  info: 5000,
  cart: 3000,
}

/* ── Default icons (plain text — no lucide dependency) ─────────────── */

const DEFAULT_ICONS: Record<ToastType, string> = {
  success: '\u2713',
  error: '\u2715',
  warning: '\u26A0',
  info: '\u2139',
  cart: '\uD83D\uDED2',
}

/* ── Position class map ────────────────────────────────────────────── */

const POSITION_CLASSES: Record<ToastPosition, string> = {
  'top-right': 'fixed top-6 right-4 sm:right-6 flex flex-col items-end gap-2 z-[9999]',
  'bottom-right': 'fixed bottom-6 right-4 sm:right-6 flex flex-col-reverse items-end gap-2 z-[9999]',
  'bottom-center': 'fixed bottom-6 left-1/2 -translate-x-1/2 flex flex-col-reverse items-center gap-2 z-[9999]',
}

/* ── Progress bar color map ────────────────────────────────────────── */

const PROGRESS_COLORS: Record<ToastType, string> = {
  success: 'bg-green-600',
  error: 'bg-red-600',
  warning: 'bg-yellow-600',
  info: 'bg-blue-600',
  cart: 'bg-smoke-400',
}

/* ── Toast ─────────────────────────────────────────────────────────── */

export interface ToastProps {
  readonly id: string
  readonly message: string
  readonly type: ToastType
  readonly title?: string
  readonly duration?: number
  readonly icon?: ReactNode
  readonly onClose: (id: string) => void
}

export const Toast: React.FC<ToastProps> = ({
  id,
  message,
  type,
  title,
  duration,
  icon,
  onClose,
}) => {
  const effectiveDuration = duration ?? DEFAULT_DURATIONS[type]
  const isPersistent = effectiveDuration === 0

  // Timer management for pause-on-hover
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const remainingRef = useRef(effectiveDuration)
  const startedAtRef = useRef(Date.now())

  // Progress bar state (1 → 0)
  const [progress, setProgress] = useState(1)
  const rafRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startTimer = useCallback(() => {
    if (isPersistent) return
    const remaining = remainingRef.current
    if (remaining <= 0) return

    startedAtRef.current = Date.now()

    timerRef.current = setTimeout(() => onClose(id), remaining)

    // Animate progress bar
    const totalDuration = effectiveDuration
    const initialProgress = remaining / totalDuration

    const tick = () => {
      const elapsed = Date.now() - startedAtRef.current
      const newProgress = Math.max(0, initialProgress - elapsed / totalDuration)
      setProgress(newProgress)
      if (newProgress > 0) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [id, effectiveDuration, isPersistent, onClose])

  const pauseTimer = useCallback(() => {
    if (isPersistent) return
    const elapsed = Date.now() - startedAtRef.current
    remainingRef.current = Math.max(0, remainingRef.current - elapsed)
    clearTimer()
  }, [isPersistent, clearTimer])

  const resumeTimer = useCallback(() => {
    if (isPersistent) return
    startTimer()
  }, [isPersistent, startTimer])

  // Start timer on mount
  useEffect(() => {
    startTimer()
    return clearTimer
  }, [startTimer, clearTimer])

  const liveRegion: 'assertive' | 'polite' =
    type === 'error' || type === 'warning' ? 'assertive' : 'polite'

  const isCompact = type === 'cart'
  const displayIcon = icon ?? DEFAULT_ICONS[type]

  return (
    <div
      className={clsx(toastVariants({ type, compact: isCompact }), 'relative overflow-hidden')}
      role="alert"
      aria-live={liveRegion}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
    >
      <span className="text-sm font-bold flex-shrink-0" aria-hidden="true">
        {displayIcon}
      </span>

      <div className="flex-1 min-w-0">
        {title && (
          <p className={clsx('font-semibold', isCompact ? 'text-xs' : 'text-sm')}>{title}</p>
        )}
        <p className={clsx('flex-1', isCompact ? 'text-xs' : 'text-sm')}>{message}</p>
      </div>

      <button
        onClick={() => onClose(id)}
        className="leading-none flex-shrink-0 hover:opacity-70 text-lg"
        aria-label="Fechar notificação"
      >
        &times;
      </button>

      {/* Progress bar — only shown for auto-dismissing toasts */}
      {!isPersistent && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-black/10">
          <div
            className={clsx('h-full transition-none', PROGRESS_COLORS[type])}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}

/* ── ToastContainer ────────────────────────────────────────────────── */

export interface ToastContainerProps {
  readonly toasts: ToastData[]
  readonly position?: ToastPosition
  readonly onClose: (id: string) => void
}

export const ToastContainer: React.FC<ToastContainerProps> = ({
  toasts,
  position = 'bottom-right',
  onClose,
}) => {
  if (toasts.length === 0) return null

  return (
    <div className={POSITION_CLASSES[position]}>
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          id={toast.id}
          message={toast.message}
          type={toast.type}
          title={toast.title}
          duration={toast.duration}
          icon={toast.icon}
          onClose={onClose}
        />
      ))}
    </div>
  )
}
