/**
 * Governance artifact producers — AI-BOM / config-seal / policy-coherence
 * manifests for the ibatexas adopter (ERDS-055/056/057).
 *
 * These are the producer-half of three ARTIFACT EXPORTERS (`ibx aibom export`,
 * `ibx seal export`, `ibx coherence export`) that mirror `ibx policy export`:
 * each builds a committed, byte-stable JSON manifest that CI re-generates and
 * `--verify-file` diffs against for drift (EU AI Act Art. 11 / NIST AI RMF /
 * ADR-121 config-seal / ADR-109 coherence).
 *
 * They REUSE — never re-implement — the platform analyzers already wired into
 * the `ibx kernel pack-bom / seal / analyze` governance GATES:
 *   - `generateAiBom`            (@adjudicate/conformance, via runConformance +
 *                                 scorePackHealth) and `generateAgentAiBom`
 *                                 (@ibatexas/agents) for the AI-BOM,
 *   - `extractSealableSurface` + `computeConfigDigest` (@adjudicate/conformance)
 *                                 for the config-seal,
 *   - `analyzePolicy`            (@adjudicate/analyze) for policy coherence.
 *
 * Pure (no I/O, no clock except the caller-supplied `generatedAt`, which is
 * EXCLUDED from every digest): the CLI owns path resolution + writing the
 * artifact, exactly like `buildIbatexasPolicyManifest` + `policy.ts`.
 *
 * Unlike the policy manifest (whose adopter-guard composition lives in
 * apps/api), the BOM / seal / coherence analyzers operate on the RAW
 * first-party packs + the managed-agent roster — both reachable from
 * `packages/*` — so these producers live in the CLI package alongside the
 * `ibx kernel *` gates that already invoke the same functions (no apps/api
 * round-trip, no drift between gate and exporter).
 */

import {
  generateAiBom,
  runConformance,
  scorePackHealth,
  extractSealableSurface,
  computeConfigDigest,
  type AiBom,
  type PackManifest,
} from "@adjudicate/conformance"
import { analyzePolicy } from "@adjudicate/analyze"

// ── Shared governance constants (mirror ibx kernel pack-bom) ────────────────
//
// Single named constants per Hard Rule #3 — NOT authored per-pack. A core bump
// is a material re-baseline event. These MUST match kernel.ts's governance
// constants so the exporter artifact and the `ibx kernel pack-bom` gate agree.
export const KERNEL_MIN_VERSION = "1.0.0"
export const KERNEL_VERSION = "1.3.0"
/**
 * Pinned wall-clock used as the BOM `generatedAt` — EXCLUDED from `bomDigest`
 * (the digest covers everything except generatedAt + signature), so the
 * committed artifact stays byte-stable across runs.
 */
export const BOM_GENERATED_AT = "2026-06-07T00:00:00.000Z"

/** Minimal raw-pack shape the producers need (mirrors kernel.ts GovernancePack). */
export interface GovernancePackLike {
  readonly id: string
  readonly version: string
  readonly contract: string
  readonly intents: readonly string[]
  readonly signals?: readonly string[]
  readonly basisCodes?: readonly string[]
  readonly policy: unknown
  readonly planner: unknown
}

/** Roster of managed agents folded into the AI-BOM (resolved lazily by the CLI). */
export interface AgentRosterLike {
  readonly AGENT_REGISTRY: ReadonlyArray<unknown>
  readonly agentRosterDrift: () => ReadonlyArray<{
    readonly agentId: string
    readonly code: string
    readonly detail: string
  }>
  readonly generateAgentAiBom: (
    def: unknown,
    options: {
      generatedAt: string
      kernelVersion?: string
      kernelMinVersion?: string
    },
  ) => AiBom
}

// ── Shared byte-stable comparator ───────────────────────────────────────────
//
// #93-1: code-unit (byte-stable) order, NOT locale-sensitive localeCompare —
// the manifests are byte-stable artifacts verified across environments, so the
// sort must not depend on LC_COLLATE / the ICU version.
function comparePackId(
  a: { readonly packId: string },
  b: { readonly packId: string },
): number {
  if (a.packId < b.packId) return -1
  if (a.packId > b.packId) return 1
  return 0
}

// ── AI-BOM manifest (ERDS-055) ──────────────────────────────────────────────

