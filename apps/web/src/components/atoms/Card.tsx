'use client'

import { forwardRef } from 'react'
import clsx from 'clsx'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  href?: string
}

const Card = forwardRef<HTMLDivElement, CardProps>(({ className, href, children, ...props }, ref) => {
  const content = (
    <div
      ref={ref}
      className={clsx('rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md', className)}
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
})
Card.displayName = 'Card'

export { Card }
