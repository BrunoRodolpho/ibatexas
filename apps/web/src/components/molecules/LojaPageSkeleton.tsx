import { ProductGridSkeleton } from './ProductGridSkeleton'

/**
 * Loading skeleton for the loja (catalog) and category pages.
 *
 * Why this exists: previously the category and shop pages short-circuited their
 * entire body to a centered "Loading…" text during fetch, which caused the
 * page header, description, and grid to all pop in at once when data arrived.
 * This skeleton mirrors the real page chrome so the layout is stable through
 * the loading → loaded transition.
 *
 * Pass `showHeader={false}` to omit the title block when the parent is already
 * rendering its own header (e.g. category pages with a static category name).
 */
interface LojaPageSkeletonProps {
  readonly showHeader?: boolean
  readonly columns?: number
  readonly count?: number
}

export function LojaPageSkeleton({
  showHeader = true,
  columns = 4,
  count,
}: LojaPageSkeletonProps) {
  return (
    <div className="animate-pulse">
      {showHeader && (
        <div className="text-center mb-12">
          <div className="mx-auto h-9 sm:h-11 w-3/5 max-w-[420px] rounded bg-smoke-200" />
          <div className="mx-auto mt-4 h-4 w-2/5 max-w-[280px] rounded bg-smoke-200" />
        </div>
      )}
      {/* Filter chip placeholder row — mirrors a typical category filter strip. */}
      <div className="mb-8 flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => `chip-${i}`).map((id) => (
          <div
            key={id}
            className="h-7 w-20 rounded-sm bg-smoke-200 flex-shrink-0"
          />
        ))}
      </div>
      <ProductGridSkeleton columns={columns} count={count} />
    </div>
  )
}
