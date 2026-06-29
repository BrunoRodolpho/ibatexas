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

import type { ConductorOptions } from "@claustrum/core";
import { createIbatexasClaimPlanner } from "./ibatexas-claim-planner.js";
import { createPerTurnClaimsKernelDeps } from "./ibatexas-claims-kernel-deps.js";
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
 * The three OPTIONAL claims seams of `ConductorOptions`. Spread into
 * `createConductor`; `{}` when the flag is OFF (a no-op spread → byte-identical
 * Conductor composition).
 */
export type ClaimsSeams = Pick<
  ConductorOptions,
  "investigator" | "claimPlanner" | "claimsKernel"
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
  return {
    investigator: createIbatexasInvestigator(),
    claimPlanner: createIbatexasClaimPlanner(deps.planner),
    // W5a F2 — build the kernel deps via the REAL per-turn builder
    // (createPerTurnClaimsKernelDeps), not the process-wide fail-closed stub. The
    // R2a per-turn `now` is supplied PER TURN by the Conductor's `clock()` seam
    // (conductor.ts rebuilds `claimsKernel.soundness.now` on every openCapsule),
    // so the boot value here is immediately superseded.
    //
    // FAIL-CLOSED BOOT FACTS (intentional): `ownership.ownedResources` is EMPTY
    // and `outcomes` is empty at boot, so `owns → false` / `outcomeConfirmed →
    // false` until the per-turn facts are threaded. The genuine per-turn ownership
    // facts (the resolveAndAssemble owned set) become available only AFTER the
    // resolve stage inside `handleTurn`; threading them onto the kernel deps
    // requires the Conductor per-turn claims-deps seam (the W5b conductor seam,
    // which today rebuilds ONLY `now`). Until that seam lands, the OWNER-SCOPED
    // Triad members (ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS) DEGRADE TO UNKNOWN
    // (honest ignorance — never a false render); STORE_OPEN_NOW (public, no owner)
    // is unaffected. The flag stays COMMITTED OFF, so this is inert in production.
    claimsKernel: createPerTurnClaimsKernelDeps({
      now: Date.now(),
      ownership: { principal: "", ownedResources: new Set<string>() },
      outcomes: [],
    }),
  };
}
