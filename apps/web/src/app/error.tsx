"use client"

import { useEffect } from "react"

// AUDIT-FIX: FE-H2 — Never expose raw error.message to users; log for Sentry capture instead
export default function RootError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    console.error("[RootError]", error)
  }, [error])

  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        <div style={{ display: "flex", minHeight: "100vh", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", padding: "1rem", textAlign: "center" }}>
          <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#b91c1c" }}>
            Algo deu errado
          </h2>
          <p style={{ maxWidth: "28rem", fontSize: "0.875rem", color: "#78716c" }}>
            Ocorreu um erro inesperado. Tente novamente.
          </p>
          <button
            onClick={reset}
            style={{ borderRadius: "4px", backgroundColor: "#1c1917", padding: "0.5rem 1.5rem", fontSize: "0.875rem", fontWeight: 500, color: "#fafaf9", border: "none", cursor: "pointer" }}
          >
            Tentar novamente
          </button>
        </div>
      </body>
    </html>
  )
}
