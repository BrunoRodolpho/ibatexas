// Tests for graphs/capability-graph.ts — packs → intents → tools/planners
// with the P0-7 dangling/unadvertised roster flags (T2-4).
//
// The builder is pure given its build-time imports (the REAL composition),
// so these tests assert STRUCTURAL invariants of the derivation — never
// today's specific roster facts (those legitimately change with WS4 etc.).
import { describe, it, expect } from "vitest"

import {
  CHAT_DRIVABLE_TOOL_KINDS,
  IBATEXAS_COMPOSED_PACKS,
} from "@ibatexas/packs-composed"
import { KNOWN_INTENT_KINDS } from "@ibatexas/intent-kinds"

import { buildCapabilityGraph } from "../capability-graph.js"
import { serializeGraph } from "../contract.js"

const graph = buildCapabilityGraph()
const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
const meta = graph.meta as {
  dangling: string[]
  unadvertised: string[]
  packs: number
  registeredTools: number
}

describe("buildCapabilityGraph", () => {
  it("has one pack node per composed pack and one tool node per registered kind", () => {
    expect(graph.nodes.filter((n) => n.type === "pack")).toHaveLength(
      IBATEXAS_COMPOSED_PACKS.length,
    )
    expect(graph.nodes.filter((n) => n.type === "tool")).toHaveLength(
      CHAT_DRIVABLE_TOOL_KINDS.length,
    )
    expect(meta.packs).toBe(IBATEXAS_COMPOSED_PACKS.length)
    expect(meta.registeredTools).toBe(CHAT_DRIVABLE_TOOL_KINDS.length)
  })

  it("covers the full known intent-kind union as intent nodes", () => {
    for (const kind of KNOWN_INTENT_KINDS) {
      const node = nodesById.get(`intent:${kind}`)
      expect(node, `intent:${kind}`).toBeDefined()
      expect(node!.meta?.knownKind).toBe(true)
    }
  })

  it("links every pack-declared kind with a declares edge", () => {
    for (const pack of IBATEXAS_COMPOSED_PACKS) {
      for (const kind of pack.intents) {
        expect(
          graph.edges.some(
            (e) =>
              e.type === "declares" &&
              e.from === `pack:${pack.id}` &&
              e.to === `intent:${kind}`,
          ),
          `declares ${pack.id} -> ${kind}`,
        ).toBe(true)
      }
    }
  })

  it("links every registered tool kind with a registers edge + chatDrivable meta", () => {
    for (const kind of CHAT_DRIVABLE_TOOL_KINDS) {
      expect(
        graph.edges.some(
          (e) =>
            e.type === "registers" &&
            e.from === `intent:${kind}` &&
            e.to === `tool:${kind}`,
        ),
        `registers ${kind}`,
      ).toBe(true)
      expect(nodesById.get(`intent:${kind}`)?.meta?.chatDrivable).toBe(true)
    }
  })

  it("flags the P0-7 facts consistently with the advertises edges", () => {
    const advertisedKinds = new Set(
      graph.edges
        .filter((e) => e.type === "advertises")
        .map((e) => e.to.replace(/^intent:/, "")),
    )
    const registered = new Set(CHAT_DRIVABLE_TOOL_KINDS)

    // dangling = advertised-no-tool; unadvertised = registered-not-advertised.
    const expectedDangling = [...advertisedKinds].filter((k) => !registered.has(k)).sort()
    const expectedUnadvertised = [...registered]
      .filter((k) => !advertisedKinds.has(k))
      .sort()
    expect(meta.dangling).toEqual(expectedDangling)
    expect(meta.unadvertised).toEqual(expectedUnadvertised)

    for (const kind of meta.dangling) {
      expect(nodesById.get(`intent:${kind}`)?.meta?.flags).toContain("dangling")
    }
    for (const kind of meta.unadvertised) {
      expect(nodesById.get(`intent:${kind}`)?.meta?.flags).toContain("unadvertised")
    }
    // A kind can never be both: dangling ⇒ not registered, unadvertised ⇒ registered.
    expect(meta.dangling.filter((k) => meta.unadvertised.includes(k))).toEqual([])
  })

  it("attaches pack policy metadata (plausibleDecisions) to every intent node", () => {
    for (const node of graph.nodes.filter((n) => n.type === "intent")) {
      const decisions = node.meta?.plausibleDecisions
      expect(Array.isArray(decisions), node.id).toBe(true)
      expect((decisions as string[]).length).toBeGreaterThan(0)
    }
  })

  it("is deterministic: two builds serialize to identical bytes", () => {
    expect(serializeGraph(buildCapabilityGraph())).toBe(serializeGraph(graph))
  })
})
