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
          'rounded-sm bg-smoke-50 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
          interactive && 'hover:bg-smoke-100 cursor-pointer',
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
