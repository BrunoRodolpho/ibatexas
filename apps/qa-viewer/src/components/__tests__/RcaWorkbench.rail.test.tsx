// LE2-031 — the RCA rail renders as CUSTOMERS.
//
// These pin the three properties the ticket says must survive the reshape, at
// the level where they can actually break (the component, not the derivation):
//   · rows group by customer, sessions are expandable sub-rows, ops is labeled
//   · a deep link still addresses a SESSION and now reveals it one level down
//   · a live 5s tick that reorders the rail keeps the open group open and the
//     selection selected — because every level keys by data identity
//     (groupKey / sessionId / turnId), never by index
//
// The bridge is stubbed (env + fetch); nothing real is contacted.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RcaWorkbench } from "../RcaWorkbench"

const T = (n: number): string => `2026-07-24T10:0${n}:00.000Z`

interface RailPage {
  conversations: Array<Record<string, unknown>>
  groups: Array<Record<string, unknown>>
}

/** The rail page as apps/api's grouped conversations read produces it. */
const PAGE: RailPage = {
  conversations: [
    { sessionId: "admin:staff_7", chatCuid: null, channel: "ops", startedAt: T(5), lastAt: T(5), lastText: null, lastRole: null, turnCount: 2, customerId: null, phoneHash: null },
    { sessionId: "sess-web-1", chatCuid: "chat_w", channel: "web", startedAt: T(4), lastAt: T(4), lastText: "boa noite", lastRole: "user", turnCount: 3, customerId: "cus_1", phoneHash: null },
    { sessionId: "sess-wa-1", chatCuid: "chat_a", channel: "whatsapp", startedAt: T(3), lastAt: T(3), lastText: null, lastRole: null, turnCount: 1, customerId: "cus_1", phoneHash: "ph_1" },
    { sessionId: "sess-anon-1", chatCuid: null, channel: "web", startedAt: T(1), lastAt: T(1), lastText: null, lastRole: null, turnCount: 1, customerId: null, phoneHash: null },
  ],
  groups: [
    { groupKey: "ops:staff_7", kind: "ops", label: "ops · staff_7", customerId: null, phoneHash: null, staffId: "staff_7", sessionIds: ["admin:staff_7"], channels: ["ops"], sessionCount: 1, turnCount: 2, startedAt: T(5), lastAt: T(5) },
    { groupKey: "customer:cus_1", kind: "customer", label: "cus_1", customerId: "cus_1", phoneHash: "ph_1", staffId: null, sessionIds: ["sess-web-1", "sess-wa-1"], channels: ["web", "whatsapp"], sessionCount: 2, turnCount: 4, startedAt: T(3), lastAt: T(4) },
    { groupKey: "unidentified", kind: "unidentified", label: "unidentified", customerId: null, phoneHash: null, staffId: null, sessionIds: ["sess-anon-1"], channels: ["web"], sessionCount: 1, turnCount: 1, startedAt: T(1), lastAt: T(1) },
  ],
}

/** The same rows after the anonymous visitor wrote again — the ONLY change is
 *  the order (and one timestamp). Group identities are untouched. */
const PAGE_REORDERED: RailPage = {
  conversations: PAGE.conversations.map((c) =>
    c.sessionId === "sess-anon-1" ? { ...c, lastAt: T(9) } : c,
  ),
  groups: [
    { ...PAGE.groups[2]!, lastAt: T(9) },
    PAGE.groups[0]!,
    PAGE.groups[1]!,
  ],
}

const TURNS = [
  { turnId: "turn-aaa1111", startedAt: T(4), endedAt: T(4), callCount: 3, decision: "EXECUTE", adjCount: 1, userText: "quero costela", hadSend: true, responderEmpty: false },
]

