// One renderer for all four T2-4 GraphDocuments (capability / journeys /
// run / impact): dagre layout, node coloring by type + kernel decision,
// visually distinct dangling/unadvertised/blocked flags, click → meta panel.
// READ-ONLY by construction: no authoring canvas, no drag, no connect, no
// delete — the graphs are derived artifacts and the viewer never writes.

import { Background, Controls, MiniMap, ReactFlow, type Node } from "@xyflow/react"
import { useMemo, useState, type CSSProperties } from "react"
import { decisionColor, NODE_TYPE_COLORS, nodeFlags } from "../lib/colors"
import { layoutGraph } from "../lib/layout"
import type { GraphDocument, GraphNode } from "../types"
import { MetaPanel } from "./MetaPanel"

function decorate(doc: GraphDocument, original: GraphNode, laidOut: Node): Node {
  const flags = nodeFlags(doc.graph, original)
  const meta = original.meta ?? {}

  // Decision accent: decision nodes color by their own label; envelope and
  // expectation nodes by the decision they carry in meta.
  const decision =
    original.type === "decision"
      ? decisionColor(original.label)
      : decisionColor(typeof meta["decision"] === "string" ? meta["decision"] : undefined)

  const style: CSSProperties = {
    background: NODE_TYPE_COLORS[original.type] ?? "#f2f2f2",
    ...(decision !== undefined ? { borderColor: decision, borderWidth: 2 } : {}),
  }

  const className = [
    "qa-node",
    `qa-node--${original.type}`,
    ...flags.map((f) => `qa-flag--${f}`),
  ].join(" ")

  return {
    ...laidOut,
    className,
    style,
    data: {
      label: (
        <div className="qa-node__body">
          <span className="qa-node__type">{original.type}</span>
          <span className="qa-node__label">{original.label}</span>
          {flags.length > 0 && (
            <span className="qa-node__badges">
              {flags.map((f) => (
                <span key={f} className={`flag-badge flag-badge--${f}`}>
                  {f}
                </span>
              ))}
            </span>
          )}
        </div>
      ),
    },
  }
}

function headline(doc: GraphDocument): string[] {
  const m = doc.meta
  const chips = [`${doc.nodes.length} nodes`, `${doc.edges.length} edges`]
  if (doc.graph === "capability") {
    const dangling = Array.isArray(m["dangling"]) ? m["dangling"].length : 0
    const unadvertised = Array.isArray(m["unadvertised"]) ? m["unadvertised"].length : 0
    chips.push(`${dangling} dangling`, `${unadvertised} unadvertised`)
  }
  if (doc.graph === "journeys") {
    const active = Array.isArray(m["active"]) ? m["active"].length : 0
    const blocked = Array.isArray(m["blocked"]) ? m["blocked"].length : 0
    const gaps = Array.isArray(m["gaps"]) ? m["gaps"].length : 0
    chips.push(`${active} active`, `${blocked} blocked`, `${gaps} gaps`)
  }
  if (doc.graph === "impact") {
    if (typeof m["totalEnvelopes"] === "number") chips.push(`${m["totalEnvelopes"]} envelopes`)
    if (typeof m["excludedAgentRows"] === "number") {
      chips.push(`${m["excludedAgentRows"]} agent-namespace rows excluded`)
    }
  }
  if (doc.graph === "run" && typeof m["journeyId"] === "string") {
    chips.push(String(m["journeyId"]))
  }
  return chips
}

export function GraphView({ doc }: { doc: GraphDocument }) {
  const laidOut = useMemo(() => layoutGraph(doc), [doc])
  const nodes = useMemo(
    () =>
      laidOut.nodes.map((n) => {
        const original = laidOut.byId.get(n.id)
        return original !== undefined ? decorate(doc, original, n) : n
      }),
    [doc, laidOut],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId !== null ? (laidOut.byId.get(selectedId) ?? null) : null

  return (
    <div className="graph-view">
      <div className="graph-view__meta">
        {headline(doc).map((chip) => (
          <span key={chip} className="meta-chip">
            {chip}
          </span>
        ))}
        <details className="graph-view__raw-meta">
          <summary>graph meta</summary>
          <pre>{JSON.stringify(doc.meta, null, 2)}</pre>
        </details>
      </div>
      <div className="graph-view__canvas">
        <ReactFlow
          nodes={nodes}
          edges={laidOut.edges}
          fitView
          minZoom={0.02}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
        {selected !== null && (
          <MetaPanel graph={doc.graph} node={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  )
}
