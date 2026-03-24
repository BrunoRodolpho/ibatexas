'use client'

import { useEffect, Suspense } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { getPostHogClient } from '@/lib/posthog'
import { useConsentStore } from '@/domains/consent'

/**
 * Tracks $pageview on Next.js route changes.
 * Wrapped in Suspense because useSearchParams() requires it.
 */
function PostHogPageview() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const accepted = useConsentStore((s) => s.accepted)

  useEffect(() => {
    if (!accepted) return
    const posthog = getPostHogClient()
    if (!posthog) return

    // Build full URL from pathname + search params
    let url = pathname
    if (searchParams.toString()) {
      url = `${pathname}?${searchParams.toString()}`
    }

    posthog.capture('$pageview', {
      $current_url: url,
    })
  }, [pathname, searchParams, accepted])

  return null
}

/**
 * Convenience hook for components that need direct PostHog access.
 * Returns the PostHog client singleton, or null if PostHog is not configured.
 */
export function usePostHog() {
  return getPostHogClient()
}

/**
 * PostHogProvider — initializes PostHog and tracks pageviews on route changes.
 * Place in layout.tsx outside UI components (PostHog is infrastructure, not UI).
 */
export function PostHogProvider({ children }: { readonly children: React.ReactNode }) {
  const accepted = useConsentStore((s) => s.accepted)

  // Initialize PostHog only when consent is accepted
  useEffect(() => {
    if (!accepted) return
    getPostHogClient()
  }, [accepted])

  return (
    <>
      <Suspense fallback={null}>
        <PostHogPageview />
      </Suspense>
      {children}
    </>
  )
}
