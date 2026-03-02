import { NextIntlClientProvider } from "next-intl"
import { getMessages } from "next-intl/server"
import { notFound } from "next/navigation"
import { Inter, Playfair_Display } from "next/font/google"
import { routing } from "@/i18n/routing"
import { Header } from "@/components/Header"
import { Footer } from "@/components/Footer"
import { MobileBottomNav } from "@/components/molecules/MobileBottomNav"
import { ChatWidget } from "@/components/ChatWidget"
import { ToastProvider } from "@/components/ToastProvider"

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

  return (
    <html lang={locale}>
        <body className={`${inter.variable} ${playfair.variable} font-sans flex min-h-screen flex-col bg-smoke-50 text-charcoal-900 antialiased`}>
        <NextIntlClientProvider messages={messages}>
          <Header />
          <main className="flex-1 pb-14 sm:pb-0">{children}</main>
          <Footer />
          <MobileBottomNav />
          <ChatWidget />
          <ToastProvider />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
