// graphs/capability-graph.ts — derived capability graph (T2-4).
//
//   packs → intentKinds → tools/planners
//
// Sources (all build-time imports — the graph can never drift from the
// composition without `ibx graph export --check` going red):
//   * `IBATEXAS_COMPOSED_PACKS` + `IBATEXAS_COMPOSED_CAPABILITY_PLANNERS`
//     (@ibatexas/packs-composed) — pack→intent declarations and the live
//     planner advertisement probe;
//   * `KNOWN_INTENT_KINDS` (@ibatexas/intent-kinds) — the full kind union
//     (incl. pix.* / loyalty.* the composed packs deliberately exclude);
//   * `CHAT_DRIVABLE_TOOL_KINDS` — the registered chat-drivable tool roster
//     (capability := intentKind, mirrored from apps/api per T1a-2);
//   * pack policy metadata via `plausibleDecisions` (gates/coverage.ts).
//
// The P0-7 roster facts are first-class:
//   * DANGLING (`advertised-no-tool`)      — a planner advertises the kind
//     in some persona context, but no registered tool carries it;
//   * UNADVERTISED (`registered-not-advertised`) — a tool is registered for
//     the kind, but no planner advertises it in ANY persona context (e.g.
//     the WS4 de-advertised payment kinds).
// Both are flagged on the intent node (`meta.flags`) AND summarized in the
// graph meta — the viewer renders them; the apps/api `toolRosterDrift` boot
// gate remains the enforcement point.

import type { CapabilityPlanner } from "@adjudicate/core/llm"
import { KNOWN_INTENT_KINDS } from "@ibatexas/intent-kinds"
import {
  CHAT_DRIVABLE_TOOL_KINDS,
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
  IBATEXAS_COMPOSED_PACKS,
} from "@ibatexas/packs-composed"

import { plausibleDecisions } from "../gates/coverage.js"
import { STAFF_ROUTE_KINDS, type JourneyPersonaContext } from "../gates/lint.js"
import type { JsonValue } from "../schema/index.js"
import {
  finalizeGraph,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
} from "./contract.js"

// ── Persona-context planner probe ────────────────────────────────────────────
//
// Mirror of the probe in gates/lint.ts (which is itself the replicated
// apps/api `ROSTER_DRIFT_CONTEXTS` literal — apps/api is unreachable from
// packages/* by design). lint exports only the cross-planner UNION
// (`advertisedChatKinds`); the capability graph needs PER-PLANNER edges, so
// the tiny probe literal lives here too. If the planner ctx shape changes,
// the apps/api drift leg, gates/lint.ts and this probe move together.

export const CAPABILITY_PERSONA_CONTEXTS: readonly JourneyPersonaContext[] = [
  "authed-customer",
  "guest",
]

function plannerProbeState(over: {
  customerId: string | null
  staffId: string | null
  isAuthenticated: boolean
}): unknown {
  return {
    ctx: {
      tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
      channel: "web",
      cartId: null,
      orderId: null,
      ...over,
    },
  }
}

const PROBE_STATES: Record<JourneyPersonaContext, unknown> = {
  "authed-customer": plannerProbeState({
    customerId: "graph-probe-customer",
    staffId: null,
    isAuthenticated: true,
  }),
  guest: plannerProbeState({
    customerId: null,
    staffId: null,
    isAuthenticated: false,
  }),
}

function plannerAdvertised(
  planner: CapabilityPlanner<unknown, unknown>,
  context: JourneyPersonaContext,
): ReadonlySet<string> {
  return new Set(planner.plan(PROBE_STATES[context], {}).allowedIntents)
}

// ── Pack introspection (mirror of gates/coverage.ts's structural view) ──────

