'use client'

import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'

const textVariants = cva('', {
  variants: {
    variant: {
      h1: 'font-display text-display-sm sm:text-display-md font-semibold tracking-display',
      h2: 'font-display text-display-sm font-semibold tracking-display',
      h3: 'font-display text-2xl font-semibold tracking-tight',
      h4: 'text-lg font-semibold tracking-tight',
      h5: 'text-base font-semibold',
      h6: 'text-sm font-medium uppercase tracking-editorial',
      body: 'text-base leading-relaxed',
      small: 'text-sm leading-relaxed',
      xs: 'text-xs',
      caption: 'text-[10px] uppercase tracking-editorial font-medium',
    },
    textColor: {
      primary: 'text-charcoal-900',
      secondary: 'text-charcoal-700',
      muted: 'text-smoke-400',
      accent: 'text-brand-500',
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

