'use client'

import { useRef, useState, useEffect } from 'react'
import Image from 'next/image'

type RetryEntry = { type: string; handler: EventListener }

const INTERACTION_EVENTS = ['touchstart', 'scroll', 'click'] as const

/** Register interaction-based retry listeners for blocked autoplay */
function registerRetryListeners(
  video: HTMLVideoElement,
  retryListeners: RetryEntry[],
): void {
  const retry = () => {
    video.play().catch(() => {})
    removeRetryListeners(retryListeners)
  }
  for (const type of INTERACTION_EVENTS) {
    document.addEventListener(type, retry, { once: true, passive: true })
    retryListeners.push({ type, handler: retry as EventListener })
  }
}

/** Remove all tracked retry listeners */
function removeRetryListeners(retryListeners: RetryEntry[]): void {
  for (const { type, handler } of retryListeners) {
    document.removeEventListener(type, handler)
  }
}

interface HeroVideoProps {
  readonly src: string
  readonly poster: string
  readonly className?: string
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
    if (video.paused) {
      // Nudge play in case autoPlay attribute was ignored
      video.play().catch(() => {
        // Blocked (Low Power Mode etc.) — retry on first interaction
        registerRetryListeners(video, retryListeners)
      })
    } else {
      setIsPlaying(true)
    }

    return () => {
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('pause', onPause)
      removeRetryListeners(retryListeners)
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
        tabIndex={-1}
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
