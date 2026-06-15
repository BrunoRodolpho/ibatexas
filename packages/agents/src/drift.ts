/**
 * agentRosterDrift() — the roster-integrity gate for managed agents
 * (plan-v2 T3-3), the agent-side sibling of `toolRosterDrift()`.
 *
 * Invariants enforced (each finding carries a stable machine code):
 *
 *   1. `schema_invalid`            — every registry entry re-validates against
 *                                    `AgentDefinitionSchema` (covers registries
 *                                    composed from non-literal sources).
 *   2. `kind_not_registered`       — declared ⊆ registered policy kinds: every
 *                                    `declaredIntentKinds` entry must be served
 *                                    by a kernel Pack policy (the composed
 *                                    first-party packs ∪ the platform PIX
 *                                    pack). An agent that declares a kind no
 *                                    pack adjudicates would express envelopes
 *                                    the kernel cannot decide.
 *   3. `session_prefix_mismatch`   — sessionIdPrefix ↔ registry consistency
 *                                    (`agent:<id>@<version>`, D-017): the
 *                                    audit-namespace exclusion filters key off
 *                                    this prefix.
 *   4. `duplicate_agent_id` / `duplicate_session_prefix` /
 *      `duplicate_kill_switch_key` — registry-level uniqueness; a shared
 *                                    prefix would alias two agents in the
 *                                    audit namespace, a shared kill-switch key
 *                                    would stop the wrong agent.
 *
 * Boot-time fail-closed: composition roots that run agents (the T3-2
 * trigger-bridge worker once it lands; the T3-6 shadow composition) MUST
 * call `assertAgentRosterIntegrity()` before opening any capsule. Until the
 * worker exists, the registry's own test invokes it (T3-3 item 4).
 */

import { paymentsPixPack } from "@adjudicate/pack-payments-pix"
import { composedIntentKinds } from "@ibatexas/packs-composed"

import {
  AgentDefinitionSchema,
  expectedSessionIdPrefix,
  type AgentDefinition,
} from "./definition.js"
import { AGENT_REGISTRY } from "./registry.js"

// ── Registered policy kinds ──────────────────────────────────────────────────

/**
 * The kernel-adjudicable intent-kind universe an agent may declare against:
 * the five composed first-party packs (`composedIntentKinds()`, runtime-
 * derived so it can never drift from the pack objects) ∪ the platform
 * adopter pack `@adjudicate/pack-payments-pix` (`pix.charge.*` — composed
 * separately by the kernel boot roster, deliberately NOT in
 * `@ibatexas/packs-composed`; see that package's docstring).
 */
export function registeredPolicyKinds(): ReadonlySet<string> {
  return new Set<string>([...composedIntentKinds(), ...paymentsPixPack.intents])
}

// ── Drift findings ───────────────────────────────────────────────────────────

export type AgentRosterDriftCode =
  | "schema_invalid"
  | "kind_not_registered"
  | "session_prefix_mismatch"
  | "duplicate_agent_id"
  | "duplicate_session_prefix"
  | "duplicate_kill_switch_key"

export interface AgentRosterDriftFinding {
  readonly agentId: string
  readonly code: AgentRosterDriftCode
  readonly detail: string
}

/**
 * Pure roster check. Defaults to the composed `AGENT_REGISTRY` against the
 * live `registeredPolicyKinds()`; both injectable for fixtures.
 */
export function agentRosterDrift(
  registry: ReadonlyArray<AgentDefinition> = AGENT_REGISTRY,
  kinds: ReadonlySet<string> = registeredPolicyKinds(),
): ReadonlyArray<AgentRosterDriftFinding> {
  const findings: AgentRosterDriftFinding[] = []

  const seenIds = new Set<string>()
  const seenPrefixes = new Set<string>()
  const seenKillSwitchKeys = new Set<string>()

  for (const def of registry) {
    // 1. Schema re-validation (fail-closed for non-literal registries).
    const parsed = AgentDefinitionSchema.safeParse(def)
    if (!parsed.success) {
      findings.push({
        agentId: def.id ?? "<sem id>",
        code: "schema_invalid",
        detail: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      })
      // A schema-invalid entry still participates in the uniqueness scans
      // below where its fields are present — duplicates must not hide
      // behind a second, unrelated violation.
    }

    // 2. declared ⊆ registered policy kinds.
    for (const kind of def.declaredIntentKinds ?? []) {
      if (!kinds.has(kind)) {
        findings.push({
          agentId: def.id,
          code: "kind_not_registered",
          detail: `declaredIntentKind "${kind}" não é servido por nenhum pack registrado`,
        })
      }
    }

    // 3. sessionIdPrefix ↔ registry consistency (D-017).
    const expected = expectedSessionIdPrefix(def.id, def.version)
    if (def.sessionIdPrefix !== expected) {
      findings.push({
        agentId: def.id,
        code: "session_prefix_mismatch",
        detail: `sessionIdPrefix "${def.sessionIdPrefix}" ≠ esperado "${expected}"`,
      })
    }

    // 4. Registry-level uniqueness.
    if (seenIds.has(def.id)) {
      findings.push({
        agentId: def.id,
        code: "duplicate_agent_id",
        detail: `id "${def.id}" registrado mais de uma vez`,
      })
    }
    seenIds.add(def.id)

    if (seenPrefixes.has(def.sessionIdPrefix)) {
      findings.push({
        agentId: def.id,
        code: "duplicate_session_prefix",
        detail: `sessionIdPrefix "${def.sessionIdPrefix}" compartilhado por mais de um agente`,
      })
    }
    seenPrefixes.add(def.sessionIdPrefix)

    if (seenKillSwitchKeys.has(def.killSwitchKey)) {
      findings.push({
        agentId: def.id,
        code: "duplicate_kill_switch_key",
        detail: `killSwitchKey "${def.killSwitchKey}" compartilhado por mais de um agente`,
      })
    }
    seenKillSwitchKeys.add(def.killSwitchKey)
  }

  return findings
}

// ── Boot-time fail-closed assert ─────────────────────────────────────────────

/**
 * Throws when the roster drifts — the boot gate for every composition that
 * runs agents (same spirit as `toolRosterDrift()` in claustrum-bootstrap).
 * Wire this as the FIRST statement of the trigger-bridge worker boot (T3-2)
 * and of the Stage-0 shadow composition (T3-6).
 */
export function assertAgentRosterIntegrity(
  registry: ReadonlyArray<AgentDefinition> = AGENT_REGISTRY,
  kinds: ReadonlySet<string> = registeredPolicyKinds(),
): void {
  const findings = agentRosterDrift(registry, kinds)
  if (findings.length > 0) {
    const lines = findings.map(
      (f) => `  - [${f.agentId}] ${f.code}: ${f.detail}`,
    )
    throw new Error(
      `agent roster drift — composição de agentes recusada (fail-closed):\n${lines.join("\n")}`,
    )
  }
}
