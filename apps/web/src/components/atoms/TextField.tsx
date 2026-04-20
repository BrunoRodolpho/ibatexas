'use client'

import { useId, type Ref } from 'react'
import clsx from 'clsx'
import { Label } from './Label'

interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  readonly label?: string
  readonly error?: string
  readonly helperText?: string
  readonly required?: boolean
}

function TextField({ ref, className, label, error, helperText, required, id, ...props }: TextFieldProps & { ref?: Ref<HTMLInputElement> }) {
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
          'disabled:bg-transparent disabled:cursor-not-allowed placeholder:text-[var(--color-text-disabled)]',
          className
        )}
        required={required}
        {...props}
      />
      {error && <span className="text-sm text-accent-red">{error}</span>}
      {helperText && !error && <span className="text-sm text-[var(--color-text-secondary)]">{helperText}</span>}
    </div>
  )
}

export { TextField }
