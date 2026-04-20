'use client'

import type { Ref } from 'react'
import clsx from 'clsx'
import { tw } from '../theme/tokens'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  readonly required?: boolean
  readonly error?: boolean
  readonly helper?: string
}

function Label({
  ref,
  className,
  required,
  error,
  helper,
  children,
  ...props
}: LabelProps & { ref?: Ref<HTMLLabelElement> }) {
  return (
    <div className="space-y-1">
      <label
        ref={ref}
        className={clsx(
          'block text-sm font-medium transition-colors',
          error ? 'text-accent-red' : tw.text.primary,
          className,
        )}
        {...props}
      >
        {children}
        {required && <span className="text-accent-red ml-1">*</span>}
      </label>
      {helper && (
        <p className={clsx('text-xs', error ? 'text-accent-red' : tw.text.disabled)}>
          {helper}
        </p>
      )}
    </div>
  )
}

export { Label }
