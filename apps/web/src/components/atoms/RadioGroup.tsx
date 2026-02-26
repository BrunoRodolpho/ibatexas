import React from 'react'
import clsx from 'clsx'

export interface RadioOption {
  value: string | number
  label: string
  description?: string
  disabled?: boolean
}

export interface RadioGroupProps {
  name: string
  options: RadioOption[]
  value?: string | number
  onChange?: (value: string | number) => void
  error?: boolean
  errorMessage?: string
  layout?: 'vertical' | 'horizontal'
}

export const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ name, options, value, onChange, error, errorMessage, layout = 'vertical' }, ref) => (
    <div ref={ref} className="space-y-2">
      <fieldset
        className={clsx(
          layout === 'horizontal' ? 'flex gap-6 flex-wrap' : 'space-y-3'
        )}
      >
        {options.map((opt) => {
          const radioId = `radio-${name}-${opt.value}`
          return (
            <div key={opt.value} className="flex items-start gap-3">
              <input
                id={radioId}
                type="radio"
                name={name}
                value={opt.value}
                checked={value === opt.value}
                onChange={(e) => onChange?.(opt.value)}
                disabled={opt.disabled}
                className={clsx(
                  'w-4 h-4 rounded-full border cursor-pointer transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] mt-0.5',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-charcoal-900',
                  error
                    ? 'border-red-600 bg-red-50 accent-red-600'
                    : 'border-smoke-300 bg-transparent accent-charcoal-900',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              />
              <label
                htmlFor={radioId}
                className={clsx(
                  'text-sm cursor-pointer select-none',
                  error ? 'text-red-600' : 'text-charcoal-700',
                  opt.disabled && 'opacity-50'
                )}
              >
                <div className="font-medium">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-smoke-400">{opt.description}</div>
                )}
              </label>
            </div>
          )
        })}
      </fieldset>
      {errorMessage && error && (
        <p className="text-xs text-red-600">{errorMessage}</p>
      )}
    </div>
  )
)

RadioGroup.displayName = 'RadioGroup'
