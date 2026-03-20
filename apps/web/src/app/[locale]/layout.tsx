import { NextIntlClientProvider } from "next-intl"
import { getMessages, getTranslations } from "next-intl/server"
import { notFound } from "next/navigation"
import { Inter, Playfair_Display } from "next/font/google"
import { routing } from "@/i18n/routing"
import { Header } from "@/components/Header"
import { Footer } from "@/components/Footer"
import { MobileBottomNav } from "@/components/molecules/MobileBottomNav"
import { ToastProvider } from "@/components/ToastProvider"
import { PostHogProvider } from "@/components/PostHogProvider"
import { ClientOverlays } from './ClientOverlays'

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["400", "500", "600"],
})

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
  weight: ["400", "500", "600", "700"],
})

export default async function LocaleLayout({
  children,
  params,
}: {
  readonly children: React.ReactNode
  readonly params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  // Validate locale
  if (!routing.locales.includes(locale as "pt-BR")) {
    notFound()
  }

  const messages = await getMessages()
  const t = await getTranslations('common')

  return (
    <html lang={locale}>
        <body className={`${inter.variable} ${playfair.variable} font-sans flex min-h-screen flex-col bg-smoke-50 text-charcoal-900 antialiased`}>
        <NextIntlClientProvider messages={messages}>
          <PostHogProvider>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-charcoal-900 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-smoke-50"
            >
              {t('skip_to_content')}
            </a>
            <Header />
            <main id="main-content" className="flex-1 pb-14 sm:pb-0">{children}</main>
            <Footer />
            <MobileBottomNav />
            <ClientOverlays />
            {/* WhatsApp floating button — z-35, above MobileBottomNav but below StickyCartBar */}
            {process.env.NEXT_PUBLIC_WHATSAPP_URL && (
              <a
                href={process.env.NEXT_PUBLIC_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="fixed bottom-20 sm:bottom-6 right-4 z-[35] w-12 h-12 rounded-full bg-accent-green shadow-lg flex items-center justify-center hover:bg-accent-green/90 transition-colors group"
                aria-label="Fale conosco pelo WhatsApp"
              >
                <svg viewBox="0 0 24 24" className="w-6 h-6 text-white fill-current">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                </svg>
                <span className="absolute right-full mr-2 px-2 py-1 text-xs text-white bg-charcoal-900 rounded-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  Fale conosco
                </span>
              </a>
            )}
            <ToastProvider />
          </PostHogProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
