import type { Metadata } from 'next'
import ShopLayoutContent from './ShopLayoutContent'

export const metadata: Metadata = {
  title: 'Loja | IbateXas',
  description: 'Descubra nossa coleção de camisetas, bonés e acessórios exclusivos IbateXas.',
  alternates: {
    canonical: 'https://ibatexas.com.br/pt-BR/loja',
    languages: { 'pt-BR': '/pt-BR/loja' },
  },
}

interface ShopLayoutProps {
  readonly children: React.ReactNode
}

export default function ShopLayout({ children }: ShopLayoutProps) {
  return <ShopLayoutContent>{children}</ShopLayoutContent>
}
