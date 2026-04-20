'use client'

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

/* ── Overlay stack ────────────────────────────────────────────────────
 * Module-level stack so only the topmost overlay handles Escape / focus-trap.
 * Each overlay pushes its ref when open, pops when closed.
 * ──────────────────────────────────────────────────────────────────── */

const overlayStack: RefObject<HTMLElement | null>[] = []

function isTopmost(ref: RefObject<HTMLElement | null>): boolean {
  return overlayStack.length > 0 && overlayStack[overlayStack.length - 1] === ref
}

/* ── useFocusReturn ───────────────────────────────────────────────── */

/**
 * Stores the element that had focus when the overlay opened and
 * restores focus to it when the overlay closes.
 */
export function useFocusReturn(isOpen: boolean) {
  const previouslyFocused = useRef<Element | null>(null)

  useEffect(() => {
    if (isOpen) {
      previouslyFocused.current = document.activeElement
    } else if (previouslyFocused.current) {
      const el = previouslyFocused.current as HTMLElement
      if (typeof el.focus === 'function') el.focus()
      previouslyFocused.current = null
    }
  }, [isOpen])
}

/* ── useEscapeAndFocusTrap ────────────────────────────────────────── */

/**
 * Handles Escape key to close and Tab key focus-trapping within a container.
 * Stack-aware: only the topmost overlay reacts.
 */
export function useEscapeAndFocusTrap(
  isOpen: boolean,
  onClose: () => void,
  containerRef: RefObject<HTMLElement | null>,
) {
  /* Push / pop the overlay stack */
  useEffect(() => {
    if (!isOpen) return
    overlayStack.push(containerRef)
    return () => {
      const idx = overlayStack.indexOf(containerRef)
      if (idx !== -1) overlayStack.splice(idx, 1)
    }
  }, [isOpen, containerRef])

  /* Keyboard handler — only active when topmost */
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (!isTopmost(containerRef)) return

      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !containerRef.current) return

      const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose, containerRef])
}

/* ── useScrollLock ────────────────────────────────────────────────── */

/**
 * Locks body scroll while the overlay is open.
 */
export function useScrollLock(isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isOpen])
}
