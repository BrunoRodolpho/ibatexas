'use client'

import type { ComponentType, ReactNode } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { ExternalLink, Package, Layers, ShoppingBag } from 'lucide-react'
import { DataTable } from '../atoms/DataTable'
import { Switch } from '../atoms/Switch'
import { PageHeader } from '../atoms/PageHeader'
import { ErrorBanner } from '../atoms/ErrorBanner'
import { PageShell } from '../layouts/PageShell'
import { FilterBar } from '../molecules/FilterBar'
import type { AdminProductRow, AdminProductDetail } from '@ibatexas/types'
import {
  STOCK_LABELS,
  PRODUCT_COLUMN_HEADERS,
  PAGE_TITLES,
  ACTION_LABELS,
  SEARCH_PLACEHOLDERS,
  EMPTY_STATES,
  MISC_LABELS,
} from '../constants/admin-labels'

const col = createColumnHelper<AdminProductRow>()

function formatBRL(centavos: number) {
  if (!centavos) return '\u2014'
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function renderShopImage(
  url: string | null,
  ImageComponent?: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ComponentType<any>,
) {
  if (!url) return <div className="h-10 w-10 rounded-sm bg-smoke-100" />
  if (ImageComponent) {
    return <ImageComponent src={url} alt="" className="h-10 w-10 rounded-sm object-cover" width={40} height={40} unoptimized />
  }
  return <img src={url} alt="" className="h-10 w-10 rounded-sm object-cover" width={40} height={40} />
}

function renderStockSwitch(product: AdminProductRow, onToggle: (p: AdminProductRow) => void) {
  return (
    <Switch
      checked={product.inStock}
      onChange={() => onToggle(product)}
      size="sm"
      label={product.inStock ? STOCK_LABELS.inStock : STOCK_LABELS.outOfStock}
    />
  )
}

function renderStatusSwitch(product: AdminProductRow, onToggle: (p: AdminProductRow) => void) {
  return (
    <Switch
      checked={product.status === 'published'}
      onChange={() => onToggle(product)}
      size="sm"
    />
  )
}

function renderDetailImage(
  imageUrl: string | null | undefined,
  title: string,
  ImageComponent?: ComponentType<Record<string, unknown>>,
) {
  if (!imageUrl) {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-sm bg-smoke-100">
        <Package className="h-6 w-6 text-[var(--color-text-muted)]" />
      </div>
    )
  }
  if (ImageComponent) {
    return (
      <ImageComponent
        src={imageUrl}
        alt={title}
        className="h-14 w-14 shrink-0 rounded-sm object-cover"
        width={56}
        height={56}
        unoptimized
      />
    )
  }
  return (
    <img
      src={imageUrl}
      alt={title}
      className="h-14 w-14 shrink-0 rounded-sm object-cover"
      width={56}
      height={56}
    />
  )
}

