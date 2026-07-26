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
  RenderCarriersForTurn,
} from "@claustrum/core";
import type { EvidenceLedger } from "@adjudicate/core";
import type { DisambiguationCandidate } from "./classify-only-reads.js";
import { assertClaimDefinitionRegistryValid } from "./claim-definition-registry.js";
import { claimsRenderDriftProblems } from "./claims-render-drift.js";
import {
  createIbatexasClaimsRenderer,
  createIbatexasClaimsRenderPrecedence,
} from "./claims-renderer-adapter.js";
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
import {
  createIbatexasInvestigator,
  type TurnReadGatherer,
} from "./ibatexas-investigator.js";
import type { ClaimPlaneScope } from "./claim-registry.js";
import type { Template } from "./slot-grammar.js";
import {
  localDateParts,
  resolveQueriedScheduleDate,
} from "./schedule-date-resolver.js";
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
/**
 * BKL-152-edge (ibatexas rider / @claustrum/core 0.8.0 `renderCarriersForTurn`
 * carrier seam) — thread the RESOLVED queried schedule date so the required-claim
 * decomposer's STORE_OPEN_NOW suppression is EXACT on `weekday == today` (see
 * `required-claim-decomposer.ts` `DateAnchorSignal`). `resolvedQueryDate` is
 * PRESENT ⟺ the request resolves to a CONFIRMED NON-TODAY day; a today/unresolvable
 * anchor OMITS it, and the decomposer — told the seam is ACTIVE via
 * `createIbatexasClaimsRenderer({ renderCarriersActive: true })` — reads
 * absent-under-active as "today → KEEP STORE_OPEN_NOW". Clock-pure boundary: THIS
 * callback owns the clock (`new Date()`) and the tz (`RESTAURANT_TIMEZONE`);
 * @claustrum/core threads the result verbatim (no clock/RNG/IO crosses the seam).
 *
 * `disambiguationCandidates` (BKL-170/BKL-189) IS sourced here — via the per-turn
 * stash: the classify-only ambiguous branch cannot reach this ledger+text callback
 * directly (its owned-set data lives in the claim-planner stage), so
 * `buildClaimsSeams` keys a WeakMap by the turn's `EvidenceLedger` — the ONE
 * object identity `handleTurn` passes to BOTH the claim planner (`propose` input)
 * and this callback. The planner adapter writes ≥2 labeled candidates on the
 * ambiguous-CLARIFY branch; this callback reads them. WeakMap semantics make the
 * carrier request-scoped by construction: distinct turns hold distinct ledger
 * instances (no cross-turn contamination) and entries are collected with the
 * ledger (no teardown hook needed, no leak). No stash → the field is OMITTED —
 * byte-identical to the pre-BKL-189 carrier (#332 pins hold).
 */
export function createIbatexasRenderCarriersForTurn(
  readDisambiguationCandidates?: (
    ledger: EvidenceLedger,
  ) => readonly DisambiguationCandidate[] | undefined,
): RenderCarriersForTurn {
  return ({ ledger, requestText }) => {
    const tz = process.env.RESTAURANT_TIMEZONE ?? "America/Sao_Paulo";
    const now = new Date();
    const resolved = resolveQueriedScheduleDate(requestText, tz, now);
    const dateCarrier =
      resolved === null || resolved.isoDate === localDateParts(tz, now).isoDate
        ? {}
        : { resolvedQueryDate: resolved.isoDate };
    const candidates = readDisambiguationCandidates?.(ledger);
    const candidateCarrier =
      candidates !== undefined && candidates.length > 0
        ? { disambiguationCandidates: candidates }
        : {};
    return { ...dateCarrier, ...candidateCarrier };
  };
}

export type ClaimsSeams = Pick<
  ConductorOptions,
  | "investigator"
  | "claimPlanner"
  | "claimsKernel"
  | "claimsKernelDepsForTurn"
  | "claimsRenderer"
  | "claimsRenderPrecedence"
  | "activeResourcesForTurn"
  | "renderCarriersForTurn"
>;

/**
 * LE2-012 — the PLANE-SCOPED extension of the claims seams: everything a SECOND
 * plane (ops) must swap in so its own claim TYPES are readable, proposable and
 * renderable, WITHOUT any of them reaching the customer plane. One optional
 * field on {@link BuildClaimsSeamsDeps} rather than four, so the LE2-011 skeleton
 * gains exactly one extension point.
 *
 * Absent (customer / WhatsApp / managed-agent) ⟹ every seam is built exactly as
 * before — byte-identical.
 */
