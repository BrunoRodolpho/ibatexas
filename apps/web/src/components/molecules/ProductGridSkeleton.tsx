/**
 * Standalone skeleton for the product grid. Mirrors ProductGrid's responsive
 * column layout exactly so the loading state and the loaded state occupy the
 * same footprint — no layout shift when data arrives.
 *
 * Extracted from ProductGrid.tsx so other surfaces (favorites page, search,
 * full-page skeletons) can render the loading state without rendering the full
 * grid + virtualization machinery.
 */
interface ProductGridSkeletonProps {
  readonly columns?: number
  readonly count?: number
}

const GRID_COLS_CLASS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-2 md:grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
}

export function ProductGridSkeleton({ columns = 4, count }: ProductGridSkeletonProps) {
  const gridColsClass = GRID_COLS_CLASS[columns] ?? GRID_COLS_CLASS[4]!
  const skeletonCount = count ?? (columns === 5 ? 10 : 8)

  return (
    <div className={`grid ${gridColsClass} gap-x-3 sm:gap-x-4 lg:gap-x-5 gap-y-8 lg:gap-y-10`}>
      {Array.from({ length: skeletonCount }, (_, i) => `skel-grid-${i}`).map((id) => (
        <div key={id} className="overflow-hidden rounded-card animate-pulse">
          <div className="aspect-[4/3] rounded-card bg-smoke-200" />
          <div className="pt-3 space-y-2.5">
            <div className="h-4 w-3/4 rounded bg-smoke-200" />
            <div className="h-3 w-1/3 rounded bg-smoke-200" />
          </div>
        </div>
      ))}
    </div>
  )
}
