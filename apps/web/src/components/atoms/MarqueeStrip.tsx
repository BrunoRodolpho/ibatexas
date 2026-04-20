'use client'

import { useRef, useEffect, useState, type ReactNode } from 'react'

interface MarqueeStripProps {
  /** Content to scroll (will be duplicated for seamless loop) */
  readonly children: ReactNode
  /** Tailwind classes for the outer wrapper */
  readonly className?: string
  /** Animation duration in seconds (lower = faster). Default: 40 */
  readonly speed?: number
  /** Pause animation on hover. Default: true */
  readonly pauseOnHover?: boolean
  /** Custom aria-label for the region */
  readonly 'aria-label'?: string
}

/**
 * Reusable infinite-scroll marquee ticker.
 *
 * Duplicates children to create a seamless loop using the existing
 * `@keyframes marquee` (translateX 0 → -50%) from globals.css.
 * Uses `.marquee-mask` for edge-fade and respects `prefers-reduced-motion`.
 */
export function MarqueeStrip({
  children,
  className = '',
  speed = 40,
  pauseOnHover = true,
  'aria-label': ariaLabel,
}: MarqueeStripProps) {
  const [prefersReduced, setPrefersReduced] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mq = globalThis.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReduced(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPrefersReduced(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  if (prefersReduced) {
    return (
      <div
        className={`overflow-hidden ${className}`}
        role="marquee"
        aria-live="off"
        aria-label={ariaLabel}
      >
        <div className="flex justify-center whitespace-nowrap py-2">
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`overflow-hidden marquee-mask ${className}`}
      role="marquee"
      aria-live="off"
      aria-label={ariaLabel}
    >
      <div
        ref={trackRef}
        className={`flex whitespace-nowrap animate-marquee ${pauseOnHover ? 'hover:[animation-play-state:paused]' : ''}`}
        style={{ animationDuration: `${speed}s` }}
      >
        {children}
        {children}
      </div>
    </div>
  )
}
