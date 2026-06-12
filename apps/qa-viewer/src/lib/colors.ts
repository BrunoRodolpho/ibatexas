// Node/decision palettes + flag detection — pure data, shared by the graph
// renderer and the coverage matrix.

import type { Decision, GraphDocument, GraphNode } from "../types"

/** Background tint per node `type` (every type across the four graphs). */
export const NODE_TYPE_COLORS: Record<string, string> = {
  pack: "#ede7fb",
  planner: "#e3eefc",
  tool: "#e2f5f1",
  intent: "#eef0f3",
  journey: "#e3eefc",
  act: "#e2f5f1",
  expectation: "#faf3dc",
  gap: "#fbe4e0",
  run: "#e3eefc",
  envelope: "#eef0f3",
  decision: "#eef0f3",
  verify: "#e2f5f1",
}

/** Strong accent per kernel decision (borders, chips, matrix cells). */
export const DECISION_COLORS: Record<Decision, string> = {
  EXECUTE: "#1e8e3e",
  REFUSE: "#c0392b",
  ESCALATE: "#d3590f",
  REQUEST_CONFIRMATION: "#b8860b",
  DEFER: "#2f6fb7",
  REWRITE: "#7c5cd6",
}

export function decisionColor(decision: string | undefined): string | undefined {
  return decision !== undefined && decision in DECISION_COLORS
    ? DECISION_COLORS[decision as Decision]
    : undefined
}

/**
 * Visual flags a node can carry — each gets a visually distinct treatment
 * (CSS class `qa-flag--<flag>` + a badge in the node body):
 *
 *   * `dangling`      capability intent advertised by a planner but backed by
 *                     no registered tool (P0-7 fact, red dashed border)
 *   * `unadvertised`  capability intent registered but advertised in no
 *                     persona context (amber dashed border)
 *   * `blocked`       journey blocked on a named product gap (D-014/D-015 —
 *                     blocked journeys ARE the backlog; grey + striped)
 *   * `gap`           the gap node itself (solid red border)
 *   * `fail`          run-graph act/verify with a failing outcome
 */
export type NodeFlag = "dangling" | "unadvertised" | "blocked" | "gap" | "fail"

export function nodeFlags(graph: GraphDocument["graph"], node: GraphNode): NodeFlag[] {
  const flags: NodeFlag[] = []
  const meta = node.meta ?? {}

  if (graph === "capability" && Array.isArray(meta["flags"])) {
    for (const f of meta["flags"]) {
      if (f === "dangling" || f === "unadvertised") flags.push(f)
    }
  }
  if (node.type === "journey" && meta["status"] === "blocked") flags.push("blocked")
  if (node.type === "gap") flags.push("gap")
  if ((node.type === "act" || node.type === "verify" || node.type === "run") &&
      typeof meta["outcome"] === "string" && meta["outcome"] !== "pass") {
    flags.push("fail")
  }
  return flags
}
