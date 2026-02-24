import React from 'react'
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
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black bg-opacity-50 flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        className={clsx(
          'bg-white rounded-lg shadow-xl max-h-screen overflow-y-auto w-full mx-4',
          sizeClasses[size]
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <h2 id="modal-title" className="text-xl font-bold text-slate-900">
            {title}
          </h2>
          {closeButton && (
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-700"
              aria-label="Fechar"
            >
              ×
            </button>
          )}
        </div>

        <div className="px-6 py-4">{children}</div>

        {footer && (
          <div className="border-t border-slate-200 px-6 py-4 bg-slate-50 rounded-b-lg">
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
          'fixed top-0 bottom-0 w-[90vw] max-w-sm bg-white shadow-2xl overflow-y-auto transition-transform',
          position === 'right' ? 'right-0' : 'left-0'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 px-4 py-4 flex items-center justify-between">
          <h2 id="sheet-title" className="text-lg font-bold text-slate-900">
            {title}
          </h2>
          {closeButton && (
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-700"
              aria-label="Fechar"
            >
              ×
            </button>
          )}
        </div>

        <div className="px-4 py-4">{children}</div>

        {footer && (
          <div className="border-t border-slate-200 px-4 py-4 bg-slate-50">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