export interface AiBomManifest {
  readonly schemaVersion: 1
  readonly adopter: "ibatexas"
  readonly kernelMinVersion: string
  readonly kernelVersion: string
  /** Sorted `packId → bomDigest` map — the drift-gate surface. */
  readonly digests: Readonly<Record<string, string>>
  /** Full per-pack/agent AI-BOMs, sorted by packId. `generatedAt` elided. */
  readonly boms: ReadonlyArray<Omit<AiBom, "generatedAt">>
  /** Wall clock — informational only, EXCLUDED from every digest. */
  readonly generatedAt?: string
}

function packManifestOf(pack: GovernancePackLike): PackManifest {
  return {
    contract: pack.contract as "v0" | "v1",
    packId: pack.id,
    kernelMinVersion: KERNEL_MIN_VERSION,
    intents: pack.intents,
    ...(pack.signals ? { signals: pack.signals } : {}),
  } as PackManifest
}

function bomForPack(pack: GovernancePackLike): AiBom {
  const conformance = runConformance(pack as never)
  const manifest = packManifestOf(pack)
  const health = scorePackHealth({
    manifest: { ok: true, manifest },
    conformance,
    intentCount: pack.intents.length,
    signalCount: pack.signals?.length ?? 0,
    packId: pack.id,
  })
  return generateAiBom({
    pack: pack as never,
    manifest,
    conformance,
    health,
    generatedAt: BOM_GENERATED_AT,
    kernelVersion: KERNEL_VERSION,
  })
}

export interface BuildAiBomManifestOptions {
  readonly packs: ReadonlyArray<GovernancePackLike>
  /**
   * Managed-agent roster (T3-3). When supplied, each AgentDefinition folds
   * into the same digest map keyed `agent/<id>`. Omitted under `--pack`.
   * `agentRosterDrift()` is run fail-closed: a drifting roster throws so it
   * can never be baselined or verified green.
   */
  readonly agents?: AgentRosterLike
  /** Informational wall clock (excluded from digests). */
  readonly generatedAt?: string
}

/**
 * Build the byte-stable AI-BOM manifest from the raw first-party packs + the
 * managed-agent roster, reusing `generateAiBom` / `generateAgentAiBom`.
 * Throws on agent-roster drift (fail-closed).
 */
export function buildAiBomManifest(opts: BuildAiBomManifestOptions): AiBomManifest {
  const boms: AiBom[] = []
  for (const pack of opts.packs) boms.push(bomForPack(pack))

  if (opts.agents) {
    const drift = opts.agents.agentRosterDrift()
    if (drift.length > 0) {
      throw new Error(
        "agent-roster drift:\n" +
          drift.map((f) => `  [${f.agentId}] ${f.code}: ${f.detail}`).join("\n"),
      )
    }
    for (const def of opts.agents.AGENT_REGISTRY) {
      boms.push(
        opts.agents.generateAgentAiBom(def, {
          generatedAt: BOM_GENERATED_AT,
          kernelVersion: KERNEL_VERSION,
          kernelMinVersion: KERNEL_MIN_VERSION,
        }),
      )
    }
  }

  // #93-1: code-unit (byte-stable) order, NOT locale-sensitive localeCompare —
  // the manifest is a byte-stable artifact verified across environments, so its
  // sort must not depend on LC_COLLATE / the ICU version.
  boms.sort(comparePackId)
  const digests: Record<string, string> = {}
  const stripped: Array<Omit<AiBom, "generatedAt">> = []
  for (const bom of boms) {
    // #93-2: fail closed — two components collapsing to the same packId would
    // silently overwrite (last-wins) in the digest map; throw instead.
    if (bom.packId in digests) {
      throw new Error(`duplicate AI-BOM component id: ${bom.packId}`)
    }
    digests[bom.packId] = bom.bomDigest
    const { generatedAt: _omit, ...rest } = bom
    stripped.push(rest)
  }

  return {
    schemaVersion: 1,
    adopter: "ibatexas",
    kernelMinVersion: KERNEL_MIN_VERSION,
    kernelVersion: KERNEL_VERSION,
    digests,
    boms: stripped,
    ...(opts.generatedAt === undefined ? {} : { generatedAt: opts.generatedAt }),
  }
}

// ── Config-seal manifest (ERDS-056) ─────────────────────────────────────────

export interface ConfigSealEntry {
  readonly packId: string
  readonly packVersion: string
  readonly digest: string
}

