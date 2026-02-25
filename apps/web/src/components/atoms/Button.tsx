'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-medium rounded-lg text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed select-none',
  {
    variants: {
      variant: {
        primary: [
          'bg-slate-900 text-white',
          'hover:bg-slate-800',
          'active:bg-slate-950',
          'focus-visible:ring-slate-900',
        ],
        secondary: [
          'border border-slate-200 bg-white text-slate-700',
          'shadow-xs',
          'hover:bg-slate-50 hover:text-slate-900',
          'focus-visible:ring-slate-400',
        ],
        tertiary: [
          'bg-transparent text-slate-600',
          'hover:bg-slate-100 hover:text-slate-900',
          'focus-visible:ring-slate-400',
        ],
        danger: [
          'bg-red-600 text-white',
          'hover:bg-red-700',
          'focus-visible:ring-red-600',
        ],
        brand: [
          'bg-brand-500 text-white',
          'hover:bg-brand-600',
          'active:bg-brand-700',
          'focus-visible:ring-brand-500',
        ],
      },
      size: {
        sm:   'px-3 py-1.5 text-xs',
        md:   'px-4 py-2 text-sm',
        lg:   'px-6 py-3 text-sm',
        icon: 'p-2',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, isLoading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      className={buttonVariants({ variant, size, className })}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading && (
        <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  )
)
Button.displayName = 'Button'

export { Button, buttonVariants }
