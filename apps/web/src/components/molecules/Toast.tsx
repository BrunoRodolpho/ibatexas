import React, { useEffect } from 'react'
import clsx from 'clsx'
import { ShoppingBag } from 'lucide-react'

export interface ToastProps {
  id: string
  message: string
  type: 'success' | 'error' | 'warning' | 'info' | 'cart'
  duration?: number
  onClose: (id: string) => void
}

const typeStyles = {
  success: 'bg-green-50 border-green-300 text-green-900',
  error: 'bg-red-50 border-red-300 text-red-900',
  warning: 'bg-yellow-50 border-yellow-300 text-yellow-900',
  info: 'bg-blue-50 border-blue-300 text-blue-900',
  cart: 'bg-charcoal-900 border-transparent text-smoke-50',
}

const icons: Record<string, React.ReactNode> = {
  success: <span className="text-sm font-bold flex-shrink-0">✓</span>,
  error: <span className="text-sm font-bold flex-shrink-0">✕</span>,
  warning: <span className="text-sm font-bold flex-shrink-0">⚠</span>,
  info: <span className="text-sm font-bold flex-shrink-0">ℹ</span>,
  cart: <ShoppingBag className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} />,
}

const DEFAULT_DURATIONS: Record<string, number> = {
  cart: 3000,
}

export const Toast: React.FC<ToastProps> = ({ id, message, type, duration, onClose }) => {
  const effectiveDuration = duration ?? DEFAULT_DURATIONS[type] ?? 5000
  const isCart = type === 'cart'

  useEffect(() => {
    if (effectiveDuration === 0) return

    const timer = setTimeout(() => {
      onClose(id)
    }, effectiveDuration)

    return () => clearTimeout(timer)
  }, [id, effectiveDuration, onClose])

  return (
    <div
      className={clsx(
        'fixed right-4 sm:right-6 rounded-lg border flex items-center gap-2 shadow-md animate-fade-up',
        isCart
          ? 'bottom-[8rem] sm:bottom-6 max-w-[280px] px-3 py-2'
          : 'bottom-6 max-w-sm px-4 py-3',
        typeStyles[type]
      )}
      role="alert"
    >
      {icons[type]}
      <p className={clsx('flex-1', isCart ? 'text-xs' : 'text-sm')}>{message}</p>
      <button
        onClick={() => onClose(id)}
        className={clsx(
          'leading-none flex-shrink-0 hover:opacity-70',
          isCart ? 'text-sm text-smoke-400' : 'text-lg'
        )}
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
