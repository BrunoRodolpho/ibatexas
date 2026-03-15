'use client'

import { useState, useCallback } from 'react'
import { Image } from '@/components/atoms/Image'
import clsx from 'clsx'

// ── Helpers ──────────────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.ogg']

/** Detect whether a URL points to a video file by extension. */
function isVideo(url: string): boolean {
  try {
    const pathname = new URL(url, 'https://placeholder.local').pathname.toLowerCase()
    return VIDEO_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  } catch {
    return false
  }
}

// ── Props ────────────────────────────────────────────────────────────────────

interface MediaGalleryProps {
  /** Full gallery URLs sorted by rank (from Typesense `images` field) */
  readonly images: string[]
  /** Fallback thumbnail when gallery is empty */
  readonly thumbnail?: string | null
  /** Alt text for images */
  readonly title: string
  /** Additional class for the outer container */
  readonly className?: string
}

// ── Component ────────────────────────────────────────────────────────────────

export function MediaGallery({ images, thumbnail, title, className }: MediaGalleryProps) {
  // Build the effective media list: prefer gallery, fall back to thumbnail
  let media: string[]
  if (images.length > 0) {
    media = images
  } else if (thumbnail) {
    media = [thumbnail]
  } else {
    media = []
  }
  const [selectedIndex, setSelectedIndex] = useState(0)

  const handleSelect = useCallback((index: number) => {
    setSelectedIndex(index)
  }, [])

  const handlePrev = useCallback(() => {
    setSelectedIndex((i) => (i > 0 ? i - 1 : media.length - 1))
  }, [media.length])

  const handleNext = useCallback(() => {
    setSelectedIndex((i) => (i < media.length - 1 ? i + 1 : 0))
  }, [media.length])

  // Empty state — no media at all
  if (media.length === 0) {
    return (
      <div className={clsx('aspect-square rounded-card bg-gradient-to-br from-smoke-100 to-smoke-200 flex items-center justify-center relative overflow-hidden', className)}>
        <div className="grain-overlay" />
        <span className="font-display text-lg font-medium text-smoke-300/30 uppercase tracking-editorial">
          Sem imagem
        </span>
      </div>
    )
  }

  const currentUrl = media[selectedIndex] ?? media[0]
  const currentIsVideo = isVideo(currentUrl)

  return (
    <div className={clsx('space-y-3', className)}>
      {/* Main media — square aspect ratio */}
      <div className="relative aspect-square overflow-hidden rounded-card surface-card">
        {currentIsVideo ? (
          <video
            key={currentUrl}
            src={currentUrl}
            controls
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          >
            <track kind="captions" />
          </video>
        ) : (
          <Image
            key={currentUrl}
            src={currentUrl}
            alt={`${title} — imagem ${selectedIndex + 1} de ${media.length}`}
            variant="detail"
            className="aspect-square"
            priority={selectedIndex === 0}
          />
        )}

        {/* Mobile swipe arrows — visible only on small screens, hidden when single image */}
        {media.length > 1 && (
          <>
            <button
              onClick={handlePrev}
              aria-label="Imagem anterior"
              className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-smoke-50/80 backdrop-blur-sm p-2 text-charcoal-900 shadow-sm transition-opacity hover:bg-smoke-50 lg:hidden"
            >
              <ChevronLeft />
            </button>
            <button
              onClick={handleNext}
              aria-label="Próxima imagem"
              className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-smoke-50/80 backdrop-blur-sm p-2 text-charcoal-900 shadow-sm transition-opacity hover:bg-smoke-50 lg:hidden"
            >
              <ChevronRight />
            </button>
          </>
        )}
      </div>

      {/* Mobile dots indicator */}
      {media.length > 1 && (
        <div className="flex justify-center gap-1.5 lg:hidden">
          {media.map((_, i) => (
            <button
              key={`dot-${i}`}
              onClick={() => handleSelect(i)}
              aria-label={`Ir para imagem ${i + 1}`}
              className={clsx(
                'h-1.5 rounded-full transition-all duration-300',
                i === selectedIndex ? 'w-4 bg-charcoal-900' : 'w-1.5 bg-smoke-300',
              )}
            />
          ))}
        </div>
      )}

      {/* Thumbnail strip — desktop only */}
      {media.length > 1 && (
        <div className="hidden lg:grid grid-cols-4 gap-2">
          {media.map((url, i) => {
            const thumbIsVideo = isVideo(url)
            return (
              <button
                key={url}
                onClick={() => handleSelect(i)}
                className={clsx(
                  'relative aspect-square overflow-hidden rounded-card transition-all duration-300',
                  i === selectedIndex
                    ? 'ring-2 ring-charcoal-900 ring-offset-2'
                    : 'opacity-60 hover:opacity-100',
                )}
              >
                {thumbIsVideo ? (
                  <div className="h-full w-full bg-smoke-200 flex items-center justify-center">
                    <PlayIcon />
                  </div>
                ) : (
                  <Image
                    src={url}
                    alt={`${title} — miniatura ${i + 1}`}
                    variant="thumbnail"
                    className="!h-full !w-full"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Inline SVG icons (avoids external dependency for 3 small icons) ──────────

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  )
}

function ChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-smoke-400">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}
