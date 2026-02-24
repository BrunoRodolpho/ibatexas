import React from 'react'
import clsx from 'clsx'

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: boolean
  errorMessage?: string
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, error, errorMessage, id, ...props }, ref) => {
    const checkboxId = id || `checkbox-${Math.random()}`

    return (
      <div className="space-y-1">
        <div className="flex items-start gap-3">
          <input
            ref={ref}
            id={checkboxId}
            type="checkbox"
            className={clsx(
              'w-5 h-5 rounded border-2 cursor-pointer transition-colors mt-1',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-amber-600',
              error
                ? 'border-red-600 bg-red-50 accent-red-600'
                : 'border-slate-300 bg-white accent-amber-700',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              className
            )}
            {...props}
          />
          {label && (
            <label
              htmlFor={checkboxId}
              className={clsx(
                'text-sm cursor-pointer select-none',
                error ? 'text-red-600' : 'text-slate-700'
              )}
            >
              {label}
            </label>
          )}
        </div>
        {errorMessage && error && (
          <p className="text-xs text-red-600">{errorMessage}</p>
        )}
      </div>
    )
  }
)

Checkbox.displayName = 'Checkbox'
