'use client'

import { useId, type Ref } from 'react'
import clsx from 'clsx'
import type { BaseFieldProps } from '../types/ui'
import { tw } from '../theme/tokens'

export interface CheckboxProps
  extends BaseFieldProps,
    Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'disabled' | 'required' | 'type'> {}

function Checkbox({
  ref,
  className,
  label,
  error,
  hint,
  required,
  disabled,
  id,
  ...props
}: CheckboxProps & { ref?: Ref<HTMLInputElement> }) {
  const reactId = useId()
  const fieldId = id || reactId

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <input
          ref={ref}
          id={fieldId}
          type="checkbox"
          className={clsx(
            'mt-0.5 h-4 w-4 rounded border transition-colors',
            'focus:ring-2 focus:ring-brand-500 focus:ring-offset-1',
            error
              ? 'border-accent-red text-accent-red'
              : 'border-smoke-300 text-charcoal-900',
            disabled && 'cursor-not-allowed opacity-50',
            className,
          )}
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
          {...props}
        />
        {label && (
          <label
            htmlFor={fieldId}
            className={clsx(
              'text-sm select-none',
              disabled ? tw.text.disabled : tw.text.primary,
            )}
          >
            {label}
            {required && <span className="text-accent-red ml-1">*</span>}
          </label>
        )}
      </div>
      {error && (
        <span id={`${fieldId}-error`} className="text-sm text-accent-red pl-6" role="alert">
          {error}
        </span>
      )}
      {hint && !error && (
        <span id={`${fieldId}-hint`} className="text-sm text-smoke-400 pl-6">
          {hint}
        </span>
      )}
    </div>
  )
}

export { Checkbox }
