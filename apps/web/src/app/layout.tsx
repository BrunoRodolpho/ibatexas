import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "IbateXas",
  description: "Churrascaria e restaurante em Ibaté, SP",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return children
}
