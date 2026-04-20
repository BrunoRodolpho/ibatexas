import type { Metadata } from 'next'
import CheckoutContent from './CheckoutContent'

interface PageProps {
  readonly params: Promise<{ locale: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params

  return {
    title: 'Checkout | IbateXas',
    robots: { index: false },
    alternates: {
      canonical: `https://ibatexas.com.br/${locale}/checkout`,
      languages: { 'pt-BR': '/pt-BR/checkout' },
    },
  }
}

export default function CheckoutPage() {
  return <CheckoutContent />
}
