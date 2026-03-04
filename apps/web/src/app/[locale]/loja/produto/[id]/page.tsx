import { Suspense } from 'react'
import type { Metadata } from 'next'
import { Skeleton } from '@/components/atoms/Skeleton'
import PDPContent from './PDPContent'
import { getApiBase } from '@/lib/api'

interface ProductPageProps {
  params: { id: string; locale: string }
}

// ── SSR metadata for SEO ────────────────────────────────────────────────
export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
    const res = await fetch(`${apiBase}/api/products/${params.id}`, { next: { revalidate: 60 } })
    if (!res.ok) return { title: 'Produto | IbateXas' }
    const product = await res.json()
    return {
      title: `${product.title} | IbateXas`,
      description: product.description || `${product.title} — Churrasco defumado artesanal`,
      openGraph: {
        title: `${product.title} | IbateXas`,
        description: product.description || `${product.title} — Churrasco defumado artesanal`,
        images: product.images?.length ? [product.images[0]] : product.imageUrl ? [product.imageUrl] : [],
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
export default function ProductPage({ params }: ProductPageProps) {
  return (
    <Suspense fallback={<PDPSkeleton />}>
      <PDPContent productId={params.id} />
    </Suspense>
  )
}
