'use client'

import React, { useId, useRef } from 'react'
import clsx from 'clsx'
import type { BaseOverlayProps } from '../types/ui'
import { overlaySizeVariants } from '../theme/cva'
import {
  useEscapeAndFocusTrap,
  useFocusReturn,
  useScrollLock,
} from '../hooks/use-overlay'

/* ── Shared close-button icon ─────────────────────────────────────── */

function CloseIcon(): React.JSX.Element {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

/* ══════════════════════════════════════════════════════════════════════
 * Modal
 * ══════════════════════════════════════════════════════════════════════ */

type OverlaySize = 'sm' | 'md' | 'lg' | 'xl' | 'full'

export interface ModalProps extends BaseOverlayProps {
  readonly closeButton?: boolean
  readonly footer?: React.ReactNode
  readonly size?: OverlaySize
}

export function Modal({
  isOpen,
  title,
  children,
  onClose,
  closeButton = true,
  footer,
  size = 'md',
}: ModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEscapeAndFocusTrap(isOpen, onClose, dialogRef)
  useFocusReturn(isOpen)
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
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 overflow-y-auto flex items-center justify-center w-full h-full m-0 max-w-none max-h-none p-0 border-none bg-transparent pointer-events-none"
        aria-labelledby={titleId}
      >
        <div
          className={clsx(
            'bg-smoke-50 rounded-sm shadow-xl max-h-screen overflow-y-auto w-full mx-4 pointer-events-auto',
            overlaySizeVariants({ size }),
          )}
        >
          {/* Header */}
          <div className="sticky top-0 bg-smoke-50 border-b border-smoke-200 px-6 py-4 flex items-center justify-between rounded-t-sm">
            <h2
              id={titleId}
              className="text-base font-semibold text-charcoal-900"
            >
              {title}
            </h2>
            {closeButton && (
              <button
                onClick={onClose}
                className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-400 hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
                style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                aria-label="Fechar"
              >
                <CloseIcon />
              </button>
            )}
          </div>

          {/* Content */}
          <div className="px-6 py-4">{children}</div>

          {/* Footer */}
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

/* ══════════════════════════════════════════════════════════════════════
 * Sheet
 * ══════════════════════════════════════════════════════════════════════ */

type SheetPosition = 'left' | 'right' | 'bottom'

export interface SheetProps extends BaseOverlayProps {
  readonly closeButton?: boolean
  readonly footer?: React.ReactNode
  readonly position?: SheetPosition
}

export function Sheet({
  isOpen,
  title,
  children,
  onClose,
  closeButton = true,
  footer,
  position = 'right',
}: SheetProps): React.JSX.Element | null {
  const sheetRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEscapeAndFocusTrap(isOpen, onClose, sheetRef)
  useFocusReturn(isOpen)
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
      {/* Sheet panel */}
      <dialog
        ref={sheetRef}
        open
        role="dialog"
        aria-modal="true"
        className={clsx(
          'fixed z-50 bg-smoke-50 shadow-xl overflow-y-auto p-0 border-none',
          position === 'bottom'
            ? 'bottom-0 left-0 right-0 max-h-[85vh] rounded-t-lg animate-slide-in-bottom'
            : 'top-0 bottom-0 w-[90vw] max-w-sm',
          position === 'right' && 'right-0 animate-slide-in-right',
          position === 'left' && 'left-0 animate-slide-in-left',
        )}
        aria-labelledby={titleId}
      >
        {/* Header */}
        <div className="sticky top-0 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-4 py-4 flex items-center justify-between">
          <h2
            id={titleId}
            className="text-base font-semibold text-charcoal-900"
          >
            {title}
          </h2>
          {closeButton && (
            <button
              onClick={onClose}
              className="rounded-sm min-w-[44px] min-h-[44px] flex items-center justify-center text-smoke-400 hover:text-charcoal-700 hover:bg-smoke-100 transition-all duration-500"
              style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
              aria-label="Fechar"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="px-4 py-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="border-t border-smoke-200 px-4 py-4 bg-smoke-100">
            {footer}
          </div>
        )}
      </dialog>
    </>
  )
}
