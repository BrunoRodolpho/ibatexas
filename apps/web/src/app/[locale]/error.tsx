"use client"

import { useTranslations } from "next-intl"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations("common")

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-2xl font-bold text-red-600">
        {t("error.title", { fallback: "Algo deu errado" })}
      </h2>
      <p className="max-w-md text-sm text-gray-600">
        {error.message || t("error.generic", { fallback: "Erro inesperado. Tente novamente." })}
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-orange-600 px-6 py-2 text-sm font-medium text-white hover:bg-orange-700"
      >
        {t("error.retry", { fallback: "Tentar novamente" })}
      </button>
    </div>
  )
}
