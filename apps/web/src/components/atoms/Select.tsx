import React from 'react'
import clsx from 'clsx'

export interface SelectOption {
  value: string | number
  label: string
  disabled?: boolean
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[]
  error?: boolean
  errorMessage?: string
  placeholder?: string
  variant?: 'default' | 'minimal'
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, error, errorMessage, placeholder, variant = 'default', ...props }, ref) => (
    <div className={variant === 'minimal' ? 'inline-flex' : 'space-y-1'}>
      <select
        ref={ref}
        className={clsx(
          'font-sans appearance-none transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-none bg-transparent cursor-pointer',
          variant === 'minimal'
            ? 'border-0 px-0 py-0 text-xs'
            : clsx(
                'w-full px-0 py-2 border-0 border-b text-sm',
                error
                  ? 'border-accent-red text-accent-red focus-visible:border-accent-red'
                  : 'border-smoke-200 text-charcoal-900 focus-visible:border-charcoal-900',
                'disabled:bg-transparent disabled:text-smoke-400 disabled:cursor-not-allowed'
              ),
          className
        )}
        style={variant === 'minimal' ? {
          backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%23999' stroke-linecap='round' stroke-width='1.5' d='M4 6l4 4 4-4'/%3e%3c/svg%3e")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right center',
          backgroundSize: '1em 1em',
          paddingRight: '1.25rem',
        } : {
          backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%23334155' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M2 5l6 6 6-6'/%3e%3c/svg%3e")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.75rem center',
          backgroundSize: '1.5em 1.5em',
          paddingRight: '2.5rem',
        }}
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
      {errorMessage && error && variant === 'default' && (
        <p className="text-xs text-accent-red">{errorMessage}</p>
      )}
    </div>
  )
)

Select.displayName = 'Select'
