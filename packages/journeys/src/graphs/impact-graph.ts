// graphs/impact-graph.ts — derived impact graph (T2-4).
//
//   intentKind → decision counts over an `intent_audit` window,
//   EXCLUDING the agent session namespace.
//
// The exclusion is the SAME filter the T1b-3 kernel-replay gate pins
// (`packages/cli/src/commands/kernel.ts` — `AGENT_SESSION_ID_PREFIX`,
// re-pinned here because the cli→journeys dependency direction forbids the
// reverse import): rows whose `session_id` carries the UNHASHED `agent:`
// prefix are Stage-0 shadow-agent traffic (plan §5 T3-6) and may never read
// as production signal. Chat rows can never collide — the audit redactor
// hashes their sessionIds (`hashed:` + sha256 slice, D-012).
//
// `fetchImpactWindow` needs a live/seeded audit database; the COMMITTED
// artifact is generated from a fixture captured once from the test stack
// (`graphs/fixtures/impact-window.json`) so the regenerate-and-diff gate
// stays deterministic and DB-free. The generator (`buildImpactGraph`) is
// what matters — recapturing the fixture is `ibx graph export
// --capture-impact` against any audit plane.

import { z } from "zod"

import { JOURNEY_EXPECT_DECISIONS } from "../schema/index.js"
import {
  finalizeGraph,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
} from "./contract.js"

// ── Agent-namespace exclusion (cross-task convention, T1b-3/T2-4/T3-6) ──────

/**
 * UNHASHED session-id prefix of managed-agent audit rows. Mirror of
 * `AGENT_SESSION_ID_PREFIX` in packages/cli/src/commands/kernel.ts (the
 * T1b-3 pin) — the two must move together.
 */
export const AGENT_SESSION_ID_PREFIX = "agent:"

// ── Window fixture / capture shape ───────────────────────────────────────────

export const ImpactWindowFileSchema = z
  .object({
    comment: z.union([z.string(), z.array(z.string())]).optional(),
    window: z
      .object({ fromIso: z.string().min(1), toIso: z.string().min(1) })
      .strict(),
    /** Provenance label (e.g. "test-stack intent_audit, golden-vector seeded"). */
    source: z.string().min(1),
    /** Rows excluded by the agent-namespace filter — always reported. */
    excludedAgentRows: z.number().int().nonnegative(),
    rows: z.array(
      z
        .object({
          intentKind: z.string().min(1),
          decision: z.enum(JOURNEY_EXPECT_DECISIONS),
          count: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()

export type ImpactWindowFile = z.infer<typeof ImpactWindowFileSchema>

// ── Live aggregation (requires a seeded audit database) ─────────────────────

/** Structural pg client/pool subset (tests inject a double). */
export interface ImpactQueryable {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/**
 * The aggregation SQL — agent-namespace rows are excluded in SQL (same
 * predicate as the T1b-3 replay gate) and counted separately so the
 * exclusion is always visible in the artifact, never silent. The envelope
 * kind column is `kind` (audit-postgres schema; the composite index
 * `idx_intent_audit_kind_decision` serves exactly this aggregation).
 */
export const IMPACT_WINDOW_SQL =
  "SELECT kind AS intent_kind, decision_kind, COUNT(*)::int AS count " +
  "FROM intent_audit " +
  "WHERE recorded_at >= $1 AND recorded_at < $2 " +
  "AND session_id NOT LIKE $3 " +
  "GROUP BY kind, decision_kind " +
  "ORDER BY kind, decision_kind"

export const IMPACT_EXCLUDED_SQL =
  "SELECT COUNT(*)::int AS count " +
  "FROM intent_audit " +
  "WHERE recorded_at >= $1 AND recorded_at < $2 " +
  "AND session_id LIKE $3"

export class ImpactWindowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImpactWindowError"
  }
}

const DECISION_SET: ReadonlySet<string> = new Set(JOURNEY_EXPECT_DECISIONS)

/**
 * Aggregate one `intent_audit` window into the impact-window shape,
 * excluding (and counting) the agent session namespace.
 */
export async function fetchImpactWindow(
  db: ImpactQueryable,
  args: { fromIso: string; toIso: string; source: string },
): Promise<ImpactWindowFile> {
  const params = [args.fromIso, args.toIso, `${AGENT_SESSION_ID_PREFIX}%`]
  const aggregated = await db.query(IMPACT_WINDOW_SQL, params)
  const excluded = await db.query(IMPACT_EXCLUDED_SQL, params)

  const rows = aggregated.rows.map((row) => {
    const intentKind = row.intent_kind
    const decision = row.decision_kind
    const count = Number(row.count)
    if (typeof intentKind !== "string" || intentKind === "") {
      throw new ImpactWindowError("intent_audit row without intent_kind")
    }
    if (typeof decision !== "string" || !DECISION_SET.has(decision)) {
      throw new ImpactWindowError(
        `intent_audit row with unknown decision_kind "${String(decision)}"`,
      )
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new ImpactWindowError(`bad aggregation count for ${intentKind}`)
    }
    return {
      intentKind,
      decision: decision as ImpactWindowFile["rows"][number]["decision"],
      count,
    }
  })

  return {
    window: { fromIso: args.fromIso, toIso: args.toIso },
    source: args.source,
    excludedAgentRows: Number(excluded.rows[0]?.count ?? 0),
    rows,
  }
}

// ── Builder ──────────────────────────────────────────────────────────────────

/** Build the impact graph from an aggregated window. Pure. */
export function buildImpactGraph(window: ImpactWindowFile): GraphDocument {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const kindTotals = new Map<string, number>()
  const decisionTotals = new Map<string, number>()
  for (const row of window.rows) {
    kindTotals.set(row.intentKind, (kindTotals.get(row.intentKind) ?? 0) + row.count)
    decisionTotals.set(row.decision, (decisionTotals.get(row.decision) ?? 0) + row.count)
  }

  for (const [kind, total] of kindTotals) {
    nodes.push({
      id: `intent:${kind}`,
      type: "intent",
      label: kind,
      meta: { domain: kind.split(".")[0] ?? "", total },
    })
  }
  for (const [decision, total] of decisionTotals) {
    nodes.push({
      id: `decision:${decision}`,
      type: "decision",
      label: decision,
      meta: { total },
    })
  }
  for (const row of window.rows) {
    edges.push({
      from: `intent:${row.intentKind}`,
      to: `decision:${row.decision}`,
      type: "decided",
      meta: { count: row.count },
    })
  }

  const totalEnvelopes = window.rows.reduce((sum, r) => sum + r.count, 0)
  return finalizeGraph({
    version: 1,
    graph: "impact",
    meta: {
      window: { fromIso: window.window.fromIso, toIso: window.window.toIso },
      source: window.source,
      agentSessionPrefixExcluded: AGENT_SESSION_ID_PREFIX,
      excludedAgentRows: window.excludedAgentRows,
      intentKinds: kindTotals.size,
      totalEnvelopes,
    },
    nodes,
    edges,
  })
}
