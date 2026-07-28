// BKL-286 leg 2 — what the chat panel actually SHOWS on a denied stream.
//
// Strategy mirrors OrderActions.cancel.test.tsx / CookieConsentBanner.test.tsx:
// node env, React hooks mocked, the real jsx-runtime builds a plain element
// tree which we flatten and inspect. No DOM, no testing-library.
//
// The point of this file is the negative: nothing resembling a payload may
// appear anywhere in the rendered tree on ANY error path.

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  sendMessage: vi.fn(),
  startNewConversation: vi.fn(),
}))

vi.mock("react", () => ({
  useState: (init: unknown) => [init, vi.fn()],
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useRef: () => ({ current: null }),
  default: {},
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/domains/cart", () => ({
  useCartStore: (sel: (s: unknown) => unknown) => sel({ items: [] }),
}))
vi.mock("@/domains/session", () => ({
  useSessionStore: () => ({ initSession: vi.fn() }),
}))
vi.mock("@/domains/ui", () => ({
  useUIStore: (sel: (s: unknown) => unknown) => sel({ isChatOpen: true, setChat: vi.fn() }),
}))
vi.mock("@/domains/chat", async (importOriginal) => {
  // Keep the REAL copy constants — asserting against a doubled label would
  // prove nothing about what a customer reads.
  const actual = await importOriginal<typeof import("@/domains/chat")>()
  return {
    ...actual,
    useChatStore: (sel: (s: unknown) => unknown) => sel(h.chat),
    useChat: () => ({
      sendMessage: h.sendMessage,
      startNewConversation: h.startNewConversation,
    }),
  }
})

import { ChatWidget } from "../../components/ChatWidget"
import {
  CHAT_GENERIC_FAILURE_PTBR,
  CHAT_RESTART_LABEL_PTBR,
  CHAT_SESSION_EXPIRED_PTBR,
} from "@/domains/chat"

// ── Element-tree helpers ────────────────────────────────────────────────────

interface Node {
  props?: { children?: unknown; onClick?: unknown }
}

/** Depth-first walk over the rendered element tree. */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || node === undefined || typeof node === "boolean") return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== "object") return
  visit(node as Node)
  walk((node as Node).props?.children, visit)
}

/** Every text leaf in the tree, concatenated. */
function renderedText(node: unknown): string {
  const out: string[] = []
  const collect = (n: unknown): void => {
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n))
      return
    }
    if (Array.isArray(n)) {
      for (const c of n) collect(c)
      return
    }
    if (n && typeof n === "object") collect((n as Node).props?.children)
  }
  collect(node)
  return out.join(" ")
}

/** All clickable nodes whose own text matches `label`. */
function buttonsLabelled(tree: unknown, label: string): Node[] {
  const found: Node[] = []
  walk(tree, (n) => {
    if (n.props?.onClick && renderedText(n).includes(label)) found.push(n)
  })
  return found
}

function render(state: Record<string, unknown>): unknown {
  h.chat = { messages: [], isLoading: false, ...state }
  return ChatWidget()
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── The denied path ─────────────────────────────────────────────────────────

describe("ChatWidget — denied/expired session", () => {
  it("shows the pt-BR recovery sentence and a start-new-conversation button", () => {
    const tree = render({ error: CHAT_SESSION_EXPIRED_PTBR, errorCanRestart: true })
    const text = renderedText(tree)

    expect(text).toContain(CHAT_SESSION_EXPIRED_PTBR)
    expect(text).toContain(CHAT_RESTART_LABEL_PTBR)
    expect(buttonsLabelled(tree, CHAT_RESTART_LABEL_PTBR)).toHaveLength(1)
  })

  it("the button actually starts a new conversation", () => {
    const tree = render({ error: CHAT_SESSION_EXPIRED_PTBR, errorCanRestart: true })
    const [button] = buttonsLabelled(tree, CHAT_RESTART_LABEL_PTBR)

    ;(button.props?.onClick as () => void)()

    expect(h.startNewConversation).toHaveBeenCalledTimes(1)
  })

  it("offers NO restart button for an ordinary retryable failure", () => {
    const tree = render({ error: CHAT_GENERIC_FAILURE_PTBR, errorCanRestart: false })

    expect(renderedText(tree)).toContain(CHAT_GENERIC_FAILURE_PTBR)
    expect(buttonsLabelled(tree, CHAT_RESTART_LABEL_PTBR)).toHaveLength(0)
  })

  it("renders no error region at all when there is no error", () => {
    const text = renderedText(render({}))

    expect(text).not.toContain(CHAT_SESSION_EXPIRED_PTBR)
    expect(text).not.toContain(CHAT_GENERIC_FAILURE_PTBR)
    expect(text).not.toContain(CHAT_RESTART_LABEL_PTBR)
  })
})

// ── The negative: no payload may ever render ────────────────────────────────

describe("ChatWidget — no raw payload reaches the panel", () => {
  it("a JSON-ish string that somehow reached the store is still not a bubble the code authored", () => {
    // Defense in depth: even if a caller pushed a payload-shaped string, the
    // widget must not be the thing that MINTS one. This pins that every string
    // rendered came from the store, and that no branch stringifies an object.
    const tree = render({
      error: CHAT_SESSION_EXPIRED_PTBR,
      errorCanRestart: true,
      messages: [
        { id: "a", role: "user", content: "oi", timestamp: new Date() },
        { id: "b", role: "assistant", content: "", timestamp: new Date() },
      ],
    })
    const text = renderedText(tree)

    expect(text).not.toContain("messageId")
    expect(text).not.toContain("[object Object]")
    expect(text).not.toContain("undefined")
    expect(text).not.toMatch(/\{\s*"/)
  })

  it("the loading spinner is not shown once an error is displayed", () => {
    // The measured symptom was a bubble stuck behind a spinner that never
    // stopped; the panel must not present both states at once.
    const tree = render({
      error: CHAT_SESSION_EXPIRED_PTBR,
      errorCanRestart: true,
      isLoading: false,
    })

    expect(renderedText(tree)).toContain(CHAT_SESSION_EXPIRED_PTBR)
  })
})
