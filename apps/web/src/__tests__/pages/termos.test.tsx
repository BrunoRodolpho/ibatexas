// Unit tests for /termos page — verify all section headings render

import { describe, it, expect } from "vitest"

import TermosPage from "../../app/[locale]/termos/page"

/** Recursively collect all string content from a JSX tree. */
function collectText(node: unknown): string {
  if (node == null || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(collectText).join("")
  if (typeof node === "object" && node !== null && "props" in node) {
    const props = (node as { props?: { children?: unknown } }).props
    return collectText(props?.children)
  }
  return ""
}

describe("TermosPage", () => {
  it("renders all 4 section headings", () => {
    const tree = TermosPage()
    const text = collectText(tree)

    expect(text).toContain("Termos de Compra")
    expect(text).toContain("Política de Devolução e Reembolso")
    expect(text).toContain("Política de Entrega")
    expect(text).toContain("Política de Cancelamento de Reservas")
  })
})
