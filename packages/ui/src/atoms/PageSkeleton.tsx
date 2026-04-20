'use client'

import { Loader2 } from 'lucide-react'

export interface PageSkeletonProps {
  readonly variant: 'table' | 'stats' | 'spinner' | 'list'
  readonly columns?: number
  readonly rows?: number
  readonly statCount?: number
}

function TableSkeleton({ columns = 5, rows = 5 }: { columns?: number; rows?: number }) {
  return (
    <div className="w-full overflow-x-auto rounded-sm border border-smoke-200 bg-smoke-50">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-smoke-100 bg-smoke-100/50">
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} className="px-4 py-2.5">
                <div className="h-3 w-20 animate-pulse rounded bg-smoke-200" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i} className="border-b border-smoke-100">
              {Array.from({ length: columns }).map((_, j) => (
                <td key={j} className="px-4 py-2.5">
                  <div className="h-3 w-full animate-pulse rounded bg-smoke-100" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-sm border border-smoke-200 border-l-2 border-l-smoke-300 bg-smoke-50 p-5">
          <div className="h-4 w-16 animate-pulse rounded bg-smoke-100" />
          <div className="mt-3 h-7 w-24 animate-pulse rounded bg-smoke-200" />
          <div className="mt-2 h-3 w-20 animate-pulse rounded bg-smoke-100" />
        </div>
      ))}
    </div>
  )
}

function SpinnerSkeleton() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-5 w-5 animate-spin text-smoke-300" />
    </div>
  )
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-sm border border-smoke-200 bg-smoke-100" />
      ))}
    </div>
  )
}

export function PageSkeleton({ variant, columns, rows, statCount }: PageSkeletonProps) {
  switch (variant) {
    case 'table':
      return <TableSkeleton columns={columns} rows={rows} />
    case 'stats':
      return <StatsSkeleton count={statCount} />
    case 'spinner':
      return <SpinnerSkeleton />
    case 'list':
      return <ListSkeleton rows={rows} />
  }
}
