"use client"

export default function AdminError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-2xl font-bold text-accent-red">Erro no painel admin</h2>
      <p className="max-w-md text-sm text-smoke-600">
        {error.message || "Erro inesperado. Tente novamente."}
      </p>
      <button
        onClick={reset}
        className="rounded-lg bg-brand-600 px-6 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Tentar novamente
      </button>
    </div>
  )
}
