'use client'

import { forwardRef } from 'react'
import clsx from 'clsx'
import { Label } from './Label'

interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  helperText?: string
  required?: boolean
}

const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  ({ className, label, error, helperText, required, id, ...props }, ref) => {
    const fieldId = id || `field-${Math.random()}`
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <Label htmlFor={fieldId} required={required}>
            {label}
          </Label>
        )}
        <input
          ref={ref}
          id={fieldId}
          className={clsx(
            'rounded-lg border px-3 py-2 text-base transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-offset-2',
            error ? 'border-red-500 focus:ring-red-500' : 'border-slate-300 focus:ring-amber-600',
            'disabled:bg-slate-100 disabled:cursor-not-allowed',
            className
          )}
          required={required}
          {...props}
        />
        {error && <span className="text-sm text-red-600">{error}</span>}
        {helperText && !error && <span className="text-sm text-slate-500">{helperText}</span>}
      </div>
    )
  }
)
TextField.displayName = 'TextField'

export { TextField }
