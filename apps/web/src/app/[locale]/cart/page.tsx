import type { Metadata } from 'next'
import CartContent from './CartContent'

interface PageProps {
  readonly params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params

  return {
    title: 'Carrinho | IbateXas',
    robots: { index: false },
    alternates: {
      canonical: `https://ibatexas.com.br/${locale}/cart`,
      languages: { 'pt-BR': '/pt-BR/cart' },
    },
  }
}

export default function CartPage() {
  return <CartContent />
}
