import { useId, type Ref } from 'react'
import clsx from 'clsx'

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  readonly label?: string
  readonly error?: boolean
  readonly errorMessage?: string
}

export function Checkbox({ ref, className, label, error, errorMessage, id, ...props }: CheckboxProps & { ref?: Ref<HTMLInputElement> }) {
  const reactId = useId()
  const checkboxId = id || reactId

  return (
    <div className="space-y-1">
      <div className="flex items-start gap-3">
        <input
          ref={ref}
          id={checkboxId}
          type="checkbox"
          className={clsx(
            'w-4 h-4 rounded-sm border cursor-pointer transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] mt-0.5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-charcoal-900',
            error
              ? 'border-red-600 bg-red-50 accent-red-600'
              : 'border-smoke-300 bg-transparent accent-charcoal-900',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className
          )}
          {...props}
        />
        {label && (
          <label
            htmlFor={checkboxId}
            className={clsx(
              'text-sm cursor-pointer select-none',
              error ? 'text-red-600' : 'text-charcoal-700'
            )}
          >
            {label}
          </label>
        )}
      </div>
      {errorMessage && error && (
        <p className="text-xs text-accent-red">{errorMessage}</p>
      )}
    </div>
  )
}
