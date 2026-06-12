// Tests for graphs/impact-graph.ts — intent_audit aggregation EXCLUDING the
// agent session namespace (the T1b-3 filter, forward-protection for T3-6
// Stage-0 shadow rows). T2-4.
import { describe, it, expect } from "vitest"

import {
  AGENT_SESSION_ID_PREFIX,
  buildImpactGraph,
  fetchImpactWindow,
  ImpactWindowError,
  ImpactWindowFileSchema,
  IMPACT_EXCLUDED_SQL,
  IMPACT_WINDOW_SQL,
  type ImpactQueryable,
  type ImpactWindowFile,
} from "../impact-graph.js"
import { serializeGraph } from "../contract.js"

const WINDOW: ImpactWindowFile = {
  window: { fromIso: "2026-06-12T00:00:00.000Z", toIso: "2026-06-13T00:00:00.000Z" },
  source: "unit fixture",
  excludedAgentRows: 2,
  rows: [
    { intentKind: "order.cancel", decision: "EXECUTE", count: 3 },
    { intentKind: "order.cancel", decision: "REQUEST_CONFIRMATION", count: 1 },
    { intentKind: "order.checkout.create", decision: "EXECUTE", count: 5 },
  ],
}

describe("buildImpactGraph", () => {
  it("builds kind→decision edges with counts and per-node totals", () => {
    const graph = buildImpactGraph(WINDOW)
    const cancel = graph.nodes.find((n) => n.id === "intent:order.cancel")
    expect(cancel?.meta?.total).toBe(4)
    const execute = graph.nodes.find((n) => n.id === "decision:EXECUTE")
    expect(execute?.meta?.total).toBe(8)
    const edge = graph.edges.find(
      (e) => e.from === "intent:order.cancel" && e.to === "decision:REQUEST_CONFIRMATION",
    )
    expect(edge?.type).toBe("decided")
    expect(edge?.meta?.count).toBe(1)
  })

  it("always reports the agent-namespace exclusion in graph meta", () => {
    const graph = buildImpactGraph(WINDOW)
    expect(graph.meta.agentSessionPrefixExcluded).toBe(AGENT_SESSION_ID_PREFIX)
    expect(graph.meta.excludedAgentRows).toBe(2)
    expect(graph.meta.totalEnvelopes).toBe(9)
  })

  it("is deterministic", () => {
    expect(serializeGraph(buildImpactGraph(WINDOW))).toBe(
      serializeGraph(buildImpactGraph(WINDOW)),
    )
  })
})

describe("fetchImpactWindow (the T1b-3 agent-namespace filter)", () => {
  function fakeDb(): { db: ImpactQueryable; calls: Array<{ sql: string; params: unknown[] }> } {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const db: ImpactQueryable = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql === IMPACT_WINDOW_SQL) {
          return {
            rows: [
              { intent_kind: "order.cancel", decision_kind: "EXECUTE", count: 3 },
            ],
          }
        }
        return { rows: [{ count: 7 }] }
      },
    }
    return { db, calls }
  }

  it("excludes 'agent:'-prefixed session_id rows in SQL and reports the count", async () => {
    const { db, calls } = fakeDb()
    const window = await fetchImpactWindow(db, {
      fromIso: "2026-06-12T00:00:00.000Z",
      toIso: "2026-06-13T00:00:00.000Z",
      source: "fake",
    })

    // Same predicate as `ibx kernel replay` (T1b-3): NOT LIKE 'agent:%'.
    expect(IMPACT_WINDOW_SQL).toContain("session_id NOT LIKE $3")
    expect(IMPACT_EXCLUDED_SQL).toContain("session_id LIKE $3")
    for (const call of calls) {
      expect(call.params[2]).toBe(`${AGENT_SESSION_ID_PREFIX}%`)
    }
    expect(window.excludedAgentRows).toBe(7)
    expect(window.rows).toEqual([
      { intentKind: "order.cancel", decision: "EXECUTE", count: 3 },
    ])
    // The aggregation result satisfies the committed-fixture schema.
    expect(ImpactWindowFileSchema.safeParse(window).success).toBe(true)
  })

  it("refuses rows with unknown decision kinds", async () => {
    const db: ImpactQueryable = {
      async query(sql) {
        if (sql === IMPACT_WINDOW_SQL) {
          return { rows: [{ intent_kind: "order.cancel", decision_kind: "MAYBE", count: 1 }] }
        }
        return { rows: [{ count: 0 }] }
      },
    }
    await expect(
      fetchImpactWindow(db, { fromIso: "a", toIso: "b", source: "fake" }),
    ).rejects.toThrow(ImpactWindowError)
  })
})
