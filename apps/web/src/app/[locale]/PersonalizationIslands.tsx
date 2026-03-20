'use client'

import dynamic from 'next/dynamic'

const HomeRecommendations = dynamic(() => import('./HomeRecommendations').then((m) => m.HomeRecommendations), { ssr: false })
const HomeReviews = dynamic(() => import('./HomeReviews').then((m) => m.HomeReviews), { ssr: false })
const RecentlyViewedCarousel = dynamic(
  () => import('@/components/organisms/RecentlyViewedCarousel').then((m) => m.RecentlyViewedCarousel),
  { ssr: false }
)

export function PersonalizationReviews() {
  return <HomeReviews />
}

export function PersonalizationRecommendations() {
  return <HomeRecommendations />
}

export function PersonalizationRecentlyViewed() {
  return <RecentlyViewedCarousel />
}