interface IntrospectablePack {
  readonly id: string
  readonly version?: string
  readonly intents: ReadonlyArray<string>
  readonly policy: { readonly default: "REFUSE" | "EXECUTE" }
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build the capability graph from the live composition. Pure given its
 * build-time imports — same inputs, same bytes (contract.ts determinism).
 */
export function buildCapabilityGraph(): GraphDocument {
  const packs = IBATEXAS_COMPOSED_PACKS as ReadonlyArray<IntrospectablePack>
  const planners = IBATEXAS_COMPOSED_CAPABILITY_PLANNERS

  // Planner ↔ pack association: packs-composed documents BOTH lists in
  // canonical pack order, so they zip by index; a length mismatch falls back
  // to positional planner ids rather than mis-attributing.
  const plannerEntries = planners.map((planner, i) => {
    const pack = packs.length === planners.length ? packs[i] : undefined
    const id = pack !== undefined ? `planner:${pack.id}` : `planner:${i}`
    const advertised: Record<JourneyPersonaContext, ReadonlySet<string>> = {
      "authed-customer": plannerAdvertised(planner, "authed-customer"),
      guest: plannerAdvertised(planner, "guest"),
    }
    return { id, packId: pack?.id ?? null, advertised }
  })

  // Per-kind advertisement: kind → planner id → contexts.
  const advertisedBy = new Map<string, Map<string, JourneyPersonaContext[]>>()
  for (const entry of plannerEntries) {
    for (const context of CAPABILITY_PERSONA_CONTEXTS) {
      for (const kind of entry.advertised[context]) {
        const byPlanner = advertisedBy.get(kind) ?? new Map<string, JourneyPersonaContext[]>()
        const contexts = byPlanner.get(entry.id) ?? []
        contexts.push(context)
        byPlanner.set(entry.id, contexts)
        advertisedBy.set(kind, byPlanner)
      }
    }
  }

  const registered = new Set(CHAT_DRIVABLE_TOOL_KINDS)
  const packByKind = new Map<string, IntrospectablePack>()
  for (const pack of packs) {
    for (const kind of pack.intents) {
      if (!packByKind.has(kind)) packByKind.set(kind, pack)
    }
  }

  // Intent domain: every kind any source names (a planner advertising an
  // out-of-union kind must still surface — that too is a dangling fact).
  const intentDomain = new Set<string>([
    ...KNOWN_INTENT_KINDS,
    ...packByKind.keys(),
    ...registered,
    ...STAFF_ROUTE_KINDS,
    ...advertisedBy.keys(),
  ])

  // ── The P0-7 facts ────────────────────────────────────────────────────────
  const dangling = [...advertisedBy.keys()].filter((kind) => !registered.has(kind)).sort()
  const unadvertised = [...registered].filter((kind) => !advertisedBy.has(kind)).sort()

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  for (const pack of packs) {
    nodes.push({
      id: `pack:${pack.id}`,
      type: "pack",
      label: pack.id,
      meta: {
        intentCount: pack.intents.length,
        policyDefault: pack.policy.default,
        ...(pack.version !== undefined ? { version: pack.version } : {}),
      },
    })
    for (const kind of pack.intents) {
      edges.push({ from: `pack:${pack.id}`, to: `intent:${kind}`, type: "declares" })
    }
  }

  for (const kind of [...intentDomain].sort()) {
    const byPlanner = advertisedBy.get(kind)
    const advertisedContexts = [
      ...new Set([...(byPlanner?.values() ?? [])].flat()),
    ].sort()
    const flags: string[] = []
    if (byPlanner !== undefined && !registered.has(kind)) flags.push("dangling")
    if (registered.has(kind) && byPlanner === undefined) flags.push("unadvertised")
    nodes.push({
      id: `intent:${kind}`,
      type: "intent",
      label: kind,
      meta: {
        domain: kind.split(".")[0] ?? "",
        knownKind: KNOWN_INTENT_KINDS.has(kind),
        composedPack: packByKind.get(kind)?.id ?? null,
        chatDrivable: registered.has(kind),
        staffRoute: STAFF_ROUTE_KINDS.has(kind),
        advertisedContexts,
        plausibleDecisions: [...plausibleDecisions(kind)],
        flags,
      },
    })
  }

  for (const kind of CHAT_DRIVABLE_TOOL_KINDS) {
    nodes.push({
      id: `tool:${kind}`,
      type: "tool",
      label: kind,
      meta: { capability: kind, surface: "chat" },
    })
    edges.push({ from: `intent:${kind}`, to: `tool:${kind}`, type: "registers" })
  }

  for (const entry of plannerEntries) {
    nodes.push({
      id: entry.id,
      type: "planner",
      label:
        entry.packId !== null
          ? `${entry.packId} capability planner`
          : entry.id,
      meta: {
        pack: entry.packId,
        advertisedCounts: Object.fromEntries(
          CAPABILITY_PERSONA_CONTEXTS.map((c) => [c, entry.advertised[c].size]),
        ) as Record<string, JsonValue>,
      },
    })
    if (entry.packId !== null) {
      edges.push({ from: `pack:${entry.packId}`, to: entry.id, type: "plans" })
    }
  }

  for (const [kind, byPlanner] of advertisedBy) {
    for (const [plannerId, contexts] of byPlanner) {
      edges.push({
        from: plannerId,
        to: `intent:${kind}`,
        type: "advertises",
        meta: { contexts: [...new Set(contexts)].sort() },
      })
    }
  }

  return finalizeGraph({
    version: 1,
    graph: "capability",
    meta: {
      packs: packs.length,
      planners: plannerEntries.length,
      intentKinds: intentDomain.size,
      registeredTools: CHAT_DRIVABLE_TOOL_KINDS.length,
      personaContexts: [...CAPABILITY_PERSONA_CONTEXTS],
      // The P0-7 roster facts, summarized for the viewer.
      dangling,
      unadvertised,
    },
    nodes,
    edges,
  })
}
