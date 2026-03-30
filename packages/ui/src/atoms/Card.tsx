'use client'

import type { Ref } from 'react'
import clsx from 'clsx'

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly interactive?: boolean
}

export function Card({
  ref,
  className,
  interactive,
  children,
  ...props
}: CardProps & { ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className={clsx(
        'rounded-sm bg-smoke-50 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
        interactive && 'cursor-pointer hover:bg-smoke-100',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
