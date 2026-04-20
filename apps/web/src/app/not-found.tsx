import Link from "next/link"

export default function NotFound() {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "Inter, system-ui, sans-serif", margin: 0, backgroundColor: "#FAFAF9" }}>
        <div style={{ display: "flex", minHeight: "100vh", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "1rem", padding: "1rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "4rem", fontWeight: 700, color: "#1A1614", margin: 0 }}>
            404
          </h1>
          <h2 style={{ fontSize: "1.25rem", fontWeight: 600, color: "#1A1614", margin: 0 }}>
            Página não encontrada
          </h2>
          <p style={{ maxWidth: "28rem", fontSize: "0.875rem", color: "#706C64" }}>
            A página que você procura não existe ou foi movida.
          </p>
          <Link
            href="/pt-BR"
            style={{ borderRadius: "2px", backgroundColor: "#1A1614", padding: "0.5rem 1.5rem", fontSize: "0.875rem", fontWeight: 500, color: "#FAFAF9", textDecoration: "none", display: "inline-block" }}
          >
            Voltar ao início
          </Link>
        </div>
      </body>
    </html>
  )
}
