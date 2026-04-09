import { Container } from '@/components/atoms'

export default function SearchLoading() {
  return (
    <div className="min-h-screen bg-smoke-50">
      {/* Search bar skeleton */}
      <div className="sticky top-[56px] z-20 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 py-3">
        <Container>
          <div className="h-10 w-full rounded-sm skeleton" />
        </Container>
      </div>

      <Container className="py-16 lg:py-24">
        {/* Header skeleton */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-4">
          <div className="h-8 w-48 rounded-sm skeleton" />
          <div className="h-5 w-24 rounded-sm skeleton" />
        </div>

        {/* Category row skeleton */}
        <div className="flex items-center gap-6 mb-8 pb-1 mt-2">
          {Array.from({ length: 6 }, (_, i) => `skel-cat-${i}`).map((id) => (
            <div key={id} className="h-4 w-20 flex-shrink-0 rounded-sm skeleton" />
          ))}
        </div>

        {/* Product grid skeleton */}
        <div className="pt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 sm:gap-x-4 lg:gap-x-5 gap-y-8 lg:gap-y-10">
          {Array.from({ length: 8 }, (_, i) => `skel-product-${i}`).map((id) => (
            <div key={id}>
              <div className="aspect-[4/5] rounded-card skeleton" />
              <div className="pt-3 space-y-2">
                <div className="h-4 w-3/4 rounded-sm skeleton" />
                <div className="h-3 w-1/2 rounded-sm skeleton" />
                <div className="h-4 w-1/3 rounded-sm skeleton" />
              </div>
            </div>
          ))}
        </div>
      </Container>
    </div>
  )
}