function renderShopActions(productId: string, onSelect: (id: string) => void, medusaAdminUrl: string) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(productId) }}
        className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-800 font-medium"
      >
        <Layers className="h-3 w-3" />
        {ACTION_LABELS.variants}
      </button>
      <a
        href={`${medusaAdminUrl}/app/products/${productId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-charcoal-800"
        onClick={(e) => e.stopPropagation()}
      >
        {ACTION_LABELS.edit}
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}

export interface AdminLojaPageProps {
  data: AdminProductRow[]
  loading: boolean
  error: Error | null
  selectedId: string | null
  onSelectId: (id: string | null) => void
  productDetail: AdminProductDetail | null
  detailLoading: boolean
  medusaAdminUrl: string
  onSearch: (q: string) => void
  onToggleStatus: (product: AdminProductRow) => void
  onToggleStock: (product: AdminProductRow) => void
  SearchInputComponent: ComponentType<{ onSearch: (q: string) => void; placeholder?: string }>
  SheetComponent: ComponentType<{ isOpen: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }>
  ImageComponent?: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ComponentType<any>
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export function AdminLojaPage({
  data,
  loading,
  error,
  selectedId,
  onSelectId,
  productDetail,
  detailLoading,
  medusaAdminUrl,
  onSearch,
  onToggleStatus,
  onToggleStock,
  SearchInputComponent,
  SheetComponent,
  ImageComponent,
}: Readonly<AdminLojaPageProps>) {
  const columns = [
    col.accessor('imageUrl', {
      header: '',
      enableSorting: false,
      cell: (i) => renderShopImage(i.getValue() as string | null, ImageComponent),
    }),
    col.accessor('title', { header: PRODUCT_COLUMN_HEADERS.name }),
    col.accessor('category', { header: PRODUCT_COLUMN_HEADERS.category }),
    col.accessor('variantCount', {
      header: PRODUCT_COLUMN_HEADERS.variants,
      cell: (i) => MISC_LABELS.sizeCount(i.getValue() as number),
    }),
    col.accessor('inStock', {
      header: PRODUCT_COLUMN_HEADERS.stock,
      cell: (i) => renderStockSwitch(i.row.original, onToggleStock),
    }),
    col.accessor('status', {
      header: PRODUCT_COLUMN_HEADERS.status,
      cell: (i) => renderStatusSwitch(i.row.original, onToggleStatus),
    }),
    col.display({
      id: 'actions',
      header: '',
      cell: (i) => renderShopActions(i.row.original.id, onSelectId, medusaAdminUrl),
    }),
  ]

  return (
    <PageShell>
      <PageHeader
        icon={ShoppingBag}
        title={PAGE_TITLES.shop}
        subtitle={PAGE_TITLES.shopSubtitle}
        action={
          <a
            href={`${medusaAdminUrl}/app/products/create`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-sm bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            {ACTION_LABELS.addProduct}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        }
      />

      <FilterBar>
        <SearchInputComponent
          onSearch={onSearch}
          placeholder={SEARCH_PLACEHOLDERS.products}
        />
      </FilterBar>

      {error && (
        <ErrorBanner message={`${MISC_LABELS.errorPrefix} ${error.message}`} />
      )}

      <DataTable
        data={data}
        columns={columns}
        isLoading={loading}
        emptyMessage={EMPTY_STATES.products}
        pageSize={25}
      />

      <SheetComponent
        isOpen={!!selectedId}
        title={productDetail?.title ?? ACTION_LABELS.variants}
        onClose={() => onSelectId(null)}
        footer={
          selectedId ? (
            <a
              href={`${medusaAdminUrl}/app/products/${selectedId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 w-full rounded-sm border border-smoke-200 px-4 py-2 text-sm font-medium text-charcoal-700 hover:bg-smoke-100"
            >
              {ACTION_LABELS.editInMedusa}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : undefined
        }
      >
        {detailLoading && (
          <div className="space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-14 animate-pulse rounded-sm bg-smoke-100" />
            ))}
          </div>
        )}
        {!detailLoading && productDetail && (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              {renderDetailImage(productDetail.imageUrl, productDetail.title, ImageComponent)}
              <div className="min-w-0">
                <p className="font-semibold text-charcoal-900">{productDetail.title}</p>
                <p className="text-xs text-[var(--color-text-secondary)]">{productDetail.category}</p>
                {productDetail.description && (
                  <p className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-2">{productDetail.description}</p>
                )}
              </div>
            </div>

            {productDetail.variants.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)] text-center py-4">{EMPTY_STATES.variants}</p>
            ) : (
              <div className="space-y-1.5">
                {productDetail.variants.map((v) => (
                  <div key={v.id} className="flex items-center justify-between rounded-sm border border-smoke-200 px-3 py-2.5 hover:bg-smoke-50 transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-charcoal-900">{v.title}</p>
                      {v.sku && <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{v.sku}</p>}
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-medium text-charcoal-800 tabular-nums">{formatBRL(v.price)}</span>
                      {v.manageInventory ? (
                        <span className={`text-xs font-medium tabular-nums ${v.inventoryQuantity > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                          {v.inventoryQuantity} un.
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-text-muted)]">{'\u221E'}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {productDetail.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {productDetail.tags.map((tag) => (
                  <span key={tag} className="rounded-sm bg-smoke-100 px-2.5 py-0.5 text-xs text-charcoal-700">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </SheetComponent>
    </PageShell>
  )
}
