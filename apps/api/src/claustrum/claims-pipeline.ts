// claims-pipeline.ts — the B-PR1 composition-root injection point for the
// claims-runtime seams (SDD §M / §Q.6). Assembles the three OPTIONAL Conductor
// seams (`investigator`, `claimPlanner`, `claimsKernel`) behind an env flag,
// DEFAULT-OFF, so a normal boot is BYTE-IDENTICAL to today.
//
// Flag style mirrors the existing `IBX_AGENTS_ENABLED` / `agentsEnabled()` plane
// flag (managed-agent-plane.ts): a named env constant + a boolean reader.
//
// When OFF (default): `buildClaimsSeams` returns `{}` and constructs NOTHING — the
// spread into `createConductor({ ... })` adds no keys, so `handleTurn` runs NO
// INVESTIGATE / CLAIMS-VALIDATE stage (the legacy 7-stage loop is unchanged).
// When ON: the three seams are injected and the SHADOW claims path runs (the
// claim-aware planner's typed candidates are validated by the published Claims
// kernel against the per-turn Evidence Ledger). Activating/consuming that path is
// a later PR — this PR only WIRES the seams.
//
// No `clock` is wired (the published `ConductorOptions` has no `clock` field; the
// per-turn clock is PENDING R2a — see ibatexas-claims-kernel-deps.ts).

import type {
  ClaimsKernelDepsForTurn,
  ConductorOptions,
} from "@claustrum/core";
import { assertClaimDefinitionRegistryValid } from "./claim-definition-registry.js";
import { createIbatexasClaimsRenderer } from "./claims-renderer-adapter.js";
import {
  claimsKernelFloorWarnings,
  resolveKernelVersions,
  type ResolvedKernelVersions,
} from "./claims-kernel-floor.js";
import { createIbatexasClaimPlanner } from "./ibatexas-claim-planner.js";
import {
  activeResourcesFromLedger,
  buildPerTurnOwnsFromLedger,
  createPerTurnClaimsKernelDeps,
} from "./ibatexas-claims-kernel-deps.js";
import { createIbatexasInvestigator } from "./ibatexas-investigator.js";
import type { ClaimAwarePlannerPort } from "./ibatexas-planner.js";

/** Env flag that opts a boot into the claims pipeline (default off). */
export const CLAIMS_PIPELINE_ENABLED_ENV = "ENABLE_CLAIMS_PIPELINE";

/** Is the claims pipeline enabled for this boot? Default false (OFF). */
export function claimsPipelineEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CLAIMS_PIPELINE_ENABLED_ENV] === "true";
}

/**
 * The OPTIONAL claims seams of `ConductorOptions`. Spread into `createConductor`;
 * `{}` when the flag is OFF (a no-op spread → byte-identical Conductor
 * composition). The render-from-claims seam (`claimsRenderer`, Plan 1 Phase 3 /
 * E-2) is bundled here so it activates ATOMICALLY with the rest of the pipeline:
 * the renderer only ever supersedes the model draft when the INVESTIGATE +
 * CLAIMS-VALIDATE stages also ran (handleTurn 6a guards on a `claims` result),
 * so a partial wiring can never render from an absent claim set.
 */
export type ClaimsSeams = Pick<
  ConductorOptions,
  | "investigator"
  | "claimPlanner"
  | "claimsKernel"
  | "claimsKernelDepsForTurn"
  | "claimsRenderer"
  | "activeResourcesForTurn"
>;

export interface BuildClaimsSeamsDeps {
  /**
   * The SAME claim-aware planner instance wired as the Conductor's `planner`.
   * The claim-planner adapter reuses its `proposeClaims` (Q6b) — one planner,
   * two surfaces (the intent path + the candidate-claim path).
   */
  readonly planner: ClaimAwarePlannerPort;
  /** Env override (testing). Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Sink for the boot-time kernel-floor warning (F2 observability — RCA
   * 2026-06-29). Called ONCE per below-floor kernel when the pipeline is ENABLED,
   * so a kernel-version mismatch (the silent store-open → UNKNOWN drop point) is
   * operator-VISIBLE at boot instead of mysterious. Defaults to `console.warn`;
   * the composition root injects the structured logger. Best-effort — a throwing
   * sink would surface at boot, so keep it non-throwing.
   */
  readonly warn?: (message: string) => void;
  /**
   * Resolve the linked kernel versions (testing seam). Defaults to the
   * best-effort runtime resolver; tests inject a fixed map.
   */
  readonly resolveKernelVersions?: () => ResolvedKernelVersions;
}

/**
 * Emit the kernel-floor warnings for an ENABLED pipeline. PURE wrt the seam
 * build (telemetry side-channel) — extracted so it is unit-testable and so a
 * resolution failure never blocks seam assembly. Exported for the boot path +
 * tests.
 */
export function warnOnBelowFloorKernel(deps: BuildClaimsSeamsDeps): void {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const resolved = (deps.resolveKernelVersions ?? resolveKernelVersions)();
    for (const message of claimsKernelFloorWarnings(resolved)) warn(message);
  } catch {
    // Observability must never break boot.
  }
}

/**
 * Wrap a `warn` sink so each DISTINCT message is emitted AT MOST ONCE per
 * process. The managed-agent plane rebuilds the claims seams PER TRIGGER
 * (`buildClaimsSeamsForPlanner`), so `warnOnBelowFloorKernel` would otherwise
 * re-emit the SAME boot-class floor warning on every trigger — the linked kernel
 * versions do not change between triggers, so those repeats are pure log noise
 * (this repo ran a whole logging signal-quality program). De-duping BY MESSAGE
 * keeps every distinct warning (there is one per below-floor kernel package)
 * while collapsing the per-trigger repeats to a single line — a blunt
 * suppress-after-first-call boolean would instead drop the second package's
 * warning on the first trigger. Non-throwing, to preserve
 * {@link warnOnBelowFloorKernel}'s best-effort contract. Construct it ONCE and
 * reuse across trigger invocations (the dedup set lives in the closure).
 */
