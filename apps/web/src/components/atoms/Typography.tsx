'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const textVariants = cva('', {
  variants: {
    variant: {
      h1: 'text-4xl font-bold tracking-tight',
      h2: 'text-3xl font-bold tracking-tight',
      h3: 'text-2xl font-bold tracking-tight',
      h4: 'text-xl font-bold tracking-tight',
      h5: 'text-lg font-bold',
      h6: 'text-base font-bold',
      body: 'text-base',
      small: 'text-sm',
      xs: 'text-xs',
      caption: 'text-xs uppercase tracking-wide',
    },
    textColor: {
      primary: 'text-slate-900',
      secondary: 'text-slate-600',
      muted: 'text-slate-500',
      accent: 'text-amber-700',
      danger: 'text-red-600',
      success: 'text-green-600',
    },
    weight: {
      normal: 'font-normal',
      medium: 'font-medium',
      semibold: 'font-semibold',
      bold: 'font-bold',
    },
  },
  defaultVariants: {
    variant: 'body',
    textColor: 'primary',
    weight: 'normal',
  },
})

export interface HeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof textVariants> {
  as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
}

export interface TextProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof textVariants> {}

const Heading = forwardRef<
  HTMLHeadingElement,
  HeadingProps & { as?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' }
>(({ className, variant, textColor, weight, as: Tag = 'h1', ...props }, ref) => (
  <Tag
    ref={ref}
    className={textVariants({ variant: (variant || Tag) as any, textColor, weight, className })}
    {...props}
  />
))
Heading.displayName = 'Heading'

const Text = forwardRef<HTMLParagraphElement, TextProps>(
  ({ className, variant = 'body', textColor, weight, ...props }, ref) => (
    <p ref={ref} className={textVariants({ variant, textColor, weight, className })} {...props} />
  )
)
Text.displayName = 'Text'

export { Heading, Text, textVariants }

