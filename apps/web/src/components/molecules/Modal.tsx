import React, { useEffect, useRef, useCallback } from 'react'
import clsx from 'clsx'

export interface ModalProps {
  isOpen: boolean
  title: string
  children: React.ReactNode
  onClose: () => void
  closeButton?: boolean
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  title,
  children,
  onClose,
  closeButton = true,
  footer,
  size = 'md',
}) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
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

  // Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !overlayRef.current) return
    const focusable = overlayRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus() }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }, [])

  if (!isOpen) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 overflow-y-auto bg-black bg-opacity-50 flex items-center justify-center"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className={clsx(
          'bg-white rounded-xl shadow-xl max-h-screen overflow-y-auto w-full mx-4',
          sizeClasses[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <h2 id="modal-title" className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {closeButton && (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors"
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
          <div className="border-t border-slate-100 px-6 py-4 bg-slate-50 rounded-b-xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export interface SheetProps {
  isOpen: boolean
  title: string
  children: React.ReactNode
  onClose: () => void
  closeButton?: boolean
  footer?: React.ReactNode
  position?: 'left' | 'right'
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
  // Escape key handler
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
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
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black bg-opacity-50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheet-title"
    >
      <div
        className={clsx(
          'fixed top-0 bottom-0 w-[90vw] max-w-sm bg-white shadow-xl overflow-y-auto',
          position === 'right' ? 'right-0' : 'left-0'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-slate-100 px-4 py-4 flex items-center justify-between">
          <h2 id="sheet-title" className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {closeButton && (
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors"
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
          <div className="border-t border-slate-100 px-4 py-4 bg-slate-50">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
