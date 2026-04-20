"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { Button, Heading, Text } from "@/components/atoms"

// Never expose raw error.message to users; log for Sentry capture instead
export default function ErrorPage({
  error,
  reset,
}: Readonly<{
  error: globalThis.Error & { digest?: string }
  reset: () => void
}>) {
  const t = useTranslations("common")

  useEffect(() => {
    console.error("[ErrorPage]", error)
  }, [error])

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <Heading as="h2" variant="h2" textColor="danger">
        {t("error.title", { fallback: "Algo deu errado" })}
      </Heading>
      <Text variant="small" textColor="muted" className="max-w-md">
        {t("error.generic", { fallback: "Ocorreu um erro inesperado. Tente novamente." })}
      </Text>
      <Button variant="primary" size="md" onClick={reset}>
        {t("error.retry", { fallback: "Tentar novamente" })}
      </Button>
    </div>
  )
}
