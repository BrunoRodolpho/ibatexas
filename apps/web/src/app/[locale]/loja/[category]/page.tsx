import type { Metadata } from 'next'
import CategoryContent from './CategoryContent'

interface PageProps {
  readonly params: Promise<{ locale: string; category: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, category } = await params
  const title = category
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  return {
    title: `${title} | IbateXas`,
    description: `Confira nossa seleção de ${title.toLowerCase()} — carnes defumadas artesanais com qualidade premium.`,
    alternates: {
      canonical: `https://ibatexas.com.br/${locale}/loja/${category}`,
      languages: { 'pt-BR': `/pt-BR/loja/${category}` },
    },
  }
}

export default async function CategoryPage({ params }: PageProps) {
  const { category } = await params
  return <CategoryContent category={category} />
}
