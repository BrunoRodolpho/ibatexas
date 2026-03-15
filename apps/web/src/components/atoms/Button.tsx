'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ComponentProps } from 'react'
import { Link } from '@/i18n/navigation'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-medium rounded-sm text-sm transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed select-none',
  {
    variants: {
      variant: {
        primary: [
          'bg-charcoal-900 text-white shadow-xs tracking-wide',
          'hover:bg-charcoal-700 hover:shadow-md',
          'active:bg-charcoal-900 active:translate-y-[1px] active:shadow-xs',
          'focus-visible:ring-charcoal-900',
        ],
        secondary: [
          'border border-smoke-200 bg-smoke-50 text-charcoal-900',
          'hover:bg-smoke-100',
          'focus-visible:ring-smoke-300',
        ],
        tertiary: [
          'bg-transparent text-smoke-400',
          'hover:text-charcoal-900',
          'focus-visible:ring-smoke-300',
        ],
        danger: [
          'bg-accent-red text-white',
          'hover:bg-red-700',
          'focus-visible:ring-accent-red',
        ],
        brand: [
          'bg-brand-500 text-white',
          'hover:bg-brand-600',
          'active:bg-brand-700',
          'focus-visible:ring-brand-500',
        ],
        'primary-inverse': [
          'bg-smoke-50 text-charcoal-900',
          'hover:bg-smoke-100',
          'active:bg-smoke-200',
          'focus-visible:ring-smoke-300',
        ],
        'secondary-inverse': [
          'border border-smoke-300 bg-transparent text-white',
          'hover:border-white',
          'focus-visible:ring-white',
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

interface LinkButtonProps
  extends ComponentProps<typeof Link>,
    VariantProps<typeof buttonVariants> {}

const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(
  ({ className, variant, size, children, ...props }, ref) => (
    <Link ref={ref} className={buttonVariants({ variant, size, className })} {...props}>
      {children}
    </Link>
  )
)
LinkButton.displayName = 'LinkButton'

export { Button, LinkButton, buttonVariants }
