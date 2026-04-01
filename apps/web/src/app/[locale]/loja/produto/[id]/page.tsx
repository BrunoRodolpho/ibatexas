import { Suspense } from 'react'
import type { Metadata } from 'next'
import PDPContent from './PDPContent'
import { JsonLd } from '@/components/atoms'

/** ISR: revalidate product pages every 60s — keeps SEO content fresh */
export const revalidate = 60

interface ProductPageProps {
  readonly params: Promise<{ id: string; locale: string }>
}

// ── SSR metadata for SEO ────────────────────────────────────────────────
export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  try {
    const { id } = await params
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
    const res = await fetch(`${apiBase}/api/products/${id}`, { next: { revalidate: 60 } })
    if (!res.ok) return { title: 'Produto | IbateXas' }
    const product = await res.json()
    const fallbackImages = product.imageUrl ? [product.imageUrl] : []
    const ogImages = product.images?.length ? [product.images[0]] : fallbackImages
    return {
      title: `${product.title} | IbateXas`,
      description: product.description || `${product.title} — Churrasco defumado artesanal`,
      openGraph: {
        title: `${product.title} | IbateXas`,
        description: product.description || `${product.title} — Churrasco defumado artesanal`,
        images: ogImages,
      },
    }
  } catch {
    return { title: 'Produto | IbateXas' }
  }
}

// ── PDP Skeleton for Suspense boundary ───────────────────────────────────
function PDPSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6">
      <div className="mb-6 flex gap-2">
        <div className="h-3 w-12 rounded-sm skeleton" />
        <div className="h-3 w-4 rounded-sm skeleton" />
        <div className="h-3 w-32 rounded-sm skeleton" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        <div className="aspect-square rounded-sm skeleton" />
        <div className="space-y-6">
          <div className="h-8 w-3/4 rounded-sm skeleton" />
          <div className="h-6 w-1/4 rounded-sm skeleton" />
          <div className="h-12 w-full rounded-sm skeleton" />
        </div>
      </div>
    </div>
  )
}

// ── Server Component wrapper ─────────────────────────────────────────────
export default async function ProductPage({ params }: ProductPageProps) {
  const { id } = await params

  // Fetch product for JSON-LD (Next.js deduplicates with generateMetadata fetch)
  let productJsonLd: Record<string, unknown> | null = null
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
    const res = await fetch(`${apiBase}/api/products/${id}`, { next: { revalidate: 60 } })
    if (res.ok) {
      const product = await res.json()
      const image = product.images?.[0] || product.imageUrl || undefined
      productJsonLd = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.title,
        description: product.description || `${product.title} — Churrasco defumado artesanal`,
        ...(image ? { image } : {}),
        offers: {
          '@type': 'Offer',
          price: (product.price ?? 0) / 100,
          priceCurrency: 'BRL',
          availability: 'https://schema.org/InStock',
        },
      }
    }
  } catch {
    // JSON-LD is non-critical — page renders without it
  }

  return (
    <>
      {productJsonLd && <JsonLd data={productJsonLd} />}
      <Suspense fallback={<PDPSkeleton />}>
        <PDPContent productId={id} />
      </Suspense>
    </>
  )
}