export interface ConfigSealManifest {
  readonly schemaVersion: 1
  readonly adopter: "ibatexas"
  /** Sorted `packId → configDigest` map — the boot-gate / drift surface. */
  readonly digests: Readonly<Record<string, string>>
  /** Per-pack seal entries, sorted by packId. */
  readonly seals: ReadonlyArray<ConfigSealEntry>
  readonly generatedAt?: string
}

export interface BuildConfigSealManifestOptions {
  readonly packs: ReadonlyArray<GovernancePackLike>
  readonly generatedAt?: string
}

/**
 * Build the byte-stable config-seal manifest, reusing `extractSealableSurface`
 * + `computeConfigDigest` (the same functions `ibx kernel seal` prints to fix
 * CONFIG_SEAL_DIGESTS for the boot-gate). The digest is independent of any
 * clock or signature, so the artifact is reproducible.
 */
export function buildConfigSealManifest(
  opts: BuildConfigSealManifestOptions,
): ConfigSealManifest {
  const seals: ConfigSealEntry[] = []
  for (const pack of opts.packs) {
    const digest = computeConfigDigest(extractSealableSurface(pack as never))
    seals.push({ packId: pack.id, packVersion: pack.version, digest })
  }
  // #93-1: code-unit (byte-stable) order — see buildAiBomManifest.
  seals.sort(comparePackId)
  const digests: Record<string, string> = {}
  for (const s of seals) digests[s.packId] = s.digest

  return {
    schemaVersion: 1,
    adopter: "ibatexas",
    digests,
    seals,
    ...(opts.generatedAt === undefined ? {} : { generatedAt: opts.generatedAt }),
  }
}

// ── Policy-coherence manifest (ERDS-057) ────────────────────────────────────

export interface CoherencePackReport {
  readonly packId: string
  readonly packVersion?: string
  readonly passed: boolean
  readonly summary: {
    readonly error: number
    readonly warning: number
    readonly note: number
  }
  readonly diagnostics: ReadonlyArray<{
    readonly code: string
    readonly severity: string
    readonly message: string
    readonly guardId?: string
    readonly phase?: string
  }>
}

export interface CoherenceManifest {
  readonly schemaVersion: 1
  readonly adopter: "ibatexas"
  readonly passed: boolean
  readonly totals: {
    readonly error: number
    readonly warning: number
    readonly note: number
  }
  /** Per-pack Tier-1 coherence reports, sorted by packId. `analyzedAt` elided. */
  readonly packs: ReadonlyArray<CoherencePackReport>
  readonly generatedAt?: string
}

export interface BuildCoherenceManifestOptions {
  readonly packs: ReadonlyArray<GovernancePackLike>
  readonly generatedAt?: string
}

/**
 * Build the byte-stable policy-coherence manifest, reusing `analyzePolicy`
 * (the same Tier-1 analyzers `ibx kernel analyze` gates on). The analyzer's
 * `analyzedAt` field is render-only and is ELIDED here so the committed
 * artifact stays deterministic; the manifest's own `generatedAt` is optional
 * and excluded from any equality check the CLI performs (it strips it).
 */
export function buildCoherenceManifest(
  opts: BuildCoherenceManifestOptions,
): CoherenceManifest {
  const packs: CoherencePackReport[] = []
  let passed = true
  let error = 0
  let warning = 0
  let note = 0
  for (const pack of opts.packs) {
    const report = analyzePolicy({ pack: pack as never })
    if (!report.passed) passed = false
    error += report.summary.error
    warning += report.summary.warning
    note += report.summary.note
    packs.push({
      packId: report.packId,
      ...(report.packVersion === undefined
        ? {}
        : { packVersion: report.packVersion }),
      passed: report.passed,
      summary: {
        error: report.summary.error,
        warning: report.summary.warning,
        note: report.summary.note,
      },
      diagnostics: report.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        message: d.message,
        ...(d.guardId === undefined ? {} : { guardId: d.guardId }),
        ...(d.phase === undefined ? {} : { phase: d.phase }),
      })),
    })
  }
  // #93-1: code-unit (byte-stable) order — see buildAiBomManifest.
  packs.sort(comparePackId)

  return {
    schemaVersion: 1,
    adopter: "ibatexas",
    passed,
    totals: { error, warning, note },
    packs,
    ...(opts.generatedAt === undefined ? {} : { generatedAt: opts.generatedAt }),
  }
}
