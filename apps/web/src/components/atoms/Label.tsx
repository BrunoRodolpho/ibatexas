import React from 'react'
import clsx from 'clsx'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean
  error?: boolean
  helper?: string
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, required, error, helper, children, ...props }, ref) => (
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
        <p className={clsx('text-xs', error ? 'text-accent-red' : 'text-smoke-400')}>
          {helper}
        </p>
      )}
    </div>
  )
)

Label.displayName = 'Label'
