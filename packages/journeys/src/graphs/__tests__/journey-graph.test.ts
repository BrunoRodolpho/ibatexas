// Tests for graphs/journey-graph.ts — journeys → acts → kind×decision,
// with blocked_by gap nodes (the backlog visualization). T2-4.
import { describe, it, expect } from "vitest"

import { validateJourney, type Journey } from "../../schema/index.js"
import { buildJourneyGraph } from "../journey-graph.js"
import { serializeGraph } from "../contract.js"

function journey(over: Record<string, unknown>): Journey {
  const result = validateJourney({
    id: "JOURNEY-901",
    title: "graph fixture",
    businessCase: "journey-graph unit test",
    persona: "Persona de teste.",
    channel: "web",
    acts: [{ kind: "chat", name: "open", utterance: "Oi" }],
    expects: [],
    verify: [],
    status: "active",
    blocked_by: [],
    source: "graphs test fixture",
    ...over,
  })
  if (!result.ok) {
    throw new Error(`fixture journey invalid: ${JSON.stringify(result.errors)}`)
  }
  return result.journey
}

const active = journey({
  id: "JOURNEY-901",
  params: { authenticated: true },
  acts: [
    { kind: "fixture", name: "seed", seed: "seedCustomer", params: { phone: "+5519900000001" } },
    { kind: "http", name: "checkout", method: "POST", path: "/api/cart/checkout", asRole: "customer" },
    { kind: "chat", name: "cancel", goal: "Cancelar o pedido." },
  ],
  expects: [
    { intentKind: "order.checkout.create", decision: "EXECUTE" },
    { intentKind: "order.cancel", decision: "REQUEST_CONFIRMATION" },
    { intentKind: "order.status.transition", decision: "EXECUTE", optional: true },
  ],
})

const blocked = journey({
  id: "JOURNEY-902",
  status: "blocked",
  blocked_by: ["chat-order-assembly", "medusa-v2-order-edit"],
  expects: [{ intentKind: "order.cancel", decision: "REQUEST_CONFIRMATION" }],
})

const graph = buildJourneyGraph([active, blocked])
const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))

describe("buildJourneyGraph", () => {
  it("creates journey nodes with status/persona/blockedBy meta", () => {
    const node = nodesById.get("journey:JOURNEY-901")
    expect(node?.meta?.status).toBe("active")
    expect(node?.meta?.personaContext).toBe("authed-customer")
    const blockedNode = nodesById.get("journey:JOURNEY-902")
    expect(blockedNode?.meta?.status).toBe("blocked")
    expect(blockedNode?.meta?.blockedBy).toEqual([
      "chat-order-assembly",
      "medusa-v2-order-edit",
    ])
  })

  it("creates one act node per act with has-act edges in order", () => {
    const actEdges = graph.edges.filter(
      (e) => e.type === "has-act" && e.from === "journey:JOURNEY-901",
    )
    expect(actEdges).toHaveLength(3)
    expect(nodesById.get("journey:JOURNEY-901:act:1")?.meta).toMatchObject({
      kind: "http",
      method: "POST",
      path: "/api/cart/checkout",
      asRole: "customer",
    })
    expect(nodesById.get("journey:JOURNEY-901:act:2")?.meta?.mode).toBe("goal")
  })

  it("shares expectation nodes across journeys and flags optional expects", () => {
    // Both journeys expect order.cancel REQUEST_CONFIRMATION → ONE node.
    const expectation = nodesById.get("expect:order.cancel:REQUEST_CONFIRMATION")
    expect(expectation).toBeDefined()
    const expectEdges = graph.edges.filter(
      (e) => e.type === "expects" && e.to === "expect:order.cancel:REQUEST_CONFIRMATION",
    )
    expect(expectEdges.map((e) => e.from).sort()).toEqual([
      "journey:JOURNEY-901",
      "journey:JOURNEY-902",
    ])

    const optionalEdge = graph.edges.find(
      (e) =>
        e.type === "expects" && e.to === "expect:order.status.transition:EXECUTE",
    )
    expect(optionalEdge?.meta?.optional).toBe(true)
    const requiredEdge = graph.edges.find(
      (e) => e.type === "expects" && e.to === "expect:order.checkout.create:EXECUTE",
    )
    expect(requiredEdge?.meta?.optional).toBe(false)
  })

  it("materializes blocked_by gap nodes — the backlog visualization", () => {
    const gap = nodesById.get("gap:chat-order-assembly")
    expect(gap?.type).toBe("gap")
    expect(gap?.meta?.blocks).toEqual(["JOURNEY-902"])
    expect(
      graph.edges.some(
        (e) =>
          e.type === "blocked-by" &&
          e.from === "journey:JOURNEY-902" &&
          e.to === "gap:medusa-v2-order-edit",
      ),
    ).toBe(true)
    expect(graph.meta.gaps).toEqual(["chat-order-assembly", "medusa-v2-order-edit"])
  })

  it("summarizes active/blocked in graph meta and is deterministic", () => {
    expect(graph.meta.active).toEqual(["JOURNEY-901"])
    expect(graph.meta.blocked).toEqual(["JOURNEY-902"])
    expect(serializeGraph(buildJourneyGraph([active, blocked]))).toBe(
      serializeGraph(graph),
    )
  })
})
