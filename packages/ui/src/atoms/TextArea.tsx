'use client'

import { useId, type Ref } from 'react'
import clsx from 'clsx'
import type { BaseFieldProps } from '../types/ui'
import { fieldVariants } from '../theme/cva'
import { Label } from './Label'

export interface TextAreaProps
  extends BaseFieldProps,
    Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className' | 'disabled' | 'required'> {
  readonly helperText?: string
  readonly size?: 'sm' | 'md' | 'lg'
  /** Show a character counter (requires maxLength) */
  readonly counter?: boolean
}

function TextArea({
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
  counter,
  maxLength,
  value,
  defaultValue,
  ...props
}: TextAreaProps & { ref?: Ref<HTMLTextAreaElement> }) {
  const reactId = useId()
  const fieldId = id || reactId
  const resolvedHint = helperText ?? hint
  const state = disabled ? 'disabled' : error ? 'error' : 'default'
  const charCount = typeof value === 'string' ? value.length : undefined

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <Label htmlFor={fieldId} required={required} error={!!error}>
          {label}
        </Label>
      )}
      <textarea
        ref={ref}
        id={fieldId}
        className={clsx(
          fieldVariants({ size, state }),
          /* Override height for textarea — use min-h instead of fixed h */
          'h-auto min-h-[120px] resize-y py-2.5',
          className,
        )}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        value={value}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : resolvedHint ? `${fieldId}-hint` : undefined}
        {...props}
      />
      <div className="flex items-center justify-between">
        <div>
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
        {counter && maxLength != null && (
          <span
            className={clsx(
              'text-xs tabular-nums',
              charCount != null && charCount >= maxLength ? 'text-accent-red' : 'text-smoke-400',
            )}
          >
            {charCount ?? 0}/{maxLength}
          </span>
        )}
      </div>
    </div>
  )
}

export { TextArea }
