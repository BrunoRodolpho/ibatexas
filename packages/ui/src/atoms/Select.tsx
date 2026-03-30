'use client'

import { useId, type Ref } from 'react'
import clsx from 'clsx'
import type { BaseFieldProps } from '../types/ui'
import { fieldVariants } from '../theme/cva'
import { Label } from './Label'

export interface SelectOption {
  value: string | number
  label: string
  disabled?: boolean
}

export interface SelectProps
  extends BaseFieldProps,
    Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'className' | 'disabled' | 'required' | 'size'> {
  readonly options: SelectOption[]
  readonly placeholder?: string
  readonly size?: 'sm' | 'md' | 'lg'
  readonly variant?: 'default' | 'minimal'
}

/** Custom chevron as inline SVG data URI */
const chevronBg =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' viewBox='0 0 24 24'%3E%3Cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")"

function Select({
  ref,
  className,
  label,
  error,
  hint,
  required,
  disabled,
  id,
  options,
  placeholder,
  size,
  variant = 'default',
  ...props
}: SelectProps & { ref?: Ref<HTMLSelectElement> }) {
  const reactId = useId()
  const fieldId = id || reactId
  const state = disabled ? 'disabled' : error ? 'error' : 'default'

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <Label htmlFor={fieldId} required={required} error={!!error}>
          {label}
        </Label>
      )}
      <select
        ref={ref}
        id={fieldId}
        className={clsx(
          fieldVariants({ size, state }),
          'appearance-none bg-no-repeat pr-8',
          variant === 'minimal' && 'border-0 border-b rounded-none px-0 focus:ring-0',
          className,
        )}
        style={{
          backgroundImage: chevronBg,
          backgroundPosition: 'right 0.5rem center',
          backgroundSize: '1rem',
        }}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...props}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <span id={`${fieldId}-error`} className="text-sm text-accent-red" role="alert">
          {error}
        </span>
      )}
      {hint && !error && (
        <span id={`${fieldId}-hint`} className="text-sm text-smoke-400">
          {hint}
        </span>
      )}
    </div>
  )
}

export { Select }
