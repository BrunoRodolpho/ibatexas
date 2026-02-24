import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import clsx from 'clsx'

const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'bg-amber-700 text-white hover:bg-amber-800 active:bg-amber-900',
        secondary: 'bg-slate-200 text-slate-900 hover:bg-slate-300 active:bg-slate-400',
        tertiary: 'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200',
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
  icon: React.ReactNode
  label: string
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, icon, label, ...props }, ref) => (
    <button
      ref={ref}
      className={clsx(iconButtonVariants({ variant, size }), className)}
      aria-label={label}
      {...props}
    >
      {icon}
    </button>
  )
)

IconButton.displayName = 'IconButton'
