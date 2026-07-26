// PASS 4 — TERMINAL COVERAGE (LE2-016).
//
// Every capability that declares an adjudicated path declares a COMPLETE set
// of terminals for it. Ticket 16's fourth rejection class: "journey/render
// paths with uncovered terminals".
//
// # Which terminals the catalog actually declares today
//
// Two disciplines meet in this repo, and only one of them has catalog data:
//
//   - KERNEL terminals — `EXECUTE | CONFIRM | ESCALATE | DEFER`, with `REFUSE`
//     as the `PolicyBundle.default` floor. A chat-tier capability declares
//     BOTH halves: `guardRefs` (the chain that can reach a non-refuse
//     terminal) and `refusalCode` (the floor it falls through to). types.ts
//     states the coupling verbatim: `refusalCode` is "the pack-level
//     default-deny basis code this capability falls through to when no guard
//     in its chain reaches a terminal EXECUTE / CONFIRM / ESCALATE / DEFER".
//     This pass enforces that coupling.
//
//   - RENDER terminals — `RENDER | UNKNOWN | ESCALATE | CLARIFY` (CLAUDE.md's
//     claims-runtime discipline). The catalog declares NONE of these today: it
//     holds no templates, no journeys, and no render paths (Decision 13 keeps
//     them out until what exists is unified; they arrive with tickets 20/22).
//     Checking render-terminal completeness would mean inventing the render
//     objects to check — so this pass covers the terminals the data DECLARES,
//     and the render half activates when the data does. The pass id and
//     diagnostic shape are already the ones those rules will emit under.
//
// # The four rules
//
// 1. `missing-refusal-terminal` — a guard chain with no floor. Every path
//    through the chain that reaches no terminal falls through to REFUSE, and
//    the capability names no basis code for it.
// 2. `refusal-terminal-without-chain` — a floor with no chain. Nothing can
//    reach EXECUTE/CONFIRM/ESCALATE/DEFER, so REFUSE is the capability's ONLY
//    reachable terminal: it is dead on arrival, not merely conservative.
// 3. `divergent-pack-refusal-terminal` — capabilities of one Pack declaring
//    DIFFERENT floors. A Pack has exactly one `PolicyBundle.default` basis
//    code, so the codes cannot all be right; at least one capability's
//    fall-through terminal is mis-declared, and `generate-refusal-codes.ts`
//    projects the wrong one.
// 4. `divergent-pack-guard-chain` — capabilities of one Pack declaring
//    DIFFERENT chains. types.ts is explicit that the chain is "the OWNING
//    PACK's full stateGuards / authGuards / business guard-name list, in
//    bundle order", pack-wide "by construction" and NOT a per-kind subset. A
//    capability whose chain omits (or invents) an entry describes a reachable-
//    terminal set the kernel will not produce.
// 5. `unreachable-guard-phase` — a `phase: "taint"` guard ref. `GuardPhase`
//    admits `"taint"` for `GuardFireStats` symmetry, so the type system
//    accepts it, but types.ts's own scope note records why nothing can resolve
//    it: "a Pack's `taint` slot is a single `TaintPolicy` value, not a
//    `Guard[]` array — there is nothing here to reference by name". The
//    reference names a terminal source that does not exist.
//
// Rules 3 and 4 are the ones a per-object check can never see: they are
// COVERAGE statements over a Pack's whole capability set, which is exactly
// what "terminal coverage" means and why this is a compiler pass rather than
// a stricter type.
//
// # Identity-tier capabilities are not holes
//
// An identity-tier capability declares no terminals at all, and that is
// correct rather than uncovered: it has no chat tool and no registered
// adjudicated surface to describe, so `types.ts` gives it no slot to describe
// one with. A chat-only slot appearing on it is the slot-dataflow pass's
// `orphan-slot`, not a terminal fault.
//
// Pure: no clock, no RNG, no IO.

import { GUARD_REF_PHASES } from "../../capability-definitions/vocabularies.js"
import type { CapabilityDefinition } from "../../capability-definitions/types.js"
import {
  capabilityObjectName,
  packObjectName,
  type CatalogDiagnostic,
  type CatalogPassResult,
} from "../diagnostics.js"
import { asRecord, isNonBlankString } from "../slots.js"

const PASS = "terminal-coverage" as const

interface CapabilityView {
  readonly object: string
  readonly kind: string
  readonly pack: string
  readonly refusalCode?: string
  readonly guardRefs?: readonly unknown[]
}

function view(def: CapabilityDefinition, index: number): CapabilityView {
  const record = asRecord(def)
  const kind = record["kind"]
  const pack = record["pack"]
  const refusalCode = record["refusalCode"]
  const guardRefs = record["guardRefs"]
  return {
    object: capabilityObjectName(kind, index),
    kind: typeof kind === "string" ? kind : `#${index}`,
    pack: typeof pack === "string" ? pack : "",
    ...(isNonBlankString(refusalCode) ? { refusalCode } : {}),
    ...(Array.isArray(guardRefs) ? { guardRefs: guardRefs as readonly unknown[] } : {}),
  }
}

/**
 * A guard chain's canonical form — `phase:name` pairs joined in DECLARED
 * order. Order is part of the contract ("in bundle order"), so two chains with
 * the same guards in different order are genuinely different declarations.
 */
function chainSignature(guardRefs: readonly unknown[]): string {
  return guardRefs
    .map((ref) => {
      if (typeof ref !== "object" || ref === null) return String(ref)
      const pair = ref as Record<string, unknown>
      return `${String(pair["phase"])}:${String(pair["name"])}`
    })
    .join(", ")
}

