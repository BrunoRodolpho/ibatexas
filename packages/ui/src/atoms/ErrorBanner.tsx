'use client'

import { X } from 'lucide-react'

export interface ErrorBannerProps {
  readonly message: string
  readonly onDismiss?: () => void
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div className="flex items-center justify-between rounded-sm border border-accent-red/20 bg-accent-red/10 p-4 text-sm text-accent-red">
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-3 flex-shrink-0 p-0.5 rounded-sm hover:bg-accent-red/10 transition-colors"
          aria-label="Fechar"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
