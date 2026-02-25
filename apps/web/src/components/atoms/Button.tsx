'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-250 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none disabled:transform-none select-none',
  {
    variants: {
      variant: {
        primary: [
          'bg-brand-500 text-white',
          'shadow-glow-brand',
          'hover:bg-brand-600 hover:-translate-y-0.5 hover:shadow-glow-brand-lg',
          'active:translate-y-0 active:shadow-glow-brand',
          'focus-visible:ring-brand-500',
        ],
        secondary: [
          'border border-slate-200 bg-white text-slate-900',
          'shadow-card-sm',
          'hover:bg-smoke-50 hover:border-slate-300 hover:shadow-card-md hover:-translate-y-0.5',
          'active:translate-y-0',
          'focus-visible:ring-slate-400',
        ],
        tertiary: [
          'bg-transparent text-brand-500',
          'hover:bg-brand-50',
          'focus-visible:ring-brand-500',
        ],
        danger: [
          'bg-red-600 text-white',
          'hover:bg-red-700 hover:-translate-y-0.5',
          'active:translate-y-0',
          'focus-visible:ring-red-600',
        ],
      },
      size: {
        sm:   'px-3 py-1.5 text-sm',
        md:   'px-5 py-2.5 text-base',
        lg:   'px-8 py-4 text-lg',
        icon: 'p-2.5',
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
