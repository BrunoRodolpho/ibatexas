import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'IbateXas Admin',
  description: 'Painel de administração — IbateXas',
}

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="bg-smoke-50 text-charcoal-900 antialiased">
        {children}
      </body>
    </html>
  )
}
