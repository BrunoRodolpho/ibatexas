import React from 'react'
import clsx from 'clsx'

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean
  errorMessage?: string
  counter?: boolean
  maxLength?: number
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ className, error, errorMessage, counter, maxLength, value, ...props }, ref) => {
    const charCount = typeof value === 'string' ? value.length : 0

    return (
      <div className="space-y-1">
        <textarea
          ref={ref}
          maxLength={maxLength}
          value={value}
          className={clsx(
            'w-full px-4 py-3 rounded-lg border-2 font-sans transition-colors focus-visible:outline-none',
            error
              ? 'border-red-600 bg-red-50 focus-visible:border-red-700 focus-visible:ring-2 focus-visible:ring-red-200'
              : 'border-slate-300 bg-white focus-visible:border-amber-700 focus-visible:ring-2 focus-visible:ring-amber-200',
            'disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed',
            className
          )}
          {...props}
        />
        <div className="flex justify-between items-start">
          {errorMessage && error && (
            <p className="text-xs text-red-600">{errorMessage}</p>
          )}
          {counter && maxLength && (
            <p
              className={clsx(
                'text-xs ml-auto',
                charCount === maxLength ? 'text-red-600 font-medium' : 'text-slate-500'
              )}
            >
              {charCount}/{maxLength}
            </p>
          )}
        </div>
      </div>
    )
  }
)

TextArea.displayName = 'TextArea'
