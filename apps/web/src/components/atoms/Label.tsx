import type { Ref } from 'react'
import clsx from 'clsx'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  readonly required?: boolean
  readonly error?: boolean
  readonly helper?: string
}

export function Label({ ref, className, required, error, helper, children, ...props }: LabelProps & { ref?: Ref<HTMLLabelElement> }) {
  return (
    <div className="space-y-1">
      <label
        ref={ref}
        className={clsx(
          'block text-sm font-medium transition-colors',
          error ? 'text-red-600' : 'text-charcoal-700',
          className
        )}
        {...props}
      >
        {children}
        {required && <span className="text-accent-red ml-1">*</span>}
      </label>
      {helper && (
        <p className={clsx('text-xs', error ? 'text-accent-red' : 'text-[var(--color-text-secondary)]')}>
          {helper}
        </p>
      )}
    </div>
  )
}
