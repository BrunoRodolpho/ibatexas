'use client'

import { useEffect, useMemo, useState } from 'react'
import NextImage from 'next/image'
import { useTranslations } from 'next-intl'
import { Heart, Plus, ShoppingBag } from 'lucide-react'

import { useWishlistStore } from '@/domains/wishlist'
import { useProducts } from '@/domains/product'
import { useCartStore } from '@/domains/cart'
import { useUIStore } from '@/domains/ui'
import { useRecommendations, type RecommendedProduct } from '@/domains/recommendations'
import { track } from '@/domains/analytics'
import { ProductGrid } from '@/components/organisms'
import { ProductGridSkeleton } from '@/components/molecules/ProductGridSkeleton'
import { Button, Container } from '@/components/atoms'
import { Link } from '@/i18n/navigation'
import { formatBRL } from '@/lib/format'
import type { ProductDTO } from '@ibatexas/types'

type SortOption = 'recent' | 'oldest' | 'price-asc' | 'price-desc' | 'alpha'

const SORT_LABELS: Record<SortOption, string> = {
  recent: 'Mais recentes',
  oldest: 'Mais antigos',
  'price-asc': 'Menor preço',
  'price-desc': 'Maior preço',
  alpha: 'A → Z',
}

export default function WishlistPage() {
  const t = useTranslations()
  const wishlistItems = useWishlistStore((s) => s.items)
  // Wait for Zustand persist to rehydrate before deciding empty vs filled —
  // see Phase 2.A8. Without this guard the empty state flashed on first paint.
  const hasHydrated = useWishlistStore((s) => s._hydrated)

  const addToCart = useCartStore((s) => s.addItem)
  const addToast = useUIStore((s) => s.addToast)

  // Match HomeFavorites' proven-working query (limit 100). Diverging to 200
  // caused matching to silently return zero results — Typesense returned a
  // different scored slice that didn't include the favorited product IDs.
  const { data, loading } = useProducts({ limit: 100 })
  const items = data?.items

  const [sort, setSort] = useState<SortOption>('recent')

  const wishlistProducts = useMemo(() => {
    if (!items || wishlistItems.length === 0) return []
    // Use the wishlist's array order as the chronological source — toggle()
    // pushes new items to the end of the array, so the array order IS the
    // add-time ordering. Index = age (lower = older).
    const matched = wishlistItems
      .map((id, addedIndex) => {
        const product = items.find((p) => p.id === id)
        return product ? { product, addedIndex } : null
      })
      .filter((x): x is { product: NonNullable<typeof items>[number]; addedIndex: number } => x !== null)

    const sorted = [...matched]
    switch (sort) {
      case 'recent':
        sorted.sort((a, b) => b.addedIndex - a.addedIndex)
        break
      case 'oldest':
        sorted.sort((a, b) => a.addedIndex - b.addedIndex)
        break
      case 'price-asc':
        sorted.sort((a, b) => a.product.price - b.product.price)
        break
      case 'price-desc':
        sorted.sort((a, b) => b.product.price - a.product.price)
        break
      case 'alpha':
        sorted.sort((a, b) => a.product.title.localeCompare(b.product.title, 'pt-BR'))
        break
    }
    return sorted.map((x) => x.product)
  }, [items, wishlistItems, sort])

  // Development-only diagnostic — fires if hydration is done, the user has
  // favorites, the product fetch resolved, but matching returned nothing.
  // This is the exact failure mode the empty-state regression had.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      if (hasHydrated && !loading && wishlistItems.length > 0 && wishlistProducts.length === 0) {
        console.warn(
          '[lista-desejos] wishlist has items but none matched the product fetch',
          { wishlistCount: wishlistItems.length, fetchedCount: items?.length ?? 0 },
        )
      }
    }
  }, [hasHydrated, loading, wishlistItems.length, wishlistProducts.length, items])

  const handleAddToCart = (productId: string) => {
    const product = wishlistProducts.find((p) => p.id === productId)
    if (!product) return
    const defaultVariant = product.variants?.[0]
    addToCart(product, 1, undefined, defaultVariant)
    track('add_to_cart', { productId, source: 'wishlist' })
    addToast(t('toast.added_to_cart'), 'cart')
  }

  const handleAddAll = () => {
    let added = 0
    for (const product of wishlistProducts) {
      const defaultVariant = product.variants?.[0]
      addToCart(product, 1, undefined, defaultVariant)
      added += 1
    }
    if (added > 0) {
      track('add_to_cart', { productId: 'wishlist_bulk', source: 'wishlist_bulk' })
      addToast(`${added} ${added === 1 ? 'item adicionado' : 'itens adicionados'} ao carrinho`, 'cart')
    }
  }

  // Pre-hydration: render skeleton instead of either branch.
  if (!hasHydrated) {
    return (
      <Container size="xl" className="min-h-screen bg-smoke-50 py-16 lg:py-24">
        <h1 className="text-3xl font-display text-charcoal-900">
          {t('wishlist.title')}
        </h1>
        <div className="mt-8">
          <ProductGridSkeleton columns={4} />
        </div>
      </Container>
    )
  }

  // Empty state — only after hydration so we trust wishlistItems.length
  if (wishlistItems.length === 0) {
    return <EmptyWishlist />
  }

  return (
    <Container size="xl" className="min-h-screen bg-smoke-50 py-16 lg:py-24">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-display text-charcoal-900">
            {t('wishlist.title')}
            <span className="ml-3 text-base font-normal text-smoke-500 tabular-nums">
              · {wishlistItems.length}
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Sort selector — native <select> for simplicity. Replaceable with
              a styled dropdown later if needed. */}
          <label className="flex items-center gap-2 text-xs uppercase tracking-editorial text-smoke-500">
            <span>Ordenar</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortOption)}
              className="bg-smoke-50 border border-smoke-200 rounded-sm px-2 py-1 text-xs text-charcoal-900 focus:outline-none focus:border-charcoal-700 transition-colors"
            >
              {(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleAddAll}
            disabled={loading || wishlistProducts.length === 0}
          >
            <ShoppingBag className="w-4 h-4" strokeWidth={1.75} />
            Adicionar todos
          </Button>
        </div>
      </div>

      <div className="mt-8">
        <ProductGrid
          products={wishlistProducts}
          columns={4}
          isLoading={loading}
          onAddToCart={handleAddToCart}
          getProductHref={(p) => `/loja/produto/${p.id}`}
        />
      </div>
    </Container>
  )
}

