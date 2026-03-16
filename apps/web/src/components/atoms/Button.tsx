'use client'

import { type VariantProps } from 'class-variance-authority'
import { forwardRef, type ComponentProps } from 'react'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@ibatexas/ui/atoms'

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

export { LinkButton }