function chainCouplingDiagnostics(v: CapabilityView): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const hasChain = v.guardRefs !== undefined && v.guardRefs.length > 0
  const hasFloor = v.refusalCode !== undefined

  if (hasChain && !hasFloor) {
    out.push({
      pass: PASS,
      rule: "missing-refusal-terminal",
      severity: "error",
      object: v.object,
      field: "refusalCode",
      message:
        `declares a ${v.guardRefs?.length ?? 0}-guard chain but no refusal floor. ` +
        "Every path through the chain that reaches no EXECUTE / CONFIRM / ESCALATE / " +
        "DEFER falls through to the Pack's default REFUSE — the terminal is reachable " +
        "and the capability names no basis code for it.",
    })
  }

  if (hasFloor && !hasChain) {
    out.push({
      pass: PASS,
      rule: "refusal-terminal-without-chain",
      severity: "error",
      object: v.object,
      field: "guardRefs",
      message:
        `declares the refusal floor "${v.refusalCode ?? ""}" but an empty (or absent) ` +
        "guard chain. With no guards, no EXECUTE / CONFIRM / ESCALATE / DEFER is " +
        "reachable and REFUSE is the capability's only terminal — that is a dead " +
        "capability, not a conservative one.",
    })
  }

  return out
}

function phaseDiagnostics(v: CapabilityView): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  const refs = v.guardRefs ?? []
  refs.forEach((ref, i) => {
    if (typeof ref !== "object" || ref === null) return
    const phase = (ref as Record<string, unknown>)["phase"]
    if (phase !== "taint") return
    out.push({
      pass: PASS,
      rule: "unreachable-guard-phase",
      severity: "error",
      object: v.object,
      field: `guardRefs[${i}].phase`,
      message:
        'phase "taint" names a terminal source that cannot exist: a Pack\'s taint slot ' +
        "is a single TaintPolicy value, not a Guard[] array, so there is no guard to " +
        `reference by name. Declare one of ${GUARD_REF_PHASES.join(" | ")}.`,
      reference: "taint",
    })
  })
  return out
}

/** Group capabilities by owning pack, preserving declaration order. */
function byPack(views: readonly CapabilityView[]): ReadonlyMap<string, CapabilityView[]> {
  const groups = new Map<string, CapabilityView[]>()
  for (const v of views) {
    if (v.pack === "") continue // a broken `pack` slot — other passes own it
    groups.set(v.pack, [...(groups.get(v.pack) ?? []), v])
  }
  return groups
}

/** Render `value -> kinds` groups deterministically for a divergence message. */
function describeGroups(groups: ReadonlyMap<string, readonly string[]>): string {
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([value, kinds]) => `"${value}" (${[...kinds].sort().join(", ")})`)
    .join("; ")
}

function packDivergenceDiagnostics(
  views: readonly CapabilityView[],
): CatalogDiagnostic[] {
  const out: CatalogDiagnostic[] = []
  for (const [pack, members] of byPack(views)) {
    const floors = new Map<string, string[]>()
    const chains = new Map<string, string[]>()
    for (const m of members) {
      if (m.refusalCode !== undefined) {
        floors.set(m.refusalCode, [...(floors.get(m.refusalCode) ?? []), m.kind])
      }
      if (m.guardRefs !== undefined && m.guardRefs.length > 0) {
        const signature = chainSignature(m.guardRefs)
        chains.set(signature, [...(chains.get(signature) ?? []), m.kind])
      }
    }
    if (floors.size > 1) {
      out.push({
        pass: PASS,
        rule: "divergent-pack-refusal-terminal",
        severity: "error",
        object: packObjectName(pack),
        field: "refusalCode",
        message:
          `capabilities of this Pack declare ${floors.size} different refusal floors: ` +
          `${describeGroups(floors)}. A Pack has exactly one PolicyBundle.default basis ` +
          "code, so at most one of these can be right — the others mis-declare where " +
          "their capability's fall-through REFUSE lands.",
      })
    }
    if (chains.size > 1) {
      out.push({
        pass: PASS,
        rule: "divergent-pack-guard-chain",
        severity: "error",
        object: packObjectName(pack),
        field: "guardRefs",
        message:
          `capabilities of this Pack declare ${chains.size} different guard chains: ` +
          `${describeGroups(chains)}. types.ts fixes the chain as the owning Pack's FULL ` +
          "stateGuards/authGuards/business list in bundle order — pack-wide by " +
          "construction, never a per-kind subset — so a divergent chain describes a set " +
          "of reachable terminals the kernel will not produce.",
      })
    }
  }
  return out
}

/**
 * Run the terminal-coverage pass.
 *
 * `checked` counts terminal DECLARATIONS examined: each capability's refusal
 * floor and guard chain (one unit each, present or not), plus every guard ref
 * phase, plus one unit per Pack whose coverage was compared.
 */
export function runTerminalCoveragePass(
  definitions: readonly CapabilityDefinition[],
): CatalogPassResult {
  const views = definitions.map(view)
  const diagnostics: CatalogDiagnostic[] = []
  let checked = 0
  for (const v of views) {
    checked += 2 + (v.guardRefs?.length ?? 0)
    diagnostics.push(...chainCouplingDiagnostics(v))
    diagnostics.push(...phaseDiagnostics(v))
  }
  checked += byPack(views).size
  diagnostics.push(...packDivergenceDiagnostics(views))
  return { pass: PASS, checked, diagnostics }
}
