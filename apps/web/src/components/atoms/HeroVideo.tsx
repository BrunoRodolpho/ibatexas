'use client'

import { useRef, useState, useEffect } from 'react'

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

    // autoPlay may have already started before React hydrated
    if (!video.paused) {
      setIsPlaying(true)
    } else {
      // Nudge play in case autoPlay attribute was ignored
      video.play().catch(() => {
        // Blocked (Low Power Mode etc.) — retry on first interaction
        const retry = () => {
          video.play().catch(() => {})
          document.removeEventListener('touchstart', retry)
          document.removeEventListener('scroll', retry)
          document.removeEventListener('click', retry)
        }
        document.addEventListener('touchstart', retry, { once: true, passive: true })
        document.addEventListener('scroll', retry, { once: true, passive: true })
        document.addEventListener('click', retry, { once: true })
      })
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  return (
    <div className={`relative ${className}`}>
      {/* Static image — always rendered, visible when video isn't playing */}
      <img
        src={poster}
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-contain object-left brightness-[0.98] sepia-[0.03]"
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
