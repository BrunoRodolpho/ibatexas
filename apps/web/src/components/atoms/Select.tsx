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
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, error, errorMessage, placeholder, ...props }, ref) => (
    <div className="space-y-1">
      <select
        ref={ref}
        className={clsx(
          'w-full px-4 py-3 rounded-lg border-2 font-sans appearance-none transition-colors focus-visible:outline-none bg-white',
          error
            ? 'border-red-600 bg-red-50 focus-visible:border-red-700 focus-visible:ring-2 focus-visible:ring-red-200'
            : 'border-slate-300 focus-visible:border-amber-700 focus-visible:ring-2 focus-visible:ring-amber-200',
          'disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed',
          'cursor-pointer',
          className
        )}
        style={{
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
      {errorMessage && error && (
        <p className="text-xs text-red-600">{errorMessage}</p>
      )}
    </div>
  )
)

Select.displayName = 'Select'
