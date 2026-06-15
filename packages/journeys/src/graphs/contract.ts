// graphs/contract.ts — THE shared graph JSON contract (T2-4).
//
// ONE document shape for all four derived graphs (capability / journeys /
// run / impact): `nodes[] {id,type,label,meta}` + `edges[] {from,to,type,
// meta}`. The T2-5 QA viewer consumes exactly this shape — never invent a
// per-graph format. Human-readable documentation of the contract lives in
// `packages/journeys/graphs/README.md` (next to the committed artifacts).
//
// DETERMINISM IS LOAD-BEARING: the committed graphs are drift-gated by
// `ibx graph export --check` (regenerate-and-diff). Two exports of the same
// inputs MUST be byte-identical, so:
//   * no timestamps / hostnames / absolute paths anywhere in a document;
//   * `finalizeGraph` sorts nodes by (type, id) and edges by
//     (type, from, to) using plain code-point comparison (NOT localeCompare
//     — locale-dependent ordering would break cross-machine stability);
//   * `serializeGraph` emits canonical JSON: pinned top-level/node/edge key
//     order, recursively sorted meta keys, 2-space indent, trailing newline.

import type { JsonValue } from "../schema/index.js"

// ── Names ────────────────────────────────────────────────────────────────────

/** The four derived graphs, in canonical order. */
export const GRAPH_NAMES = ["capability", "journeys", "run", "impact"] as const

export type GraphName = (typeof GRAPH_NAMES)[number]

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Globally unique within the document (e.g. `intent:order.cancel`). */
  id: string
  /** Render/grouping type (e.g. `pack`, `intent`, `tool`, `journey`, `act`…). */
  type: string
  /** Human label for the viewer. */
  label: string
  /** Open metadata bag (JSON only — keys are sorted at serialization). */
  meta?: Record<string, JsonValue>
}

export interface GraphEdge {
  /** Source node id — MUST exist in `nodes`. */
  from: string
  /** Target node id — MUST exist in `nodes`. */
  to: string
  /** Edge semantics (e.g. `declares`, `advertises`, `expects`, `decided`). */
  type: string
  meta?: Record<string, JsonValue>
}

export interface GraphDocument {
  version: 1
  graph: GraphName
  /** Graph-level metadata (window bounds, totals, flagged-kind summaries…). */
  meta: Record<string, JsonValue>
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export class GraphContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GraphContractError"
  }
}

// ── Canonicalization ─────────────────────────────────────────────────────────

/** Code-point string comparison — locale-independent, byte-stable. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Recursively sort object keys so meta serializes byte-stably. */
function canonicalJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort(cmp)) {
      out[key] = canonicalJsonValue(value[key]!)
    }
    return out
  }
  return value
}

/**
 * Validate + canonicalize a graph document: duplicate node ids and edges
 * referencing missing nodes are GENERATOR BUGS and throw
 * `GraphContractError`; nodes/edges are sorted deterministically and meta
 * key order is pinned. Generators always return `finalizeGraph(...)`.
 */
export function finalizeGraph(doc: GraphDocument): GraphDocument {
  const ids = new Set<string>()
  for (const node of doc.nodes) {
    if (ids.has(node.id)) {
      throw new GraphContractError(
        `duplicate node id "${node.id}" in ${doc.graph} graph`,
      )
    }
    ids.add(node.id)
  }
  for (const edge of doc.edges) {
    for (const endpoint of [edge.from, edge.to]) {
      if (!ids.has(endpoint)) {
        throw new GraphContractError(
          `edge ${edge.type} ${edge.from} -> ${edge.to} references missing node ` +
            `"${endpoint}" in ${doc.graph} graph`,
        )
      }
    }
  }

  const nodes = [...doc.nodes]
    .sort((a, b) => cmp(a.type, b.type) || cmp(a.id, b.id))
    .map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      ...(n.meta !== undefined
        ? { meta: canonicalJsonValue(n.meta) as Record<string, JsonValue> }
        : {}),
    }))
  const edges = [...doc.edges]
    .sort((a, b) => cmp(a.type, b.type) || cmp(a.from, b.from) || cmp(a.to, b.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      type: e.type,
      ...(e.meta !== undefined
        ? { meta: canonicalJsonValue(e.meta) as Record<string, JsonValue> }
        : {}),
    }))

  return {
    version: 1,
    graph: doc.graph,
    meta: canonicalJsonValue(doc.meta) as Record<string, JsonValue>,
    nodes,
    edges,
  }
}

/**
 * Canonical bytes of a finalized graph document — the unit the
 * regenerate-and-diff gate compares. Always ends with a newline.
 */
export function serializeGraph(doc: GraphDocument): string {
  const finalized = finalizeGraph(doc)
  return `${JSON.stringify(finalized, null, 2)}\n`
}
