// Click-a-node meta panel — read-only inspection of the original artifact
// node (id, type, label, flags, full meta bag). No editing, ever.

import { nodeFlags } from "../lib/colors"
import type { GraphDocument, GraphNode } from "../types"

export function MetaPanel({
  graph,
  node,
  onClose,
}: {
  graph: GraphDocument["graph"]
  node: GraphNode
  onClose: () => void
}) {
  const flags = nodeFlags(graph, node)
  return (
    <aside className="meta-panel" aria-label="node details">
      <div className="meta-panel__header">
        <span className={`type-chip type-chip--${node.type}`}>{node.type}</span>
        <button type="button" className="meta-panel__close" onClick={onClose}>
          ✕
        </button>
      </div>
      <h3 className="meta-panel__title">{node.label}</h3>
      <div className="meta-panel__id">
        <code>{node.id}</code>
      </div>
      {flags.length > 0 && (
        <div className="meta-panel__flags">
          {flags.map((f) => (
            <span key={f} className={`flag-badge flag-badge--${f}`}>
              {f}
            </span>
          ))}
        </div>
      )}
      <pre className="meta-panel__meta">{JSON.stringify(node.meta ?? {}, null, 2)}</pre>
    </aside>
  )
}
