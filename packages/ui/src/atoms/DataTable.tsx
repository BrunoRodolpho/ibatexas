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
} from '@tanstack/react-table'
import { useState } from 'react'
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
}

export function DataTable<T>({
  data,
  columns,
  pageSize = 20,
  isLoading = false,
  emptyMessage = 'Nenhum item encontrado.',
  onRowClick,
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
      <div className="w-full overflow-hidden rounded-sm border border-smoke-200 bg-smoke-50">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-smoke-100 bg-smoke-100/50">
              {columns.map((_, i) => (
                <th key={`skel-th-${i}`} className="px-4 py-2.5">
                  <div className="h-3 w-20 animate-pulse rounded bg-smoke-200" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={`skel-tr-${i}`} className="border-b border-smoke-100">
                {columns.map((_, j) => (
                  <td key={`skel-td-${i}-${j}`} className="px-4 py-2.5">
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

  return (
    <div className="w-full space-y-2">
      <div className="overflow-hidden rounded-sm border border-smoke-200 bg-smoke-50">
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
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-smoke-400"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-smoke-100 last:border-0 hover:bg-smoke-100/50 ${
                    onRowClick ? 'cursor-pointer' : ''
                  }`}
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

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between text-sm text-charcoal-700">
          <span>
            Página {table.getState().pagination.pageIndex + 1} de {table.getPageCount()}
            {' '}·{' '}
            {data.length} {data.length === 1 ? 'item' : 'itens'}
          </span>
          <div className="flex gap-2">
            <button
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Anterior
            </button>
            <button
              className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100 disabled:opacity-40"
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
