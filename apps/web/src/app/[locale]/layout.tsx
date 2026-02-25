import { NextIntlClientProvider } from "next-intl"
import { getMessages } from "next-intl/server"
import { notFound } from "next/navigation"
import { Inter, Outfit } from "next/font/google"
import { routing } from "@/i18n/routing"
import { Header } from "@/components/Header"
import { Footer } from "@/components/Footer"
import { ChatWidget } from "@/components/ChatWidget"
import { ToastProvider } from "@/components/ToastProvider"

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
  weight: ["400", "500", "600"],
})

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
  weight: ["600", "700", "800"],
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
      <body className={`${inter.variable} ${outfit.variable} flex min-h-screen flex-col bg-white`}>
        <NextIntlClientProvider messages={messages}>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
          <ChatWidget />
          <ToastProvider />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
