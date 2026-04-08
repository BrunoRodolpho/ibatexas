import React, { useRef } from 'react'
import clsx from 'clsx'
import { useTranslations } from 'next-intl'
import { useEscapeAndFocusTrap, useScrollLock } from '@ibatexas/ui'

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

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  title,
  children,
  onClose,
  closeButton = true,
  footer,
  size = 'md',
}) => {
  const t = useTranslations('common')
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEscapeAndFocusTrap(isOpen, onClose, dialogRef)
  useScrollLock(isOpen)

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
                className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-secondary)] hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                aria-label={t('close')}
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
  const t = useTranslations('common')
  const sheetRef = useRef<HTMLDialogElement>(null)

  useEscapeAndFocusTrap(isOpen, onClose, sheetRef)
  useScrollLock(isOpen)

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      {/*
        Sheet panel.
        The <dialog> element has user-agent styles that don't reliably honor
        className-applied flex layout (Safari especially). So the dialog is
        kept as a thin positional wrapper, and the flex column lives on an
        inner <div className="h-full flex flex-col"> — this gives us a normal
        flex container the browser DOES respect, with `min-h-0` on the body so
        the items track scrolls within bounds and the footer stays pinned.
      */}
      <dialog
        ref={sheetRef}
        open
        className={clsx(
          'fixed z-50 bg-smoke-50 shadow-xl p-0 border-none',
          position === 'bottom'
            ? 'bottom-0 left-0 right-0 max-h-[85vh] rounded-t-lg animate-slide-in-bottom'
            : 'top-0 bottom-0 w-[90vw] max-w-sm h-full',
          position === 'right' && 'right-0 animate-slide-in-right',
          position === 'left' && 'left-0 animate-slide-in-left',
        )}
        aria-labelledby="sheet-title"
      >
        <div className="h-full flex flex-col">
          <div className="flex-shrink-0 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-4 py-4 flex items-center justify-between">
            <h2 id="sheet-title" className="text-base font-semibold text-charcoal-900">
              {title}
            </h2>
            {closeButton && (
              <button
                onClick={onClose}
                className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-secondary)] hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                aria-label={t('close')}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">{children}</div>

          {footer && (
            <div className="flex-shrink-0 border-t border-smoke-200 px-4 py-4 bg-smoke-100 shadow-[0_-12px_28px_-16px_rgba(0,0,0,0.18)]">
              {footer}
            </div>
          )}
        </div>
      </dialog>
    </>
  )
}
