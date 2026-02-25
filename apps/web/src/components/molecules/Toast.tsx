import React, { useEffect } from 'react'
import clsx from 'clsx'

export interface ToastProps {
  id: string
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  duration?: number
  onClose: (id: string) => void
}

const typeStyles = {
  success: 'bg-green-50 border-green-300 text-green-900',
  error: 'bg-red-50 border-red-300 text-red-900',
  warning: 'bg-yellow-50 border-yellow-300 text-yellow-900',
  info: 'bg-blue-50 border-blue-300 text-blue-900',
}

const icons = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
}

export const Toast: React.FC<ToastProps> = ({ id, message, type, duration = 5000, onClose }) => {
  useEffect(() => {
    if (duration === 0) return

    const timer = setTimeout(() => {
      onClose(id)
    }, duration)

    return () => clearTimeout(timer)
  }, [id, duration, onClose])

  return (
    <div
      className={clsx(
        'fixed bottom-6 right-6 max-w-sm px-4 py-3 rounded-xl border flex items-start gap-3 shadow-card-md animate-fade-up',
        typeStyles[type]
      )}
      role="alert"
    >
      <span className="text-lg font-bold flex-shrink-0">{icons[type]}</span>
      <p className="text-sm flex-1">{message}</p>
      <button
        onClick={() => onClose(id)}
        className="text-lg leading-none flex-shrink-0 hover:opacity-70"
        aria-label="Fechar notificação"
      >
        ×
      </button>
    </div>
  )
}

export interface ToastContainerProps {
  toasts: ToastProps[]
  onClose: (id: string) => void
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onClose }) => {
  return (
    <div className="fixed bottom-0 right-0 z-50 pointer-events-none p-6">
      <div className="flex flex-col gap-3">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <Toast {...toast} onClose={onClose} />
          </div>
        ))}
      </div>
    </div>
  )
}
