// graphs/journey-graph.ts — derived journey graph (T2-4).
//
//   journeys → acts → expected intentKind×decision
//
// Source: the Journey Registry (`packages/journeys/journeys/*.yaml`, loaded
// through the schema). BLOCKED journeys are first-class — they carry edges
// to their `blocked_by` gap nodes, which makes this graph the product-
// backlog visualization (D-014/D-015: blocked journeys ARE the backlog;
// the gap ids name real product gaps, never fabricated greens).
//
// Expectation nodes are SHARED across journeys (`expect:<kind>:<decision>`)
// so the viewer shows which journeys converge on the same audited cell;
// `optional: true` expects (T1b-1 reconciliation allowances) keep their
// edge but are flagged — they claim no coverage.

import { journeyPersonaContext } from "../gates/lint.js"
import type { Journey, JourneyAct, JsonValue } from "../schema/index.js"
import {
  finalizeGraph,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
} from "./contract.js"

function actLabel(act: JourneyAct, index: number): string {
  // Same default the runner emits (runner/run-journey.ts).
  return act.name ?? `act-${index + 1}:${act.kind}`
}

function actMeta(act: JourneyAct, index: number): Record<string, JsonValue> {
  const base: Record<string, JsonValue> = { index, kind: act.kind }
  switch (act.kind) {
    case "http":
      return {
        ...base,
        method: act.method,
        path: act.path,
        asRole: act.asRole ?? "anonymous",
      }
    case "chat":
      return {
        ...base,
        mode:
          act.utterance !== undefined && act.goal !== undefined
            ? "utterance+goal"
            : act.utterance !== undefined
              ? "utterance"
              : "goal",
      }
    case "fixture":
      return { ...base, seed: act.seed }
  }
}

/** Build the journey graph from an already-loaded registry. Pure. */
export function buildJourneyGraph(journeys: ReadonlyArray<Journey>): GraphDocument {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const expectationIds = new Set<string>()
  const gapBlocks = new Map<string, string[]>()

  for (const journey of journeys) {
    const journeyNodeId = `journey:${journey.id}`
    nodes.push({
      id: journeyNodeId,
      type: "journey",
      label: `${journey.id} — ${journey.title}`,
      meta: {
        journeyId: journey.id,
        status: journey.status,
        blockedBy: [...journey.blocked_by],
        personaContext: journeyPersonaContext(journey),
        channel: journey.channel,
        source: journey.source,
        actCount: journey.acts.length,
        expectCount: journey.expects.filter((e) => e.optional !== true).length,
        optionalExpectCount: journey.expects.filter((e) => e.optional === true).length,
        verifyInvariants: journey.verify.map((v) => v.invariant),
      },
    })

    journey.acts.forEach((act, index) => {
      const actNodeId = `${journeyNodeId}:act:${index}`
      nodes.push({
        id: actNodeId,
        type: "act",
        label: actLabel(act, index),
        meta: actMeta(act, index),
      })
      edges.push({
        from: journeyNodeId,
        to: actNodeId,
        type: "has-act",
        meta: { index },
      })
    })

    for (const expect of journey.expects) {
      const expectationId = `expect:${expect.intentKind}:${expect.decision}`
      if (!expectationIds.has(expectationId)) {
        expectationIds.add(expectationId)
        nodes.push({
          id: expectationId,
          type: "expectation",
          label: `${expect.intentKind} → ${expect.decision}`,
          meta: { intentKind: expect.intentKind, decision: expect.decision },
        })
      }
      edges.push({
        from: journeyNodeId,
        to: expectationId,
        type: "expects",
        meta: { optional: expect.optional === true },
      })
    }

    for (const gapId of journey.blocked_by) {
      const blocks = gapBlocks.get(gapId) ?? []
      blocks.push(journey.id)
      gapBlocks.set(gapId, blocks)
      edges.push({
        from: journeyNodeId,
        to: `gap:${gapId}`,
        type: "blocked-by",
      })
    }
  }

  for (const [gapId, blocks] of gapBlocks) {
    nodes.push({
      id: `gap:${gapId}`,
      type: "gap",
      label: gapId,
      meta: { blocks: [...blocks].sort() },
    })
  }

  const active = journeys.filter((j) => j.status === "active")
  return finalizeGraph({
    version: 1,
    graph: "journeys",
    meta: {
      journeys: journeys.length,
      active: active.map((j) => j.id).sort(),
      blocked: journeys
        .filter((j) => j.status === "blocked")
        .map((j) => j.id)
        .sort(),
      gaps: [...gapBlocks.keys()].sort(),
    },
    nodes,
    edges,
  })
}
