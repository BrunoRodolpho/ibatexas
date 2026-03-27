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
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:bg-charcoal-900 focus:text-smoke-50 focus:px-4 focus:py-2 focus:rounded-sm focus:text-sm"
        >
          Ir para o conteúdo principal
        </a>
        {children}
      </body>
    </html>
  )
}
