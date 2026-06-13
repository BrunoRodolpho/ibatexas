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
import { RailGroup, RailSearch, Workbench, type RailItem } from "./FilterRail"
import { MetaPanel } from "./MetaPanel"

/**
 * Narrow a graph to a selected set of nodes (+ optionally their 1-hop
 * neighbors), keeping only edges whose endpoints both survive. An empty
 * selection means "show everything" — the rail is purely additive.
 */
function filterGraph(
  doc: GraphDocument,
  selected: ReadonlySet<string>,
  includeNeighbors: boolean,
): GraphDocument {
  if (selected.size === 0) return doc
  const keep = new Set<string>(selected)
  if (includeNeighbors) {
    for (const e of doc.edges) {
      if (selected.has(e.from)) keep.add(e.to)
      if (selected.has(e.to)) keep.add(e.from)
    }
  }
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => keep.has(n.id)),
    edges: doc.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  }
}

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
  // Rail filter state: a set of selected node ids (empty = show all) + a
  // query that narrows the rail list + whether to pull in 1-hop neighbors.
  const [query, setQuery] = useState("")
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [neighbors, setNeighbors] = useState(true)

  const filtered = useMemo(
    () => filterGraph(doc, picked, neighbors),
    [doc, picked, neighbors],
  )
  const laidOut = useMemo(() => layoutGraph(filtered), [filtered])
  const nodes = useMemo(
    () =>
      laidOut.nodes.map((n) => {
        const original = laidOut.byId.get(n.id)
        return original !== undefined ? decorate(filtered, original, n) : n
      }),
    [filtered, laidOut],
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId !== null ? (laidOut.byId.get(selectedId) ?? null) : null

  // Rail node list, grouped by node type, narrowed by the query.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byType = new Map<string, RailItem[]>()
    for (const n of doc.nodes) {
      if (q.length > 0 && !`${n.label} ${n.id} ${n.type}`.toLowerCase().includes(q)) continue
      const arr = byType.get(n.type) ?? []
      arr.push({ id: n.id, label: n.label })
      byType.set(n.type, arr)
    }
    return [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [doc, query])

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const addMany = (ids: string[]) =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  const removeMany = (ids: string[]) =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })

  // Remount the canvas when the visible set changes so fitView re-frames the
  // focused subgraph (xyflow only auto-fits on mount).
  const canvasKey = `${doc.graph}:${nodes.length}:${neighbors}:${[...picked].sort().join(",")}`

  const rail = (
    <>
      <RailSearch value={query} onChange={setQuery} placeholder="filter nodes…" />
      <div className="rail__row">
        <span className="rail__hint">
          {picked.size === 0 ? "all nodes" : `${picked.size} selected`}
        </span>
        {picked.size > 0 && (
          <button type="button" className="rail__link" onClick={() => setPicked(new Set())}>
            clear
          </button>
        )}
      </div>
      <label className="rail__toggle">
        <input
          type="checkbox"
          checked={neighbors}
          onChange={() => setNeighbors((v) => !v)}
        />
        include neighbors
      </label>
      {groups.map(([type, items]) => (
        <RailGroup
          key={type}
          title={`${type} (${items.length})`}
          items={items}
          selected={picked}
          onToggle={toggle}
          onAll={() => addMany(items.map((i) => i.id))}
          onNone={() => removeMany(items.map((i) => i.id))}
        />
      ))}
    </>
  )

  return (
    <Workbench rail={rail}>
      <div className="graph-view">
        <div className="graph-view__meta">
          {headline(filtered).map((chip) => (
            <span key={chip} className="meta-chip">
              {chip}
            </span>
          ))}
          {picked.size > 0 && (
            <span className="meta-chip meta-chip--warn">
              showing {filtered.nodes.length} of {doc.nodes.length} nodes
            </span>
          )}
          <details className="graph-view__raw-meta">
            <summary>graph meta</summary>
            <pre>{JSON.stringify(doc.meta, null, 2)}</pre>
          </details>
        </div>
        <div className="graph-view__canvas">
          <ReactFlow
            key={canvasKey}
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
            <MetaPanel graph={filtered.graph} node={selected} onClose={() => setSelectedId(null)} />
          )}
        </div>
      </div>
    </Workbench>
  )
}
