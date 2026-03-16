import React, { useEffect, useRef } from 'react'
import clsx from 'clsx'

export interface ModalProps {
  readonly isOpen: boolean
  readonly title: string
  readonly children: React.ReactNode
  readonly onClose: () => void
  readonly closeButton?: boolean
  readonly footer?: React.ReactNode
  readonly size?: 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  title,
  children,
  onClose,
  closeButton = true,
  footer,
  size = 'md',
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Escape + focus trap (document-level to avoid inline handlers on <dialog>)
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  // Scroll lock
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black bg-opacity-50"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Dialog */}
      <dialog
        ref={dialogRef}
        open
        className="fixed inset-0 z-50 overflow-y-auto flex items-center justify-center w-full h-full m-0 max-w-none max-h-none p-0 border-none bg-transparent pointer-events-none"
        aria-labelledby="modal-title"
      >
        <div
          className={clsx(
            'bg-smoke-50 rounded-sm shadow-xl max-h-screen overflow-y-auto w-full mx-4 pointer-events-auto',
            sizeClasses[size]
          )}
        >
          <div className="sticky top-0 bg-smoke-50 border-b border-smoke-200 px-6 py-4 flex items-center justify-between rounded-t-sm">
            <h2 id="modal-title" className="text-base font-semibold text-charcoal-900">
              {title}
            </h2>
            {closeButton && (
              <button
                onClick={onClose}
                className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-400 hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                aria-label="Fechar"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="px-6 py-4">{children}</div>

          {footer && (
            <div className="border-t border-smoke-200 px-6 py-4 bg-smoke-100 rounded-b-sm">
              {footer}
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}

export interface SheetProps {
  readonly isOpen: boolean
  readonly title: string
  readonly children: React.ReactNode
  readonly onClose: () => void
  readonly closeButton?: boolean
  readonly footer?: React.ReactNode
  readonly position?: 'left' | 'right' | 'bottom'
}

export const Sheet: React.FC<SheetProps> = ({
  isOpen,
  title,
  children,
  onClose,
  closeButton = true,
  footer,
  position = 'right',
}) => {
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
      } else if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  // Scroll lock
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [isOpen])

  // Auto-focus first focusable element on open
  useEffect(() => {
    if (!isOpen || !sheetRef.current) return
    const focusable = sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    if (focusable.length > 0) {
      focusable[0].focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Sheet panel */}
      <dialog
        ref={sheetRef}
        open
        className={clsx(
          'fixed z-50 bg-smoke-50 shadow-xl overflow-y-auto p-0 border-none',
          position === 'bottom'
            ? 'bottom-0 left-0 right-0 max-h-[85vh] rounded-t-lg animate-slide-in-bottom'
            : 'top-0 bottom-0 w-[90vw] max-w-sm',
          position === 'right' && 'right-0 animate-slide-in-right',
          position === 'left' && 'left-0 animate-slide-in-left',
        )}
        aria-labelledby="sheet-title"
      >
        <div className="sticky top-0 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-4 py-4 flex items-center justify-between">
          <h2 id="sheet-title" className="text-base font-semibold text-charcoal-900">
            {title}
          </h2>
          {closeButton && (
            <button
              onClick={onClose}
              className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-400 hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
              style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
              aria-label="Fechar"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
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
