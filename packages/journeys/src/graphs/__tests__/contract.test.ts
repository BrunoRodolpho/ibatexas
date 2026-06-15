// Tests for graphs/contract.ts — the ONE shared graph JSON contract (T2-4).
import { describe, it, expect } from "vitest"

import {
  finalizeGraph,
  serializeGraph,
  GraphContractError,
  type GraphDocument,
} from "../contract.js"

function doc(over?: Partial<GraphDocument>): GraphDocument {
  return {
    version: 1,
    graph: "capability",
    meta: { zeta: 1, alpha: { nested: true, aKey: "x" } },
    nodes: [
      { id: "intent:b", type: "intent", label: "b" },
      { id: "pack:a", type: "pack", label: "a", meta: { z: 1, a: 2 } },
      { id: "intent:a", type: "intent", label: "a" },
    ],
    edges: [
      { from: "pack:a", to: "intent:b", type: "declares" },
      { from: "pack:a", to: "intent:a", type: "declares" },
    ],
    ...over,
  }
}

describe("finalizeGraph", () => {
  it("sorts nodes by (type, id) and edges by (type, from, to)", () => {
    const finalized = finalizeGraph(doc())
    expect(finalized.nodes.map((n) => n.id)).toEqual([
      "intent:a",
      "intent:b",
      "pack:a",
    ])
    expect(finalized.edges.map((e) => e.to)).toEqual(["intent:a", "intent:b"])
  })

  it("throws on duplicate node ids", () => {
    expect(() =>
      finalizeGraph(
        doc({
          nodes: [
            { id: "intent:a", type: "intent", label: "a" },
            { id: "intent:a", type: "intent", label: "dup" },
          ],
          edges: [],
        }),
      ),
    ).toThrow(GraphContractError)
  })

  it("throws on edges referencing missing nodes", () => {
    expect(() =>
      finalizeGraph(
        doc({
          nodes: [{ id: "pack:a", type: "pack", label: "a" }],
          edges: [{ from: "pack:a", to: "intent:ghost", type: "declares" }],
        }),
      ),
    ).toThrow(/missing node "intent:ghost"/)
  })
})

describe("serializeGraph", () => {
  it("is byte-stable across input orderings (incl. meta key order)", () => {
    const a = serializeGraph(doc())
    const shuffled = doc()
    shuffled.nodes.reverse()
    shuffled.edges.reverse()
    shuffled.meta = { alpha: { aKey: "x", nested: true }, zeta: 1 }
    const b = serializeGraph(shuffled)
    expect(a).toBe(b)
  })

  it("ends with exactly one trailing newline and parses back", () => {
    const bytes = serializeGraph(doc())
    expect(bytes.endsWith("}\n")).toBe(true)
    const parsed = JSON.parse(bytes) as GraphDocument
    expect(parsed.version).toBe(1)
    expect(parsed.graph).toBe("capability")
    // Pinned top-level key order — the artifact diff unit.
    expect(Object.keys(parsed)).toEqual(["version", "graph", "meta", "nodes", "edges"])
  })

  it("contains no timestamps (determinism is load-bearing)", () => {
    const bytes = serializeGraph(doc())
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
  })
})
