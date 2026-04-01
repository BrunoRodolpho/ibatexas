import type { Metadata } from 'next'
import { Suspense } from 'react'
import SearchContent from './SearchContent'
import SearchLoading from './loading'

interface PageProps {
  readonly params: Promise<{ locale: string }>
  readonly searchParams: Promise<{ q?: string }>
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale } = await params
  const { q } = await searchParams
  const query = q?.trim()

  const title = query ? `Busca: ${query} | IbateXas` : 'Busca | IbateXas'
  const description = query
    ? `Resultados para ${query} em carnes defumadas artesanais`
    : 'Busque em nosso cardápio de carnes defumadas artesanais'
  const canonicalUrl = query
    ? `https://ibatexas.com.br/${locale}/search?q=${encodeURIComponent(query)}`
    : `https://ibatexas.com.br/${locale}/search`

  return {
    title,
    description,
    robots: { index: false },
    alternates: {
      canonical: canonicalUrl,
      languages: { 'pt-BR': '/pt-BR/search' },
    },
  }
}

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchLoading />}>
      <SearchContent />
    </Suspense>
  )
}
