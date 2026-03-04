'use client'

import { useRef, useState, useEffect } from 'react'
import Image from 'next/image'

interface HeroVideoProps {
  src: string
  poster: string
  className?: string
}

/**
 * Video that auto-plays when possible.
 * Falls back to a static <img> when autoplay is blocked
 * (e.g. iOS Low Power Mode) — no play button ever shown.
 */
export function HeroVideo({ src, poster, className = '' }: HeroVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onPlaying = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)

    video.addEventListener('playing', onPlaying)
    video.addEventListener('pause', onPause)

    // Track retry listeners for unconditional cleanup
    const retryListeners: Array<{ type: string; handler: EventListener }> = []

    // autoPlay may have already started before React hydrated
    if (!video.paused) {
      setIsPlaying(true)
    } else {
      // Nudge play in case autoPlay attribute was ignored
      video.play().catch(() => {
        // Blocked (Low Power Mode etc.) — retry on first interaction
        const retry = () => {
          video.play().catch(() => {})
          retryListeners.forEach(({ type, handler }) =>
            document.removeEventListener(type, handler),
          )
        }
        const events = ['touchstart', 'scroll', 'click'] as const
        events.forEach((type) => {
          document.addEventListener(type, retry, { once: true, passive: true })
          retryListeners.push({ type, handler: retry as EventListener })
        })
      })
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
      // Unconditionally remove retry listeners on unmount
      retryListeners.forEach(({ type, handler }) =>
        document.removeEventListener(type, handler),
      )
    }
  }, [])

  return (
    <div className={`relative ${className}`}>
      {/* Static image — always rendered, visible when video isn't playing */}
      <Image
        src={poster}
        alt=""
        aria-hidden
        fill
        className="object-contain object-left brightness-[0.98] sepia-[0.03]"
      />

      {/* Video — layered on top, invisible until actually playing */}
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        className={`relative h-full w-full object-contain object-left brightness-[0.98] sepia-[0.03] transition-opacity duration-300 ${
          isPlaying ? 'opacity-100' : 'opacity-0'
        }`}
        aria-hidden="true"
      >
        <source src={src} type="video/mp4" />
      </video>
    </div>
  )
}
