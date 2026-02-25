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
          'rounded-lg border border-slate-200 bg-white shadow-xs transition-shadow duration-150',
          interactive && 'hover:shadow-md cursor-pointer',
          className
        )}
        {...props}
      >
        {children}
      </div>
    )

    if (href) {
      return (
        <a href={href} className="block">
          {content}
        </a>
      )
    }

    return content
  }
)
Card.displayName = 'Card'

export { Card }
