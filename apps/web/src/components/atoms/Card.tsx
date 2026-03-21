'use client'

import type { Ref } from 'react'
import clsx from 'clsx'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly href?: string
  readonly interactive?: boolean
}

function Card({ ref, className, href, interactive, children, ...props }: CardProps & { ref?: Ref<HTMLDivElement> }) {
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

export { Card }
