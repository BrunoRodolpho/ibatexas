'use client'

import { useEffect, useRef } from 'react'

interface SheetProps {
  readonly isOpen: boolean
  readonly title: string
  readonly children: React.ReactNode
  readonly onClose: () => void
  readonly footer?: React.ReactNode
  readonly position?: 'left' | 'right' | 'bottom'
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

export function Sheet({
  isOpen,
  title,
  children,
  onClose,
  footer,
  position = 'right',
}: SheetProps) {
  const sheetRef = useRef<HTMLDialogElement>(null)

  // Escape + focus trap (document-level to avoid inline handlers on <dialog>)
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !sheetRef.current) return
      const focusable = sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else if (document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isOpen])

  if (!isOpen) return null

  let positionClasses: string
  if (position === 'bottom') {
    positionClasses = 'bottom-0 left-0 right-0 max-h-[85vh] rounded-t-lg animate-slide-in-bottom'
  } else {
    const side = position === 'right' ? 'right-0 animate-slide-in-right' : 'left-0 animate-slide-in-left'
    positionClasses = `top-0 bottom-0 w-[90vw] max-w-sm ${side}`
  }

  return (
    <>
      {/* Backdrop — closes sheet on click */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- backdrop is non-interactive; keyboard close handled via Escape listener */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Dialog panel */}
      <dialog
        ref={sheetRef}
        open
        className={`fixed z-50 bg-smoke-50 shadow-xl overflow-y-auto p-0 border-none ${positionClasses}`}
        aria-labelledby="sheet-title"
      >
        <div className="sticky top-0 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-4 py-4 flex items-center justify-between">
          <h2 id="sheet-title" className="text-base font-semibold text-charcoal-900">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-400 hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
            aria-label="Fechar"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-4">{children}</div>
        {footer && (
          <div className="border-t border-smoke-200 px-4 py-4 bg-smoke-100">
            {footer}
          </div>
        )}
      </dialog>
    </>
  )
}