export interface ClaimsPlaneExtension {
  /**
   * The plane's claim-type scope (enum + per-type schema). It is BOTH the
   * `propose_claim` enum the plane's planner advertises AND the vocabulary the
   * plane's render-drift gate quantifies over. The plane composition must pass the
   * SAME scope to `createIbatexasPlanner({ claimScope })`.
   */
  readonly claimScope: ClaimPlaneScope;
  /** The plane's validated render templates (customer ∪ plane). */
  readonly templates: Readonly<Record<string, Template>>;
  /** The plane's per-turn read gatherer (customer reads ∪ the plane's own). */
  readonly gatherReads: TurnReadGatherer;
  /**
   * Does the §O#15 gate's CUSTOMER-SCOPED companion set apply on this plane? See
   * `IbatexasClaimsRendererOptions.customerScopedCompanionsApply`. Omitted ⟹ yes.
   */
  readonly customerScopedCompanionsApply?: boolean;
  /**
   * The plane's FAIL-CLOSED inv.18 registry assertion — the plane-scoped twin of
   * `assertClaimDefinitionRegistryValid`. Runs BEFORE any seam is constructed, so
   * an unaligned plane row (a template slot with no §5-gated projection, a
   * `falsifierComplete` type with no falsifiers, a dangling template) refuses to
   * boot the plane's claims pipeline rather than serving it. Omitted ⟹ not run.
   */
  readonly assertRegistryValid?: () => void;
}

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
   * Sink for the UNCONDITIONAL boot marker stating the claims-pipeline state
   * (BKL-108). Before this, an ENABLED pipeline was LOG-SILENT at boot unless a
   * kernel was below floor — during the 2026-07-04 flip incident nothing in the
   * boot log said whether the RUNNING process actually carried the flag, and a
   * stale-env respawn passed for an enabled one. Emitted exactly once per call,
   * for BOTH states (ENABLED and disabled). Inject it ONLY from the boot-time
   * composition root — the per-trigger factory (`buildClaimsSeamsForPlanner`)
   * must omit it, or the boot-class marker would repeat on every trigger.
   * Optional + best-effort like `warn`; omitting it changes nothing else.
   */
  readonly info?: (message: string) => void;
  /**
   * Resolve the linked kernel versions (testing seam). Defaults to the
   * best-effort runtime resolver; tests inject a fixed map.
   */
  readonly resolveKernelVersions?: () => ResolvedKernelVersions;
  /**
   * BKL-209 — best-effort SAFETY sink invoked when a turn resolves to a medical-
   * emergency ESCALATE (the deterministic distress net + ESCALATE terminal), so
   * the emergency reaches staff. Threaded into the render adapter; the boot root
   * wires it to publish `support.handoff_requested`. Fire-and-forget + MUST NOT
   * throw (the adapter also guards it). Omitted (the per-trigger factory / tests)
   * → no staff surface, render byte-identical.
   */
  readonly onSafetyEmergency?: (ctx: { readonly turnId?: string }) => void;
  /**
   * LE2-012 — the PLANE-SCOPED extension (see {@link ClaimsPlaneExtension}).
   * Absent ⟹ the customer plane, byte-identical to the pre-LE2-012 seams.
   */
  readonly plane?: ClaimsPlaneExtension;
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
  const enabled = claimsPipelineEnabled(deps.env);
  // BKL-108 — unconditional boot marker, BOTH states. An ENABLED pipeline used
  // to be log-silent unless a kernel was below floor, so a stale-env respawn
  // (flag true on disk, absent in the process) was indistinguishable from an
  // enabled boot. One line, always, so `process env vs .env` disputes are
  // settled by the boot log itself.
  deps.info?.(
    enabled
      ? `[claims-pipeline] ENABLED (${CLAIMS_PIPELINE_ENABLED_ENV}=true) — INVESTIGATE / CLAIMS-VALIDATE / render-from-claims seams active`
      : `[claims-pipeline] disabled (${CLAIMS_PIPELINE_ENABLED_ENV} unset/false) — prose-only composition, no claims seams`,
  );
  if (!enabled) {
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
  // LE2-012 — the PLANE's own fail-closed inv.18 assertion, run with the SAME
  // refuse-to-boot discipline immediately after the customer one (a plane registry
  // is a registry: an unaligned ops row must not serve either). Absent on the
  // customer plane ⟹ no-op.
  deps.plane?.assertRegistryValid?.();
  // FE-3.3 (FE-T16) — the customer-plane advertised-⊆-renderable BOOT gate,
  // mirroring the ops plane's `opsPlaneDriftProblems` (ops-conductor.ts): every
  // PROPOSABLE customer claim type (CLAIM_REGISTRY) not in the deliberate
  // exception list must have a validated render template (slot-grammar.ts
  // VALIDATED_TEMPLATES), else a validated read of that type could only ever
  // dead-end in the honest-abstain UNKNOWN with no path to render the fact it
  // proved. Promotes the pre-existing unit-test-only subset pin
  // (proposable-renderable-drift.test.ts, BKL-112) into a REAL fail-closed boot
  // guard, so a FUTURE proposable type shipped without a template fails boot,
  // not merely CI.
  const claimsRenderDrift = claimsRenderDriftProblems();
  if (claimsRenderDrift.length > 0) {
    throw new Error(
      "[claims-pipeline] customer-plane render drift check failed (FE-3.3 / BKL-112):\n  " +
        claimsRenderDrift.join("\n  "),
    );
  }
  // LE2-012 — the SAME advertised-⊆-renderable gate, run over THIS PLANE's scope
  // (its enum + its templates). Because a plane scope is a SUPERSET of the customer
  // one, this single call also re-proves the customer half; the deliberate
  // exception list (`KNOWN_CUSTOMER_UNRENDERABLE_TYPES`) is shared, so an ops type
  // shipped without a template fails BOOT exactly like a customer one would.
  if (deps.plane !== undefined) {
    const planeDrift = claimsRenderDriftProblems({
      proposable: deps.plane.claimScope.types,
      renderable: new Set(Object.keys(deps.plane.templates)),
    });
    if (planeDrift.length > 0) {
      throw new Error(
        "[claims-pipeline] plane-scoped render drift check failed (LE2-012):\n  " +
          planeDrift.join("\n  "),
      );
    }
  }
  // F2 observability (RCA 2026-06-29): the pipeline is ENABLED — surface a loud
  // warning if the LINKED kernels are below the egress-brand floor, so the
  // kernel-version drop point (silent store-open → UNKNOWN) is visible at boot.
  warnOnBelowFloorKernel(deps);
  // BKL-189 — the per-turn disambiguation-candidate carrier: keyed by the turn's
  // EvidenceLedger (the object identity shared by the claim-planner input and the
  // renderCarriersForTurn callback), written by the planner adapter's ambiguous
  // branch, read by the carriers callback below. One WeakMap per seam set (the
  // managed-agent plane builds its own seams → its own stash); entries die with
  // the ledger (request-scoped, concurrency-safe, leak-free by construction).
  const disambiguationStash = new WeakMap<
    EvidenceLedger,
    readonly DisambiguationCandidate[]
  >();
  return {
    // LE2-012 — the PLANE's read gatherer, when it supplies one. The ops plane's
    // gatherer is `customer reads ∪ ops reads` (its ops half resolves THROUGH the
    // existing ops read roster), so the store-open-now chain LE2-011 proved on this
    // plane is untouched. Absent ⟹ the default first-party gatherer, byte-identical.
    investigator: createIbatexasInvestigator(
      deps.plane === undefined ? {} : { gatherReads: deps.plane.gatherReads },
    ),
    claimPlanner: createIbatexasClaimPlanner(deps.planner, {
      stashDisambiguationCandidates: (ledger, candidates) => {
        disambiguationStash.set(ledger, candidates);
      },
    }),
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
    // BKL-152-edge (@claustrum/core 0.8.0 carrier seam) — thread the resolved
    // queried schedule date into `ClaimsRenderContext.resolvedQueryDate` so the
    // decomposer's STORE_OPEN_NOW suppression is EXACT on weekday==today. Pure
    // passthrough on claustrum's side; the clock lives in this callback. Absent
    // (unwired) → the decomposer keeps its pure #301 rule (byte-identical).
    renderCarriersForTurn: createIbatexasRenderCarriersForTurn((ledger) =>
      disambiguationStash.get(ledger),
    ),
    // E-2 render-from-claims (SDD §B / §Q.7) — the loop-level closure of the
    // "claims-not-prose" thesis. When ON, `handleTurn` stage 6a renders the reply
    // TEXT from the VALIDATED claim set via the pure `renderer-from-claims`
    // (C6 value-from-ledger; Inv 6 1:1; proposition-free safe terminals),
    // superseding the model draft. On no-renderable-claim the claustrum loop
    // falls back to the operational responder draft (never raw model prose as a
    // confident fact; never silence). Inert while the flag is COMMITTED OFF.
    claimsRenderer: createIbatexasClaimsRenderer({
      renderCarriersActive: true,
      // BKL-209 — the emergency staff-surface sink (support.handoff_requested),
      // wired by the boot root; unset on the per-trigger factory → no surface.
      ...(deps.onSafetyEmergency === undefined
        ? {}
        : { onSafetyEmergency: deps.onSafetyEmergency }),
      // LE2-012 — the PLANE's template table + §O#15 companion scoping. Absent ⟹
      // the customer grammar and the full customer companion set (byte-identical).
      ...(deps.plane === undefined
        ? {}
        : {
            templates: deps.plane.templates,
            ...(deps.plane.customerScopedCompanionsApply === undefined
              ? {}
              : {
                  customerScopedCompanionsApply:
                    deps.plane.customerScopedCompanionsApply,
                }),
          }),
    }),
    // BKL-155/153 (@claustrum/core 0.7.0) — the RENDER-vs-DRAFT precedence seam,
    // PAIRED with `claimsRenderer` above so it is only consulted on a claims-ON
    // plane where the render also runs. LE2 decision 6: the OPS conductor now takes
    // this whole seam set too, and REPLACES this entry with the same factory carrying
    // its per-turn deterministic-read signal (lattice rule 3c), so its BKL-100 /
    // BKL-149 deterministic renders survive convergence. When
    // wired, handleTurn 6a asks the pure ibatexas lattice whether the claims render
    // supersedes the responder draft this turn (a spurious safe-degrade must not
    // hide a kernel REQUEST_CONFIRMATION prompt, nor a friendly statement reply).
    // Absent (flag OFF) → core defaults to "render" → byte-identical to 0.6.0.
    claimsRenderPrecedence: createIbatexasClaimsRenderPrecedence(),
  };
}
