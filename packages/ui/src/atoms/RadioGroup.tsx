'use client'

import { useId } from 'react'
import clsx from 'clsx'
import type { BaseFieldProps } from '../types/ui'
import { tw } from '../theme/tokens'

export interface RadioOption {
  value: string | number
  label: string
  description?: string
  disabled?: boolean
}

export interface RadioGroupProps extends Omit<BaseFieldProps, 'id'> {
  readonly id?: string
  readonly name: string
  readonly options: RadioOption[]
  readonly value?: string | number
  readonly onChange?: (value: string | number) => void
  readonly layout?: 'vertical' | 'horizontal'
}

function RadioGroup({
  id,
  name,
  label,
  error,
  hint,
  required,
  disabled,
  options,
  value,
  onChange,
  layout = 'vertical',
  className,
}: RadioGroupProps) {
  const reactId = useId()
  const groupId = id || reactId

  return (
    <fieldset
      className={clsx('flex flex-col gap-2', className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${groupId}-error` : hint ? `${groupId}-hint` : undefined}
    >
      {label && (
        <legend
          className={clsx(
            'text-sm font-medium mb-1',
            error ? 'text-accent-red' : tw.text.primary,
          )}
        >
          {label}
          {required && <span className="text-accent-red ml-1">*</span>}
        </legend>
      )}
      <div
        className={clsx(
          'flex gap-3',
          layout === 'vertical' ? 'flex-col' : 'flex-row flex-wrap',
        )}
        role="radiogroup"
        aria-labelledby={label ? undefined : undefined}
      >
        {options.map((opt) => {
          const optId = `${groupId}-${opt.value}`
          const isDisabled = disabled || opt.disabled
          return (
            <div key={opt.value} className="flex items-start gap-2">
              <input
                id={optId}
                type="radio"
                name={name}
                value={opt.value}
                checked={value === opt.value}
                onChange={() => onChange?.(opt.value)}
                disabled={isDisabled}
                className={clsx(
                  'h-4 w-4 mt-0.5 border transition-colors',
                  'focus:ring-2 focus:ring-brand-500 focus:ring-offset-1',
                  error
                    ? 'border-accent-red text-accent-red'
                    : 'border-smoke-300 text-charcoal-900',
                  isDisabled && 'cursor-not-allowed opacity-50',
                )}
              />
              <label
                htmlFor={optId}
                className={clsx(
                  'text-sm select-none',
                  isDisabled ? tw.text.disabled : tw.text.primary,
                )}
              >
                <span className="font-medium">{opt.label}</span>
                {opt.description && (
                  <span className={clsx('block text-xs', tw.text.muted)}>{opt.description}</span>
                )}
              </label>
            </div>
          )
        })}
      </div>
      {error && (
        <span id={`${groupId}-error`} className="text-sm text-accent-red" role="alert">
          {error}
        </span>
      )}
      {hint && !error && (
        <span id={`${groupId}-hint`} className="text-sm text-smoke-400">
          {hint}
        </span>
      )}
    </fieldset>
  )
}

export { RadioGroup }