/* ─────────────────────────────────────────────────────────────────────
   Empty state — recommends products instead of just sending the user away
   ───────────────────────────────────────────────────────────────────── */

function EmptyWishlist() {
  const t = useTranslations()
  const { data: recommendations, loading } = useRecommendations(6)
  const addItem = useCartStore((s) => s.addItem)
  const addToast = useUIStore((s) => s.addToast)

  const handleQuickAdd = (rec: RecommendedProduct) => {
    const minimal = {
      id: rec.id,
      title: rec.title,
      price: rec.price,
      imageUrl: rec.imageUrl ?? null,
      variants: [],
    } as unknown as ProductDTO
    addItem(minimal, 1)
    track('add_to_cart', { productId: rec.id, source: 'wishlist_empty_recs' })
    addToast(t('toast.added_to_cart'), 'cart')
  }

  return (
    <Container size="xl" className="min-h-screen bg-smoke-50 py-16 lg:py-24">
      <h1 className="text-3xl font-display text-charcoal-900">
        {t('wishlist.title')}
      </h1>

      <div className="mt-12 flex flex-col items-center justify-center gap-4 text-center">
        <Heart className="w-12 h-12 text-smoke-200" strokeWidth={1.5} />
        <p className="text-lg text-smoke-400">
          Nenhum item na sua lista de desejos
        </p>
        <p className="text-sm text-smoke-500 max-w-md">
          Toque no coração de qualquer produto para guardá-lo aqui.
        </p>
        <Link
          href="/loja"
          className="mt-2 text-sm font-medium text-charcoal-700 hover:text-charcoal-900 transition-colors duration-300"
        >
          {t('cart.continue_shopping')} →
        </Link>
      </div>

      {/* Recommendation strip — only render when we actually have data so an
          empty wishlist doesn't show two layers of "nothing here" UX. */}
      {!loading && recommendations.length > 0 && (
        <div className="mt-16">
          <p className="text-xs font-semibold uppercase tracking-editorial text-smoke-500 mb-4">
            Talvez você goste
          </p>
          <div className="flex gap-4 overflow-x-auto scrollbar-hide snap-x snap-mandatory -mx-4 px-4">
            {recommendations.map((rec) => (
              <div
                key={rec.id}
                className="snap-start flex-shrink-0 w-[172px] surface-card rounded-card overflow-hidden flex flex-col"
              >
                <Link
                  href={`/loja/produto/${rec.id}`}
                  className="relative aspect-square bg-smoke-100 block"
                >
                  {rec.imageUrl && (
                    <NextImage
                      src={rec.imageUrl}
                      alt={rec.title}
                      fill
                      sizes="172px"
                      className="object-cover"
                    />
                  )}
                </Link>
                <div className="p-3 flex flex-col flex-1">
                  <p className="text-xs font-medium text-charcoal-900 leading-snug line-clamp-2 min-h-[2.25rem]">
                    {rec.title}
                  </p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-charcoal-900 tabular-nums">
                      {formatBRL(rec.price)}
                    </span>
                    <button
                      onClick={() => handleQuickAdd(rec)}
                      className="w-7 h-7 flex items-center justify-center rounded-full bg-brand-500 text-white hover:bg-brand-600 active:scale-95 transition-all duration-300 ease-luxury"
                      aria-label={`Adicionar ${rec.title}`}
                    >
                      <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Container>
  )
}
