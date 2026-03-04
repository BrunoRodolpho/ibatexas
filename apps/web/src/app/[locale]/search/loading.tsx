export default function SearchLoading() {
  return (
    <div className="min-h-screen bg-smoke-50">
      {/* Search bar skeleton */}
      <div className="sticky top-[56px] z-20 bg-smoke-50/95 backdrop-blur-sm border-b border-smoke-200 px-4 py-3">
        <div className="max-w-[1200px] mx-auto">
          <div className="h-10 w-full rounded-sm skeleton" />
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-16 lg:py-20">
        {/* Header skeleton */}
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-4">
          <div className="h-8 w-48 rounded-sm skeleton" />
          <div className="h-5 w-24 rounded-sm skeleton" />
        </div>

        {/* Category row skeleton */}
        <div className="flex items-center gap-6 mb-8 pb-1 mt-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-4 w-20 flex-shrink-0 rounded-sm skeleton" />
          ))}
        </div>

        {/* Product grid skeleton */}
        <div className="pt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 sm:gap-x-4 lg:gap-x-5 gap-y-8 lg:gap-y-10">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i}>
              <div className="aspect-[4/5] rounded-card skeleton" />
              <div className="pt-3 space-y-2">
                <div className="h-4 w-3/4 rounded-sm skeleton" />
                <div className="h-3 w-1/2 rounded-sm skeleton" />
                <div className="h-4 w-1/3 rounded-sm skeleton" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
