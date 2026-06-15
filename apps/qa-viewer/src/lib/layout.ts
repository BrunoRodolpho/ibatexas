// Dagre layout over a GraphDocument → positioned React Flow nodes/edges.
// Read-only rendering: nodes are never draggable/connectable; every node
// carries explicit width/height (which also makes React Flow render fully
// under happy-dom in the smoke test — the SSR path needs no measurement).

import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"
import type { GraphDocument, GraphEdge, GraphNode } from "../types"

export interface LaidOutGraph {
  nodes: Node[]
  edges: Edge[]
  /** Original document nodes by id — the meta panel reads from here. */
  byId: Map<string, GraphNode>
}

const NODE_HEIGHT = 48

function nodeWidth(label: string): number {
  return Math.max(150, Math.min(330, 30 + label.length * 7))
}

function edgeLabel(edge: GraphEdge): string {
  const meta = edge.meta ?? {}
  const extras: string[] = []
  if (meta["optional"] === true) extras.push("optional")
  if (typeof meta["count"] === "number") extras.push(`×${meta["count"]}`)
  if (Array.isArray(meta["contexts"])) extras.push(meta["contexts"].join(", "))
  return extras.length > 0 ? `${edge.type} (${extras.join("; ")})` : edge.type
}

export function layoutGraph(doc: GraphDocument): LaidOutGraph {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 90, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of doc.nodes) {
    g.setNode(node.id, { width: nodeWidth(node.label), height: NODE_HEIGHT })
  }
  for (const edge of doc.edges) {
    g.setEdge(edge.from, edge.to)
  }
  dagre.layout(g)

  const byId = new Map(doc.nodes.map((n) => [n.id, n]))

  const nodes: Node[] = doc.nodes.map((node) => {
    const pos = g.node(node.id)
    const width = nodeWidth(node.label)
    return {
      id: node.id,
      position: { x: pos.x - width / 2, y: pos.y - NODE_HEIGHT / 2 },
      width,
      height: NODE_HEIGHT,
      data: { label: node.label },
      draggable: false,
      connectable: false,
      deletable: false,
    }
  })

  const edges: Edge[] = doc.edges.map((edge, i) => ({
    id: `e${i}:${edge.type}:${edge.from}->${edge.to}`,
    source: edge.from,
    target: edge.to,
    label: edgeLabel(edge),
    deletable: false,
    focusable: false,
    style:
      edge.type === "blocked-by"
        ? { stroke: "#c0392b", strokeDasharray: "6 4" }
        : edge.meta?.["optional"] === true
          ? { strokeDasharray: "4 4" }
          : undefined,
  }))

  return { nodes, edges, byId }
}
