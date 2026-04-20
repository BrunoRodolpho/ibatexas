'use client'

import { useRef, useEffect, useState } from 'react'
import { WAVE_CURVE } from './wave-paths'

interface CurvedBannerProps {
  /** Banner text to display (will be repeated along the curve) */
  readonly text: string
}

const SEPARATOR = ' \u00B7 '
const REPEAT_COUNT = 40

/**
 * Amorino-style curved SVG text banner.
 *
 * Floating decorative element — text scrolls along a gentle wave curve.
 * Sits in blank space between hero and orange section (not merged with either).
 */
export function CurvedBanner({ text }: CurvedBannerProps) {
  const textPathRef = useRef<SVGTextPathElement>(null)
  const [prefersReduced, setPrefersReduced] = useState(false)

  useEffect(() => {
    const mq = globalThis.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReduced(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPrefersReduced(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (prefersReduced) return
    const el = textPathRef.current
    if (!el) return

    const svg = el.ownerSVGElement
    const pathEl = svg?.querySelector('#banner-curve') as SVGPathElement | null
    const textEl = el.parentElement as SVGTextElement | null
    if (!pathEl || !textEl) return

    // Compute the wrap point: one text repetition as % of path length.
    // After scrolling one unit the visual is identical (all reps are the same string).
    const pathLen = pathEl.getTotalLength()
    const textLen = textEl.getComputedTextLength()
    const unitPx = textLen / REPEAT_COUNT
    const wrapPct = (unitPx / pathLen) * 100

    let offset = 0
    let raf: number

    const animate = () => {
      offset -= 0.03
      if (offset <= -wrapPct) offset += wrapPct
      el.setAttribute('startOffset', `${offset}%`)
      raf = requestAnimationFrame(animate)
    }

    raf = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf)
  }, [prefersReduced])

  const repeated = Array.from({ length: REPEAT_COUNT }, () => text).join(SEPARATOR) + SEPARATOR

  return (
    <div className="relative w-full overflow-hidden">
      <svg
        viewBox="0 0 1440 80"
        preserveAspectRatio="none"
        className="block w-full h-[40px] sm:h-[55px] lg:h-[70px]"
        aria-hidden="true"
      >
        <path id="banner-curve" fill="transparent" d={WAVE_CURVE} />
        <text
          fill="var(--color-brand-500, #E85D04)"
          fillOpacity="0.6"
          fontSize="24"
          fontStyle="italic"
          fontWeight="400"
          letterSpacing="0.08em"
          style={{ fontFamily: 'var(--font-playfair), Georgia, serif' }}
        >
          <textPath
            ref={textPathRef}
            href="#banner-curve"
            lengthAdjust="spacingAndGlyphs"
            startOffset="0%"
          >
            {repeated}
          </textPath>
        </text>
      </svg>
    </div>
  )
}