const STATUS = {
  turnTrace: { ok: true, latencyMs: 1, error: null },
  intentAudit: { ok: true, latencyMs: 1, error: null },
  domain: { ok: true, latencyMs: 1, error: null },
  victoriaLogs: { ok: true, latencyMs: 1, error: null },
  flags: { redactSecretSet: true, claimsPipeline: true },
}

let page: RailPage = PAGE

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url.includes("/rca/status")) return json({ status: STATUS })
      if (/\/rca\/conversations\/[^/?]+\/turns/.test(url)) return json({ turns: TURNS })
      if (/\/rca\/conversations\/[^/?]+\/messages/.test(url)) return json({ messages: [], degraded: false })
      if (url.includes("/rca/conversations")) return json(page)
      if (url.includes("/rca/turns/")) {
        return json({
          turn: {
            context: { turnId: "turn-aaa1111", conversationId: "sess-web-1", noncePrefix: "sess-web-1:", chatCuid: "chat_w", phoneHash: null, sessionHashed: null, channel: "web", startedAt: T(4), endedAt: T(4), durationMs: 10, catalogVersion: 7 },
            llm: [],
            adj: [],
            vl: [],
            wire: [],
            delivery: [],
            degraded: { adj: false, vl: false, wire: false, delivery: false },
          },
        })
      }
      return json({})
    }),
  )
}

