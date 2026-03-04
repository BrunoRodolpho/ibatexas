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
import dynamic from "next/dynamic"

const CartDrawer = dynamic(() => import("@/components/organisms/CartDrawer").then(m => m.CartDrawer), { ssr: false })
const ChatWidget = dynamic(() => import("@/components/ChatWidget").then(m => m.ChatWidget), { ssr: false })

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
  children: React.ReactNode
  params: { locale: string }
}) {
  const { locale } = params

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
            <CartDrawer />
            <ChatWidget />
            <ToastProvider />
          </PostHogProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
