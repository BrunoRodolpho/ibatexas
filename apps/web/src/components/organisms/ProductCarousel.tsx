'use client'

import { useRef, useEffect, useCallback } from 'react'
import { CarouselCard } from '../molecules/CarouselCard'
import type { ProductDTO } from '@ibatexas/types'

interface ProductCarouselProps {
  readonly products: ProductDTO[]
  readonly isLoading?: boolean
}

/** px/ms — gentle browsing pace (~60s per full cycle) */
const AUTO_SPEED = 0.13
/** ms of inactivity before auto-scroll resumes after touch */
const RESUME_DELAY = 1000
/** px threshold — drags beyond this count as swipe, not tap */
const DRAG_THRESHOLD = 8

export const ProductCarousel = ({ products, isLoading }: ProductCarouselProps) => {
  const shouldAnimate = products.length >= 4

  const trackRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef(0)
  const rafRef = useRef<number>(0)
  const lastTimeRef = useRef(0)
  const pausedRef = useRef(false)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Touch state
  const touchStartXRef = useRef(0)
  const touchOffsetRef = useRef(0)
  const isDraggingRef = useRef(false)
  const didSwipeRef = useRef(false)
  const prefersReducedMotion = useRef(false)

  /** Half-width of the track = one full set of products (the wrap point) */
  const halfWidthRef = useRef(0)

  const measureHalf = useCallback(() => {
    const el = trackRef.current
    if (el) halfWidthRef.current = el.scrollWidth / 2
  }, [])

  const applyTransform = useCallback((x: number) => {
    if (trackRef.current) {
      trackRef.current.style.transform = `translate3d(${x}px, 0, 0)`
    }
  }, [])

  /** Wrap offset so it stays within [0, -halfWidth) for seamless loop */
  const wrapOffset = useCallback((x: number) => {
    const half = halfWidthRef.current
    if (half === 0) return x
    let val = x % half
    if (val > 0) val -= half
    return val
  }, [])

  // --- Auto-scroll loop (same speed always) ---
  const tickRef = useRef<FrameRequestCallback | null>(null)
  useEffect(() => {
    tickRef.current = (now: number) => {
      if (!pausedRef.current && lastTimeRef.current) {
        const dt = now - lastTimeRef.current
        offsetRef.current = wrapOffset(offsetRef.current - AUTO_SPEED * dt)
        applyTransform(offsetRef.current)
      }
      lastTimeRef.current = now
      rafRef.current = requestAnimationFrame(tickRef.current!)
    }
  }, [applyTransform, wrapOffset])
  const tick = useCallback((now: number) => {
    tickRef.current?.(now)
  }, [])

  useEffect(() => {
    if (!shouldAnimate) return

    // Respect prefers-reduced-motion — no auto-scroll, but touch drag still works
    const mq = globalThis.matchMedia('(prefers-reduced-motion: reduce)')
    prefersReducedMotion.current = mq.matches
    const onMqChange = (e: MediaQueryListEvent) => { prefersReducedMotion.current = e.matches }
    mq.addEventListener('change', onMqChange)

    // Block click navigation after a swipe drag
    const el = trackRef.current
    const blockClick = (e: MouseEvent) => {
      if (didSwipeRef.current) {
        e.preventDefault()
        e.stopPropagation()
        didSwipeRef.current = false
      }
    }
    el?.addEventListener('click', blockClick, { capture: true })

    measureHalf()
    if (!prefersReducedMotion.current) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => {
      cancelAnimationFrame(rafRef.current)
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
      mq.removeEventListener('change', onMqChange)
      el?.removeEventListener('click', blockClick, { capture: true })
    }
  }, [shouldAnimate, tick, measureHalf])

  useEffect(() => { measureHalf() }, [products, measureHalf])

  // --- Pause on hover (desktop) ---
  const onMouseEnter = useCallback(() => { pausedRef.current = true }, [])
  const onMouseLeave = useCallback(() => { pausedRef.current = false }, [])

  // --- Touch handlers (mobile) ---
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    pausedRef.current = true
    isDraggingRef.current = true
    didSwipeRef.current = false
    touchStartXRef.current = e.touches[0].clientX
    touchOffsetRef.current = offsetRef.current
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDraggingRef.current) return
    const dx = e.touches[0].clientX - touchStartXRef.current
    if (Math.abs(dx) > DRAG_THRESHOLD) didSwipeRef.current = true
    offsetRef.current = wrapOffset(touchOffsetRef.current + dx)
    applyTransform(offsetRef.current)
  }, [applyTransform, wrapOffset])

  const scheduleResume = useCallback(() => {
    isDraggingRef.current = false
    if (prefersReducedMotion.current) return
    resumeTimerRef.current = setTimeout(() => {
      pausedRef.current = false
    }, RESUME_DELAY)
  }, [])

  const onTouchEnd = useCallback(() => { scheduleResume() }, [scheduleResume])
  const onTouchCancel = useCallback(() => { scheduleResume() }, [scheduleResume])

  // --- Render helpers ---
  const renderCard = (product: ProductDTO, prefix: string) => (
    <CarouselCard
      key={`${prefix}-${product.id}`}
      id={product.id}
      title={product.title}
      description={product.description}
      imageUrl={product.imageUrl}
      images={product.images}
      price={product.price}
      variantCount={product.variants?.length}
      variants={product.variants}
      rating={product.rating}
      tags={product.tags}
      categoryHandle={product.categoryHandle}
    />
  )

  if (isLoading) {
    return (
      <div className="overflow-hidden">
        <div className="flex gap-6 px-6">
          {['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => (
            <div
              key={id}
              className="flex-shrink-0 w-[min(630px,92vw)] aspect-[16/10] rounded-sm skeleton"
            />
          ))}
        </div>
      </div>
    )
  }

  if (products.length === 0) return null

  if (!shouldAnimate) {
    return (
      <div className="overflow-hidden">
        <div className="flex gap-6 px-6 justify-center">
          {products.map((p) => renderCard(p, 's'))}
        </div>
      </div>
    )
  }

  return (
    <section
      aria-label="Product carousel"
      aria-roledescription="carousel"
      className="overflow-hidden marquee-mask touch-pan-y"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div
        ref={trackRef}
        className="flex w-max gap-6 will-change-transform"
      >
        {products.map((p) => renderCard(p, 'a'))}
        {products.map((p) => renderCard(p, 'b'))}
      </div>
    </section>
  )
}