beforeEach(() => {
  page = PAGE
  sessionStorage.clear()
  window.location.hash = ""
  vi.stubEnv("VITE_QA_CONTROL_BASE", "http://api.test")
  vi.stubEnv("VITE_QA_CONTROL_TOKEN", "test-token")
  installFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

/** The top-level rail row for one identity, found by its LABEL (the kind chip
 *  carries the same word for the unidentified bucket). */
const custRow = (label: string): HTMLElement => {
  const el = [...document.querySelectorAll(".conv-tree__cust-label")].find(
    (n) => n.textContent === label,
  )
  if (el === undefined) throw new Error(`no customer row for ${label}`)
  return el.closest(".conv-tree__cust") as HTMLElement
}

const custLabels = (): Array<string | null> =>
  [...document.querySelectorAll(".conv-tree__cust-label")].map((n) => n.textContent)

// ── AC1 + AC2: customers on top, sessions as sub-rows, ops labeled ───────────

describe("RCA rail — grouped by customer", () => {
  it("renders ONE row per identity, with the sessions collapsed underneath", async () => {
    const { container } = render(<RcaWorkbench />)
    await screen.findByText("cus_1")

    // Four sessions, three identities — the rail is no longer a session list.
    expect(container.querySelectorAll(".conv-tree__cust")).toHaveLength(3)
    expect(custLabels()).toEqual(["ops · staff_7", "cus_1", "unidentified"])
    // Sessions live one level down and start closed.
    expect(container.querySelectorAll(".conv-tree__sess")).toHaveLength(0)
    // The customer row summarizes what folded into it.
    expect(custRow("cus_1").textContent).toContain("2 session(s)")
    expect(custRow("cus_1").textContent).toContain("4 turn(s)")
  })

  it("labels an ops thread distinctly from a customer thread", () => {
    const { container } = render(<RcaWorkbench />)
    return waitFor(() => {
      const ops = container.querySelector(".grp-chip--ops")
      expect(ops).not.toBeNull()
      expect(ops!.textContent).toBe("ops")
      // …and it is a different treatment from the customer row's chip.
      expect(container.querySelector(".grp-chip--customer")).not.toBeNull()
      expect(container.querySelector(".grp-chip--unidentified")).not.toBeNull()
    })
  })

  it("expands a customer into its sessions, which stay selectable", async () => {
    const { container } = render(<RcaWorkbench />)
    await screen.findByText("cus_1")

    fireEvent.click(custRow("cus_1"))
    expect(container.querySelectorAll(".conv-tree__sess")).toHaveLength(2)
    expect(screen.getByText("sess-web-1…")).toBeDefined()
    expect(screen.getByText("sess-wa-1…")).toBeDefined()

    // Selecting a session still drives the workbench (turns load below it).
    fireEvent.click(screen.getByText("sess-web-1…").closest(".conv-tree__conv")!)
    await screen.findByText("quero costela")
    expect(container.querySelector(".conv-tree__conv--sel")!.textContent).toContain("sess-web-1…")
  })

  it("keeps unattributable sessions reachable in the explicit bucket", async () => {
    const { container } = render(<RcaWorkbench />)
    await screen.findByText("cus_1")
    fireEvent.click(custRow("unidentified"))
    expect(container.querySelectorAll(".conv-tree__sess")).toHaveLength(1)
    expect(screen.getByText("sess-anon-1…")).toBeDefined()
  })
})

// ── AC3: deep links ──────────────────────────────────────────────────────────

describe("RCA rail — deep links survive the reshape", () => {
  it("reveals and selects the session a #rca/conv/… link addresses", async () => {
    window.location.hash = "#rca/conv/sess-wa-1"
    const { container } = render(<RcaWorkbench />)
    await screen.findByText("cus_1")

    // The link names a session; the rail opens the customer that holds it.
    await waitFor(() => {
      expect(container.querySelectorAll(".conv-tree__sess").length).toBeGreaterThan(0)
    })
    expect(screen.getByText("sess-wa-1…")).toBeDefined()
    expect(container.querySelector(".conv-tree__conv--sel")!.textContent).toContain("sess-wa-1…")
    // Other customers stay collapsed — revealing is scoped to the target.
    expect(container.querySelectorAll(".conv-tree__sess")).toHaveLength(2)
  })
})

// ── AC3: live refresh + row identity ─────────────────────────────────────────

describe("RCA rail — a live tick never moves what is open or selected", () => {
  /** Drive the component's own timers (200ms filter debounce, 5s live tick)
   *  and flush the fetches they start. */
  const advance = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  const fetchUrls = (): string[] =>
    (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
      String(c[0]),
    )

  it("keeps an open customer row open when the refresh reorders the rail", async () => {
    // Fake timers must predate the render: the live interval is scheduled in a
    // mount effect, and a real interval cannot be advanced afterwards.
    vi.useFakeTimers()
    const { container } = render(<RcaWorkbench />)
    await advance(300)

    fireEvent.click(custRow("cus_1"))
    expect(custLabels()).toEqual(["ops · staff_7", "cus_1", "unidentified"])
    expect(container.querySelectorAll(".conv-tree__sess")).toHaveLength(2)

    // The 5s list tick returns the SAME identities in a NEW order (the
    // anonymous visitor just wrote). Rows keyed by index would re-key here and
    // the investigator's open row would collapse (or worse, a different row
    // would appear open).
    page = PAGE_REORDERED
    await advance(5_100)

    expect(custLabels()).toEqual(["unidentified", "ops · staff_7", "cus_1"])
    const open = [...container.querySelectorAll(".conv-tree__sess")]
    expect(open).toHaveLength(2)
    expect(open[0]!.textContent).toContain("sess-web-1…")
  })

  it("keeps the refresh SCOPED: with a session selected the tick re-reads it, not the rail", async () => {
    vi.useFakeTimers()
    render(<RcaWorkbench />)
    await advance(300)
    fireEvent.click(custRow("cus_1"))
    fireEvent.click(screen.getByText("sess-wa-1…").closest(".conv-tree__conv")!)
    await advance(50)
    ;(globalThis.fetch as unknown as { mockClear: () => void }).mockClear()

    await advance(5_100)

    const urls = fetchUrls()
    expect(urls.some((u) => u.includes("/rca/conversations/sess-wa-1/turns"))).toBe(true)
    // The rail list is NOT re-read while a conversation is open — the pre-
    // existing scoping (turn ▸ conversation ▸ list) is untouched by grouping.
    expect(urls.some((u) => u.includes("/rca/conversations?"))).toBe(false)
  })
})
