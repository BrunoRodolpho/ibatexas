import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Política de Privacidade | IbateXas',
  description: 'Política de privacidade e proteção de dados',
  openGraph: {
    title: 'Política de Privacidade | IbateXas',
    description: 'Como coletamos, usamos e protegemos seus dados pessoais',
  },
}

export default function PrivacidadeLayout({
  children,
}: {
  readonly children: React.ReactNode
}) {
  return children
}
