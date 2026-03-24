'use client'

import { useRef, useEffect, useState, type ReactNode } from 'react'

interface ScrollRevealProps {
  readonly children: ReactNode
  readonly className?: string
  /** Delay in ms before the animation starts after entering viewport */
  readonly delay?: number
  /** How much of the element must be visible (0–1) */
  readonly threshold?: number
  /** Animation variant */
  readonly animation?: 'fade-up' | 'scale-up' | 'slide-left' | 'slide-right' | 'zoom'
}

/**
 * Scroll-triggered reveal animation.
 * Wraps children and animates them in when they enter the viewport.
 */
export function ScrollReveal({
  children,
  className = '',
  delay = 0,
  threshold = 0.15,
  animation = 'fade-up',
}: ScrollRevealProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Respect reduced-motion
    const prefersReduced = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced) {
      setIsVisible(true) // eslint-disable-line react-hooks/set-state-in-effect -- immediate reveal for reduced-motion
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (delay > 0) {
            setTimeout(() => setIsVisible(true), delay)
          } else {
            setIsVisible(true)
          }
          observer.unobserve(el)
        }
      },
      { threshold, rootMargin: '0px 0px -40px 0px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [delay, threshold])

  const baseStyle = 'transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]'

  const animationStyles: Record<string, { hidden: string; visible: string }> = {
    'fade-up': {
      hidden: 'opacity-0 translate-y-12',
      visible: 'opacity-100 translate-y-0',
    },
    'scale-up': {
      hidden: 'opacity-0 scale-[0.85]',
      visible: 'opacity-100 scale-100',
    },
    'slide-left': {
      hidden: 'opacity-0 translate-x-10',
      visible: 'opacity-100 translate-x-0',
    },
    'slide-right': {
      hidden: 'opacity-0 -translate-x-10',
      visible: 'opacity-100 translate-x-0',
    },
    zoom: {
      hidden: 'opacity-0 scale-75',
      visible: 'opacity-100 scale-100',
    },
  }

  const style = animationStyles[animation] || animationStyles['fade-up']

  return (
    <div
      ref={ref}
      className={`${baseStyle} ${isVisible ? style.visible : style.hidden} ${className}`}
    >
      {children}
    </div>
  )
}
