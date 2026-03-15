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
            'border-0 border-b border-smoke-200 px-0 py-2.5 text-base transition-all duration-500',
            'focus:outline-none focus:border-charcoal-900',
            error
              ? 'border-red-500 focus:border-red-500'
              : 'border-smoke-200 focus:border-charcoal-900',
            'disabled:bg-transparent disabled:cursor-not-allowed placeholder:text-smoke-300',
            className
          )}
          required={required}
          {...props}
        />
        {error && <span className="text-sm text-accent-red">{error}</span>}
        {helperText && !error && <span className="text-sm text-smoke-400">{helperText}</span>}
      </div>
    )
  }
)
TextField.displayName = 'TextField'

export { TextField }
