'use client'

import { forwardRef, useId } from 'react'
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
    const reactId = useId()
    const fieldId = id || reactId
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
            'rounded-xl border px-4 py-2.5 text-base transition-all duration-250',
            'focus:outline-none focus:ring-2 focus:ring-offset-1',
            error
              ? 'border-red-500 focus:ring-red-500 focus:border-red-500'
              : 'border-slate-200 focus:ring-brand-500 focus:border-brand-500',
            'disabled:bg-slate-50 disabled:cursor-not-allowed placeholder:text-slate-400',
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
