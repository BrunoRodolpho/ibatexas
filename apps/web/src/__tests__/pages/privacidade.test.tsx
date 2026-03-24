// Unit tests for /privacidade page — verify all section headings render

import { describe, it, expect, vi } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockUseConsentStore = vi.hoisted(() =>
  vi.fn((selector?: unknown) => {
    const state = {
      hasConsented: false,
      accepted: false,
      accept: vi.fn(),
      reject: vi.fn(),
      reset: vi.fn(),
    }
    return typeof selector === "function" ? (selector as (s: typeof state) => unknown)(state) : state
  }),
)

vi.mock("@/domains/consent", () => ({
  useConsentStore: mockUseConsentStore,
}))

vi.mock("@/components/atoms", () => ({
  Button: ({ children, ...props }: { children?: unknown; onClick?: unknown }) => ({
    type: "button",
    props: { ...props, children },
  }),
}))

// Minimal React mock for createElement/JSX
vi.mock("react", () => ({
  default: {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props: { ...((props as Record<string, unknown>) || {}), children },
    }),
  },
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...((props as Record<string, unknown>) || {}), children },
  }),
}))

import PrivacidadePage from "../../app/[locale]/privacidade/page"

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

describe("PrivacidadePage", () => {
  it("renders all 6 section headings", () => {
    const tree = PrivacidadePage()
    const text = collectText(tree)

    expect(text).toContain("Dados Coletados")
    expect(text).toContain("Uso dos Dados")
    expect(text).toContain("Retenção de Dados")
    expect(text).toContain("Seus Direitos")
    expect(text).toContain("Contato")
    expect(text).toContain("Preferências de Cookies")
  })
})
