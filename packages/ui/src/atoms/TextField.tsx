'use client'

import { useId, type Ref } from 'react'
import clsx from 'clsx'
import type { BaseFieldProps } from '../types/ui'
import { fieldVariants } from '../theme/cva'
import { Label } from './Label'

export interface TextFieldProps
  extends BaseFieldProps,
    Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'disabled' | 'required' | 'size'> {
  readonly helperText?: string
  readonly size?: 'sm' | 'md' | 'lg'
}

function TextField({
  ref,
  className,
  label,
  error,
  hint,
  helperText,
  required,
  disabled,
  id,
  size,
  ...props
}: TextFieldProps & { ref?: Ref<HTMLInputElement> }) {
  const reactId = useId()
  const fieldId = id || reactId
  const resolvedHint = helperText ?? hint
  const state = disabled ? 'disabled' : error ? 'error' : 'default'

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <Label htmlFor={fieldId} required={required} error={!!error}>
          {label}
        </Label>
      )}
      <input
        ref={ref}
        id={fieldId}
        className={clsx(
          fieldVariants({ size, state }),
          /* luxury border-bottom aesthetic override */
          'rounded-none border-0 border-b px-0 py-2.5',
          'focus:ring-0 focus:border-charcoal-900',
          'disabled:bg-transparent',
          className,
        )}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : resolvedHint ? `${fieldId}-hint` : undefined}
        {...props}
      />
      {error && (
        <span id={`${fieldId}-error`} className="text-sm text-accent-red" role="alert">
          {error}
        </span>
      )}
      {resolvedHint && !error && (
        <span id={`${fieldId}-hint`} className="text-sm text-smoke-400">
          {resolvedHint}
        </span>
      )}
    </div>
  )
}

export { TextField }