export function warnOncePerMessage(
  warn: (message: string) => void,
): (message: string) => void {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    warn(message);
  };
}

/**
 * Assemble the claims seams for the composition root. Returns `{}` (constructing
 * nothing) when the flag is OFF; otherwise the three injected seams. The Claims
 * kernel deps use the fail-closed process-wide defaults (PENDING the per-turn
 * deps seam — see ibatexas-claims-kernel-deps.ts).
 */
export function buildClaimsSeams(deps: BuildClaimsSeamsDeps): ClaimsSeams {
  if (!claimsPipelineEnabled(deps.env)) {
    // OFF (default): no seams — byte-identical to today.
    return {};
  }
  // inv.18 v1 FAIL-CLOSED registry load (FIRST — fail-closed before anything else):
  // before constructing any claims seam, assert the assembled ClaimDefinition
  // registry is complete + consistent (every render-template slot backed by a
  // §5-gated projection; every falsifierComplete type enumerates falsifiers; every
  // VALIDATED_TEMPLATES entry has a registered definition; Triad-closure membership;
  // provenance default-deny). An incomplete/inconsistent definition THROWS here —
  // the claims pipeline refuses to boot rather than serving an unaligned registry.
  // This is what makes a dangling template (a template with no backing
  // ClaimDefinition) mechanically impossible at load.
  assertClaimDefinitionRegistryValid();
  // F2 observability (RCA 2026-06-29): the pipeline is ENABLED — surface a loud
  // warning if the LINKED kernels are below the egress-brand floor, so the
  // kernel-version drop point (silent store-open → UNKNOWN) is visible at boot.
  warnOnBelowFloorKernel(deps);
  return {
    investigator: createIbatexasInvestigator(),
    claimPlanner: createIbatexasClaimPlanner(deps.planner),
    // W5a F2 — build the kernel deps via the REAL per-turn builder
    // (createPerTurnClaimsKernelDeps), not the process-wide fail-closed stub. The
    // R2a per-turn `now` is supplied PER TURN by the Conductor's `clock()` seam
    // (conductor.ts rebuilds `claimsKernel.soundness.now` on every openCapsule),
    // so the boot value here is immediately superseded.
    //
    // PROCESS-WIDE BASE (fail-closed): `ownership.ownedResources` is EMPTY and
    // `outcomes` is empty at boot, so the base `owns → false` / `outcomeConfirmed
    // → false`. The genuine per-turn owner attribution is now threaded by the W5b
    // Conductor seam below (`claimsKernelDepsForTurn`) — the conductor previously
    // rebuilt ONLY `now`, leaving the boot-empty owner set, which REFUSED every
    // owner-scoped claim even for its legit owner. `now` is still superseded
    // per-turn by the conductor `clock()` seam + the CLAIMS-VALIDATE freshness
    // floor. The flag stays COMMITTED OFF, so all of this is inert in production.
    claimsKernel: createPerTurnClaimsKernelDeps({
      now: Date.now(),
      ownership: { principal: "", ownedResources: new Set<string>() },
      outcomes: [],
    }),
    // W5b PER-TURN OWNS (fix 2): rebuild `owns` for THIS turn from the OWNER-SCOPED
    // reads that returned PRESENT in the threaded ledger + the AUTHENTICATED
    // `customerId` (the conductor identity). `buildPerTurnOwnsFromLedger` derives
    // the owned-resource set ONLY from present owner-scoped ledger entries (a
    // forged/cross-owner read throws → recordError → absent → never owned), so the
    // owner-scoped Triad members (ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS) VALIDATE
    // for the legit owner while IDOR stays closed ("no owner" ≠ "any owner",
    // Inv 2). `outcomeConfirmed` stays the fail-closed base (read_claims do not
    // trigger C4). NO session/model id ever feeds the owned set.
    claimsKernelDepsForTurn: buildPerTurnOwnsFromLedger satisfies ClaimsKernelDepsForTurn,
    // BKL-004 (#8 decomposer ownership signal) — @claustrum/core 0.5.0
    // `activeResourcesForTurn` seam. handleTurn threads the owner-scoped active
    // resource set (present order/payment/reservation refs) into
    // `ClaimsRenderContext.activeResources` at RENDER-FROM-CLAIMS. Same
    // present-only IDOR filter as `buildPerTurnOwnsFromLedger`. Inert while the
    // flag is OFF (this whole seam set is only wired when ENABLE_CLAIMS_PIPELINE).
    activeResourcesForTurn: activeResourcesFromLedger,
    // E-2 render-from-claims (SDD §B / §Q.7) — the loop-level closure of the
    // "claims-not-prose" thesis. When ON, `handleTurn` stage 6a renders the reply
    // TEXT from the VALIDATED claim set via the pure `renderer-from-claims`
    // (C6 value-from-ledger; Inv 6 1:1; proposition-free safe terminals),
    // superseding the model draft. On no-renderable-claim the claustrum loop
    // falls back to the operational responder draft (never raw model prose as a
    // confident fact; never silence). Inert while the flag is COMMITTED OFF.
    claimsRenderer: createIbatexasClaimsRenderer(),
  };
}
