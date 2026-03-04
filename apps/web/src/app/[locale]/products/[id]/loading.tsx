export default function ProductLoading() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
      {/* Breadcrumb skeleton */}
      <div className="mb-8 flex gap-2">
        <div className="h-4 w-12 rounded-sm skeleton" />
        <div className="h-4 w-4 rounded-sm skeleton" />
        <div className="h-4 w-20 rounded-sm skeleton" />
        <div className="h-4 w-4 rounded-sm skeleton" />
        <div className="h-4 w-32 rounded-sm skeleton" />
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Image skeleton */}
        <div className="aspect-[4/5] rounded-card skeleton" />

        {/* Details skeleton */}
        <div className="space-y-6 py-4">
          <div className="h-8 w-3/4 rounded-sm skeleton" />
          <div className="flex gap-3">
            <div className="h-3 w-16 rounded-sm skeleton" />
            <div className="h-3 w-24 rounded-sm skeleton" />
          </div>
          <div className="space-y-2">
            <div className="h-4 w-full rounded-sm skeleton" />
            <div className="h-4 w-2/3 rounded-sm skeleton" />
          </div>
          <div className="h-10 w-40 rounded-sm skeleton mt-4" />
          <div className="h-6 w-24 rounded-sm skeleton" />
          <div className="h-14 w-full rounded-sm skeleton mt-8" />
        </div>
      </div>
    </div>
  )
}
