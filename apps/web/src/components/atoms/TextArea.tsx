import type { Ref } from 'react'
import clsx from 'clsx'

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly error?: boolean
  readonly errorMessage?: string
  readonly counter?: boolean
  readonly maxLength?: number
}

export function TextArea({ ref, className, error, errorMessage, counter, maxLength, value, ...props }: TextAreaProps & { ref?: Ref<HTMLTextAreaElement> }) {
  const charCount = typeof value === 'string' ? value.length : 0

  return (
    <div className="space-y-1">
      <textarea
        ref={ref}
        maxLength={maxLength}
        value={value}
        className={clsx(
          'w-full px-0 py-2 border-0 border-b font-sans transition-colors duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-none bg-transparent text-sm',
          error
            ? 'border-red-600 focus-visible:border-red-700'
            : 'border-smoke-200 focus-visible:border-charcoal-900',
          'disabled:text-[var(--color-text-disabled)] disabled:cursor-not-allowed',
          className
        )}
        {...props}
      />
      <div className="flex justify-between items-start">
        {errorMessage && error && (
          <p className="text-xs text-accent-red">{errorMessage}</p>
        )}
        {counter && maxLength && (
          <p
            className={clsx(
              'text-xs ml-auto',
              charCount === maxLength ? 'text-red-600 font-medium' : 'text-[var(--color-text-secondary)]'
            )}
          >
            {charCount}/{maxLength}
          </p>
        )}
      </div>
    </div>
  )
}
