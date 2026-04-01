'use client'

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type Header,
  type Row,
} from '@tanstack/react-table'
import React, { useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'

// ── Sub-component: sort icon for column header ──────────────────────────────

function SortIcon({ direction }: Readonly<{ direction: false | 'asc' | 'desc' }>) {
  if (direction === 'asc') return <ChevronUp className="h-3 w-3" />
  if (direction === 'desc') return <ChevronDown className="h-3 w-3" />
  return <ChevronsUpDown className="h-3 w-3" />
}

// ── Sub-component: sortable column header ───────────────────────────────────

function SortableHeader<T>({ header }: Readonly<{ header: Header<T, unknown> }>) {
  if (header.isPlaceholder) return null

  const rendered = flexRender(header.column.columnDef.header, header.getContext())

  if (!header.column.getCanSort()) {
    return <div className="flex items-center gap-1">{rendered}</div>
  }

  return (
    <button
      type="button"
      className="flex cursor-pointer select-none items-center gap-1 hover:text-charcoal-900"
      onClick={header.column.getToggleSortingHandler()}
    >
      {rendered}
      <span className="text-smoke-300">
        <SortIcon direction={header.column.getIsSorted()} />
      </span>
    </button>
  )
}

interface DataTableProps<T> {
  readonly data: T[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TanStack Table requires `any` for mixed-value column arrays
  readonly columns: ColumnDef<T, any>[]
  readonly pageSize?: number
  readonly isLoading?: boolean
  readonly emptyMessage?: string
  readonly onRowClick?: (row: T) => void
  readonly rowClassName?: (row: T) => string | undefined
  /**
   * Custom renderer for mobile card layout (<768px).
   * When provided, each row renders using this function instead of the auto-generated card.
   * Recommended when the table has more than 4 columns, since auto-generated cards
   * may become too tall or show low-value fields on small screens.
   */
  readonly mobileCardRenderer?: (row: Row<T>) => React.ReactNode
}

export function DataTable<T>({
  data,
  columns,
  pageSize = 20,
  isLoading = false,
  emptyMessage = 'Nenhum item encontrado.',
  onRowClick,
  rowClassName,
  mobileCardRenderer,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  })

  const table = useReactTable({
    data,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: false,
  })

  if (isLoading) {
    return (
      <div className="w-full overflow-x-auto rounded-sm border border-smoke-200 bg-smoke-50">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-smoke-100 bg-smoke-100/50">
              {columns.map((col) => (
                <th key={`skel-th-${col.id ?? String(col.header)}`} className="px-4 py-2.5">
                  <div className="h-3 w-20 animate-pulse rounded bg-smoke-200" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {['skel-row-0', 'skel-row-1', 'skel-row-2', 'skel-row-3', 'skel-row-4'].map((rowKey) => (
              <tr key={rowKey} className="border-b border-smoke-100">
                {columns.map((col) => (
                  <td key={`${rowKey}-${col.id ?? String(col.header)}`} className="px-4 py-2.5">
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

  const rows = table.getRowModel().rows
  const isEmpty = rows.length === 0

  return (
    <div className="w-full space-y-2">
      {/* ── Desktop table (md+) ──────────────────────────────────────────── */}
      <div className="hidden overflow-x-auto rounded-sm border border-smoke-200 bg-smoke-50 md:block">
        <table className="w-full text-[13px]">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-smoke-100 bg-smoke-100/50">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-2.5 text-left text-[10px] uppercase tracking-wider font-medium text-smoke-400"
                  >
                    <SortableHeader header={header} />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {isEmpty ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-smoke-400"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-smoke-100 last:border-0 hover:bg-smoke-100/50 ${
                    onRowClick ? 'cursor-pointer' : ''
                  } ${rowClassName?.(row.original) ?? ''}`}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={() => onRowClick?.(row.original)}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row.original) } } : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-2.5 text-charcoal-700">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Mobile card layout (<md) ─────────────────────────────────────── */}
      <div className="space-y-3 md:hidden">
        {isEmpty ? (
          <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
            {emptyMessage}
          </div>
        ) : (
          rows.map((row) => {
            const cardProps = onRowClick
              ? {
                  role: 'button' as const,
                  tabIndex: 0,
                  onClick: () => onRowClick(row.original),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onRowClick(row.original)
                    }
                  },
                }
              : {}

            return (
              <div
                key={row.id}
                className={`border border-smoke-200 rounded-sm p-4 space-y-2 bg-smoke-50 text-[13px] ${
                  onRowClick ? 'cursor-pointer hover:bg-smoke-100/50' : ''
                } ${rowClassName?.(row.original) ?? ''}`}
                {...cardProps}
              >
                {mobileCardRenderer
                  ? mobileCardRenderer(row)
                  : row.getVisibleCells().map((cell) => {
                      const headerValue = cell.column.columnDef.header
                      const label =
                        typeof headerValue === 'string' ? headerValue : cell.column.id
                      return (
                        <div key={cell.id} className="flex flex-col gap-0.5">
                          <span className="text-[10px] uppercase tracking-wider font-medium text-smoke-400">
                            {label}
                          </span>
                          <span className="text-charcoal-700">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </span>
                        </div>
                      )
                    })}
              </div>
            )
          })
        )}
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {table.getPageCount() > 1 && (
        <div className="flex flex-col items-center gap-2 text-sm text-charcoal-700 md:flex-row md:justify-between">
          <span>
            Página {table.getState().pagination.pageIndex + 1} de {table.getPageCount()}
            {' '}·{' '}
            {data.length} {data.length === 1 ? 'item' : 'itens'}
          </span>
          <div className="flex w-full gap-2 md:w-auto">
            <button
              className="flex-1 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40 md:flex-none"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Anterior
            </button>
            <button
              className="flex-1 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40 md:flex-none"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Próximo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
