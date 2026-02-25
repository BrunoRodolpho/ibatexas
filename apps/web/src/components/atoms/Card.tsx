'use client'

import { forwardRef } from 'react'
import clsx from 'clsx'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  href?: string
  interactive?: boolean
}

const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, href, interactive, children, ...props }, ref) => {
    const content = (
      <div
        ref={ref}
        className={clsx(
          'rounded-2xl border border-slate-200/70 bg-white shadow-card-sm transition-shadow',
          interactive && 'card-hover cursor-pointer',
          className
        )}
        {...props}
      >
        {children}
      </div>
    )

    if (href) {
      return (
        <a href={href} className="block card-hover">
          {content}
        </a>
      )
    }

    return content
  }
)
Card.displayName = 'Card'

export { Card }
