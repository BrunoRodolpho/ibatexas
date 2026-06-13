/**
 * Agent → AI-BOM mapping (plan-v2 T3-3): folds the managed-agent roster
 * into the same AI Bill-of-Materials gate that already covers the Packs
 * (`ibx kernel pack-bom --verify-file`, EU AI Act Art. 11 / NIST AI RMF),
 * via the upstream pack-health/PackManifest primitives.
 *
 * Mapping decisions (the agent is BOM'd *as if* it were a pack, with the
 * closest-honest slot for each field):
 *
 *   - `packId`      = `agent/<id>`  (namespaced so the baseline file reads
 *                     unambiguously next to `ibatexas/pack-*` entries)
 *   - `intents`     = `declaredIntentKinds` (the agent's authorization
 *                     envelope — what reviewers actually evaluate)
 *   - `signals`     = `trigger.eventKinds` (what wakes it — the closest
 *                     analog of a pack's signal surface)
 *   - `conformance` = a synthetic ConformanceReport whose checks ARE the
 *                     agent integrity suite (schema validity, declared ⊆
 *                     registered, sessionIdPrefix consistency, D-017
 *                     namespace). `runConformance()` needs a PackV0 with
 *                     policy/planner — an agent has neither, so its
 *                     conformance is its roster integrity.
 *   - `tools`       = one AiBomToolRef whose `schemaDigest` is the
 *                     sha256(canonical JSON) of the ENTIRE AgentDefinition —
 *                     this is the load-bearing slot that puts budgets,
 *                     autonomyStage, trigger subjects, owner and
 *                     killSwitchKey under the bomDigest. Any change to any
 *                     field of the definition is a material re-baseline
 *                     event, exactly like a pack policy change.
 *
 * Determinism: `generateAgentAiBom` is pure given (def, kinds, options) —
 * the caller supplies `generatedAt` (the CLI pins its BOM_GENERATED_AT so
 * the committed artifact stays byte-stable). When a pack REMOVES a kind an
 * agent declares, the synthetic conformance flips to failed → the bomDigest
 * moves → `--verify-file` exits 1: pack drift propagates to the agent gate
 * fail-closed.
 */

import { createHash } from "node:crypto"

import {
  generateAiBom,
  scorePackHealth,
  type AiBom,
  type ConformanceReport,
  type ConformanceResult,
  type PackManifest,
} from "@adjudicate/conformance"

import {
  AgentDefinitionSchema,
  expectedSessionIdPrefix,
  AGENT_SESSION_NAMESPACE,
  type AgentDefinition,
} from "./definition.js"
import { registeredPolicyKinds } from "./drift.js"

/** BOM packId namespace for agents — `agent/<id>` in the baseline file. */
export function agentBomPackId(def: Pick<AgentDefinition, "id">): string {
  return `agent/${def.id}`
}

// ── Canonical definition digest ──────────────────────────────────────────────

/**
 * Sorted-key canonical JSON (JCS subset — the same convention as
 * @adjudicate/conformance's internal serializer, re-implemented here
 * because upstream does not export it). AgentDefinitions are plain JSON
 * data by construction (zod-parsed), so this is total over them.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
  return `{${entries.join(",")}}`
}

/** sha256 hex over the canonical JSON of the FULL definition. */
export function agentDefinitionDigest(def: AgentDefinition): string {
  return createHash("sha256").update(canonicalJson(def), "utf8").digest("hex")
}

// ── PackManifest mapping ─────────────────────────────────────────────────────

export interface AgentBomOptions {
  /** Pinned wall-clock — excluded from bomDigest; keeps artifacts byte-stable. */
  readonly generatedAt: string
  readonly kernelVersion?: string
  /** Defaults to the CLI's "1.0.0" floor. */
  readonly kernelMinVersion?: string
  /** Registered policy-kind universe; defaults to `registeredPolicyKinds()`. */
  readonly kinds?: ReadonlySet<string>
}

export function agentPackManifest(
  def: AgentDefinition,
  options?: Pick<AgentBomOptions, "kernelMinVersion">,
): PackManifest {
  return {
    contract: "v0",
    packId: agentBomPackId(def),
    kernelMinVersion: options?.kernelMinVersion ?? "1.0.0",
    intents: def.declaredIntentKinds,
    signals: def.trigger.eventKinds,
  }
}

// ── Synthetic conformance: the agent integrity suite ─────────────────────────

export function agentConformanceReport(
  def: AgentDefinition,
  kinds: ReadonlySet<string> = registeredPolicyKinds(),
): ConformanceReport {
  const packId = agentBomPackId(def)

  const schema = AgentDefinitionSchema.safeParse(def)
  const unregistered = def.declaredIntentKinds.filter((k) => !kinds.has(k))
  const expectedPrefix = expectedSessionIdPrefix(def.id, def.version)

  const results: ConformanceResult[] = [
    {
      id: "AGT-001",
      name: "agent-definition-schema",
      passed: schema.success,
      details: schema.success
        ? ""
        : schema.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
    },
    {
      id: "AGT-002",
      name: "declared-kinds-registered",
      passed: unregistered.length === 0,
      details:
        unregistered.length === 0
          ? `${def.declaredIntentKinds.length} kind(s) declarados, todos servidos por packs registrados`
          : `kinds sem pack registrado: ${unregistered.join(", ")}`,
    },
    {
      id: "AGT-003",
      name: "session-prefix-consistent",
      passed: def.sessionIdPrefix === expectedPrefix,
      details:
        def.sessionIdPrefix === expectedPrefix
          ? ""
          : `sessionIdPrefix "${def.sessionIdPrefix}" ≠ "${expectedPrefix}"`,
    },
    {
      id: "AGT-004",
      name: "session-namespace-unhashed-agent-prefix",
      passed: def.sessionIdPrefix.startsWith(AGENT_SESSION_NAMESPACE),
      details:
        // D-017: the replay/impact exclusion filters key off `agent:`.
        def.sessionIdPrefix.startsWith(AGENT_SESSION_NAMESPACE)
          ? ""
          : `sessionIdPrefix fora do namespace "${AGENT_SESSION_NAMESPACE}"`,
    },
  ]

  const passedCount = results.filter((r) => r.passed).length
  return {
    packId,
    results,
    passed: passedCount === results.length,
    summary: {
      total: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
    },
  }
}

// ── AiBom generation ─────────────────────────────────────────────────────────

export function generateAgentAiBom(
  def: AgentDefinition,
  options: AgentBomOptions,
): AiBom {
  const kinds = options.kinds ?? registeredPolicyKinds()
  const manifest = agentPackManifest(def, options)
  const conformance = agentConformanceReport(def, kinds)
  const health = scorePackHealth({
    manifest: { ok: true, manifest },
    conformance,
    intentCount: def.declaredIntentKinds.length,
    signalCount: def.trigger.eventKinds.length,
    packId: manifest.packId,
  })
  return generateAiBom({
    pack: {
      id: manifest.packId,
      version: def.version,
      contract: "v0",
      intents: def.declaredIntentKinds,
      signals: def.trigger.eventKinds,
    },
    manifest,
    conformance,
    health,
    generatedAt: options.generatedAt,
    ...(options.kernelVersion !== undefined
      ? { kernelVersion: options.kernelVersion }
      : {}),
    tools: [
      {
        name: `agent-definition:${def.id}`,
        description:
          "Digest sha256 do canonical-JSON da AgentDefinition completa (budgets, trigger, autonomyStage, owner, killSwitchKey)",
        version: def.version,
        schemaDigest: agentDefinitionDigest(def),
      },
    ],
  })
}
