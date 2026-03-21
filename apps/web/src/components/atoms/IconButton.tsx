import type { Ref } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import clsx from 'clsx'

const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-sm font-medium transition-all duration-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'bg-charcoal-900 text-smoke-50 hover:bg-charcoal-800 active:bg-charcoal-700',
        secondary: 'bg-smoke-200 text-charcoal-900 hover:bg-smoke-300 active:bg-smoke-400',
        tertiary: 'bg-transparent text-charcoal-700 hover:bg-smoke-100 active:bg-smoke-200',
        danger: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800',
      },
      size: {
        sm: 'w-8 h-8 text-sm',
        md: 'w-10 h-10 text-base',
        lg: 'w-12 h-12 text-lg',
      },
    },
    defaultVariants: {
      variant: 'tertiary',
      size: 'md',
    },
  }
)

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  readonly icon: React.ReactNode
  readonly label: string
}

export function IconButton({ ref, className, variant, size, icon, label, ...props }: IconButtonProps & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      className={clsx(iconButtonVariants({ variant, size }), className)}
      aria-label={label}
      {...props}
    >
      {icon}
    </button>
  )
}
