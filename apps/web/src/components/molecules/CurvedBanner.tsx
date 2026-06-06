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
  const measureRef = useRef<SVGTextElement>(null)
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
    const measureEl = measureRef.current
    if (!el || !measureEl) return

    const svg = el.ownerSVGElement
    const pathEl = svg?.querySelector('#banner-curve') as SVGPathElement | null
    if (!pathEl) return

    let wrapPct = 0
    let offset = 0
    let raf = 0

    // Wrap point = one text repetition as % of path length. Measured from a
    // flat hidden <text> (not the animated textPath): iOS Safari's
    // getComputedTextLength() on a textPath-wrapping <text> drifts from the
    // actual per-glyph advance, and dividing a 40-rep total by 40 compounds
    // that drift into a visible snap at every loop.
    const recompute = () => {
      const pathLen = pathEl.getTotalLength()
      const repLen = measureEl.getComputedTextLength()
      if (!pathLen || !repLen) return
      wrapPct = (repLen / pathLen) * 100
      // If the new wrap is tighter than the current offset (e.g. webfont just
      // loaded and the advance width shrank), fold offset into the new cycle
      // so the next reset doesn't snap visibly.
      if (wrapPct > 0 && offset < -wrapPct) offset = offset % wrapPct
    }

    recompute()
    // Playfair italic usually resolves after mount on mobile — the initial
    // measurement is against the fallback serif, giving a wrong wrapPct and
    // causing a visible jump at the reset point. Remeasure once fonts settle,
    // and once more after layout (iOS sometimes resolves fonts.ready before
    // the text element reports a final length).
    void document.fonts?.ready?.then(recompute).catch(() => {})
    const lateRecompute = globalThis.setTimeout(recompute, 500)
    globalThis.addEventListener('resize', recompute)

    const animate = () => {
      if (wrapPct > 0) {
        offset -= 0.03
        if (offset <= -wrapPct) offset += wrapPct
        el.setAttribute('startOffset', `${offset}%`)
      }
      raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(raf)
      globalThis.clearTimeout(lateRecompute)
      globalThis.removeEventListener('resize', recompute)
    }
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
        {/* Hidden one-rep measurement — same font config as the animated
            text so its measured length equals the exact wrap period. */}
        <text
          ref={measureRef}
          x="0"
          y="0"
          fontSize="24"
          fontStyle="italic"
          fontWeight="400"
          letterSpacing="0.08em"
          style={{ fontFamily: 'var(--font-playfair), Georgia, serif', visibility: 'hidden' }}
          aria-hidden="true"
        >
          {text + SEPARATOR}
        </text>
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
