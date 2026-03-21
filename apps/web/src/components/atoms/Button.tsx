'use client'

import { type VariantProps } from 'class-variance-authority'
import type { Ref, ComponentProps } from 'react'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@ibatexas/ui/atoms'

interface LinkButtonProps
  extends ComponentProps<typeof Link>,
    VariantProps<typeof buttonVariants> {}

function LinkButton({ ref, className, variant, size, children, ...props }: LinkButtonProps & { ref?: Ref<HTMLAnchorElement> }) {
  return (
    <Link ref={ref} className={buttonVariants({ variant, size, className })} {...props}>
      {children}
    </Link>
  )
}

export { LinkButton }
