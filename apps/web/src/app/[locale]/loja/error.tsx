"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"

// AUDIT-FIX: FE-H2 — Never expose raw error.message to users; log for Sentry capture instead
// AUDIT-FIX: FE-L1 — Use useTranslations instead of hardcoded strings
export default function LojaError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  const t = useTranslations("common")

  useEffect(() => {
    console.error("[LojaError]", error)
  }, [error])

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-2xl font-bold text-accent-red">
        {t("error.shop_title", { fallback: "Erro na loja" })}
      </h2>
      <p className="max-w-md text-sm text-smoke-400">
        {t("error.generic", { fallback: "Ocorreu um erro inesperado. Tente novamente." })}
      </p>
      <button
        onClick={reset}
        className="rounded-sm bg-charcoal-900 px-6 py-2 text-sm font-medium text-smoke-50 hover:bg-charcoal-800 transition-all duration-500"
      >
        {t("error.retry", { fallback: "Tentar novamente" })}
      </button>
    </div>
  )
}
