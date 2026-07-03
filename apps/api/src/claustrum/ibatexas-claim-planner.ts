// ibatexas-claim-planner.ts — the candidate-claim source host (SDD §M / §Q.6;
// v1.1 §8). Implements the published @claustrum/core `ClaimPlannerPort` as a THIN
// HOST ADAPTER over the EXISTING Q6b claim-aware planner (`proposeClaims` on
// `ClaimAwarePlannerPort`, ibatexas-planner.ts) and the `claim-registry.ts`
// deterministic walls it already orchestrates:
//
//   - constrained generation over the registry enum (SDD §H/§P3) —
//     `constrainClaimGeneration` (only an in-enum claim TYPE becomes a typed
//     `CandidateClaim`; a hallucinated type is dropped, never free-generated);
//   - P4 completeness (SDD §C P4 / §J.8) — `checkCompleteness`;
//   - §O#9 closed-taxonomy safety routing — `routeSafety`.
//
// This adapter REUSES that planner — it does NOT reimplement the walls. It only
// adapts the published seam's `{ cognition, plan }` input to `proposeClaims`'s
// `CognitiveState` and surfaces the registry-constrained `candidates`. NO
// validation happens here: the candidates are the (bounded) planner's framing;
// the deterministic P1 soundness ∘ P2 consistency gates run downstream in the
// Conductor's CLAIMS-VALIDATE stage (`runClaimsKernel`, Q5).
//
// F1 SAFE TERMINAL (BKL-005): the adapter ALSO closes the FLAKE fail-open. When
// `proposeClaims` THROWS (the ~1/3-turn local-4B tool-call XML parse flake) it
// produced no signal at all, so on a turn that HAD a claim to make (the §O#15
// required set is non-empty) it SYNTHESIZES a proposition-free UNKNOWN candidate
// (`synthesizeSafeTerminalCandidates`) for every required type — the candidate set
// is then non-empty, CLAIMS-VALIDATE always produces a result, and the turn
// degrades to the renderer's safe terminal instead of falling through to the
// lie-capable prose responder. This is still FRAMING (the kernel disposes each
// synthetic to UNKNOWN — or a ledger-backed STORE_OPEN_NOW to VALIDATED); no
// validation is short-circuited here.
//
// NARROW BY DESIGN — synthesis fires ONLY on the throw path. A SUCCESSFUL
// `proposeClaims` (empty or not) is the planner's HONEST signal and is surfaced
// UNCHANGED: the §O#15 decomposer is a DEMOTE-ONLY completeness net whose keyword
// markers also match STATEMENTS ("pagode", "meu pedido chegou, obrigado!", "vou
// pagar com pix" mid-checkout), so promoting a successful-empty proposal into the
// claims path would override the prose draft with a non-sequitur "não localizei…".
// KNOWN GAP (BKL-078): a successful-but-empty proposal on a genuinely
// claim-requiring question therefore still falls through to prose (pre-existing
// behavior); closing it needs an interrogative/imperative span signal the keyword
// decomposer does not provide.

import type { CandidateClaim, EvidenceLedger } from "@adjudicate/core";
import type { ClaimPlannerInput, ClaimPlannerPort } from "@claustrum/core";
import { logger } from "../lib/logger.js";
import { selectCandidateClaim, type RegistryClaimType } from "./claim-registry.js";
import type { ClaimAuthContext, ClaimAwarePlannerPort } from "./ibatexas-planner.js";
import { ownedResourceIdsByBaseKey } from "./ibatexas-claims-kernel-deps.js";
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
} from "./required-claim-decomposer.js";

/**
 * tag-then-derive STEP 2 for an OWNER-SCOPED, per-resource candidate (the
 * owner-positive close). `proposeClaims` deliberately leaves an owner-scoped
 * candidate's `value` undefined — the 4B authors none (tag protocol), and the
 * planner does NOT re-read an owner-scoped resource to derive it (that would
 * re-open the IDOR the per-turn owns predicate closes). Bind the value HERE, from
 * the SAME AUTHENTICATED owner-scoped read already PRESENT in this turn's ledger
 * (the entry at the parameterized `valueBinding.key`, e.g.
 * `order_fulfillment_stage:order-A`), so the kernel's C6 compares a FIRST-PARTY
 * value against itself (PASS) and the legit owner VALIDATEs — while the model is
 * still never a value author.
 *
 * IDOR-safe + sound by construction:
 *   - Only binds when `value` is undefined → a (defensive) model-authored value is
 *     left intact so C6 still REFUSES a mismatch (the over-claim guard is unweakened).
 *   - Only reads a PRESENT entry → a forged / cross-owner owner-scoped read errored
 *     in INVESTIGATE → absent → no value bound → C6 ABSTAINs → honest UNKNOWN.
 *   - Never sets `validated`, never skips a conjunct: ownership (`owns`), freshness,
 *     provenance and the falsifier arm all still run in `runClaimsKernel`. A bound
 *     value for a resource the actor does not own is still REFUSED by the ∀-evidence
 *     ownership conjunct ("no owner" ≠ "any owner", Inv 2).
 * Pure.
 */
function bindValueFromLedger(
  candidate: CandidateClaim,
  ledger: EvidenceLedger,
): CandidateClaim {
  const binding = candidate.soundness.valueBinding;
  // No binding, or the value is already set (model-authored / publish-free-derived
  // upstream) → leave untouched: C6 then guards it (PASS/REFUSED), never silently
  // overwritten from the ledger.
  if (binding === undefined || candidate.value !== undefined) return candidate;
  const resolution = ledger.resolve(binding.key);
  if (resolution.state !== "present" || resolution.entry === undefined) {
    return candidate;
  }
  return { ...candidate, value: resolution.entry.value };
}

/**
 * F1 SAFE TERMINAL (BKL-005) — synthesize a proposition-free UNKNOWN candidate for
 * every decomposer-REQUIRED claim type the planner did NOT cover this turn. The
 * CALLER gates this to the FLAKE (throw) path only — see the `propose` body and the
 * module header for why a successful-empty proposal must NOT be synthesized over.
 *
 * The fail-open this closes: when `proposeClaims` THROWS on a claim-requiring
 * question (the ~1/3 local-4B tool-call XML parse flake), the Conductor's
 * CLAIMS-VALIDATE stage returns `undefined`, stage 6a is SKIPPED, and the turn
 * falls through to the lie-capable PROSE responder. Emitting a synthetic candidate
 * for every uncovered REQUIRED type makes the candidate set NON-EMPTY, so
 * CLAIMS-VALIDATE produces a result → 6a fires → the renderer emits the
 * proposition-free SAFE_TEMPLATES terminal, NEVER prose.
 *
 * SOUND + IDOR-safe by construction:
 *   - `subject` is the AUTHENTICATED `principal`, NEVER model output — so an
 *     owner-scoped synthetic can never name a resource the model extracted (the
 *     IDOR the per-turn `owns` closes). A `customerId` is never an owned
 *     order/payment ledger id, so the parameterized key
 *     (`order_fulfillment_stage:{principal}`) is ABSENT this turn → the kernel's §5
 *     present(e) check fails BEFORE the C1 ownership arm → verdict UNKNOWN.
 *   - `value: undefined` — the model authors nothing; C6 abstains. NON-empty
 *     requiredEvidence (from the type's registry spec) satisfies C0, so the verdict
 *     is UNKNOWN (honest ignorance), never REFUSED.
 *   - A synthetic STORE_OPEN_NOW (a PUBLIC, single-key type) may INSTEAD genuinely
 *     VALIDATE when this turn's ledger holds a fresh `schedule:store_open_now` read
 *     — its value is bound from that ledger entry by `bindValueFromLedger` in
 *     `propose`. That is SOUND (ledger-sourced, strictly better than UNKNOWN); the
 *     falsifier (a present ScheduleOverride) and freshness arms still run in
 *     `runClaimsKernel`.
 *
 * Pure.
 */
function synthesizeSafeTerminalCandidates(
  required: ReadonlySet<RegistryClaimType>,
  covered: ReadonlySet<string>,
  actor: { readonly principal: string; readonly sessionId: string },
): CandidateClaim[] {
  const synthetic: CandidateClaim[] = [];
  for (const type of required) {
    if (covered.has(type)) continue; // the planner already framed this type.
    const candidate = selectCandidateClaim({
      type,
      // Placeholder subject = the AUTHENTICATED principal (never model output —
      // IDOR-safe). For a per-resource type this parameterizes the ledger key to
      // `{base}:{principal}`, which is ABSENT (a principal is never an owned
      // resource id) → present(e) fails → honest UNKNOWN.
      subject: actor.principal,
      actor,
      // No model-authored value under the tag protocol; undefined → C6 abstains.
      value: undefined,
    });
    // `selectCandidateClaim` returns undefined only for an out-of-registry type;
    // the decomposer's required set is registry-typed by construction, so this
    // always yields a candidate — the guard is defense-in-depth.
    if (candidate !== undefined) synthetic.push(candidate);
  }
  return synthetic;
}

/**
 * Adapt the EXISTING Q6b claim-aware planner into the published
 * `ClaimPlannerPort`. The SAME planner instance is wired as the Conductor's
 * `planner` (its `PlannerPort.propose` is the intent path, unchanged); this
 * adapter exposes the additive `proposeClaims` seam as the CLAIMS-VALIDATE
 * stage's candidate source.
 */
export function createIbatexasClaimPlanner(
  planner: ClaimAwarePlannerPort,
): ClaimPlannerPort {
  return {
    async propose(
      input: ClaimPlannerInput,
    ): Promise<ReadonlyArray<CandidateClaim>> {
      // FIX 1 + FIX 2 — thread the AUTHENTICATED owner-scoped context to the
      // planner so an owner-scoped candidate's actor (the authenticated principal)
      // and subject (an owner-scoped PRESENT read) derive from the conductor's
      // identity / owner-scoped reads, NEVER the model's self-assertion (IDOR-safe;
      // SDD §E C1, Inv 2). `ownedResourceIdsByBaseKey` reads ONLY entries that
      // resolved PRESENT in this turn's ledger (a forged/cross-owner read errored →
      // absent → excluded), so the set of admissible subjects is owner-scoped by
      // construction. Both inputs are optional on `ClaimPlannerInput` (a host that
      // never wired them yields no auth context → the planner fails closed).
      const auth: ClaimAuthContext = {
        ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
        ...(input.ledger === undefined
          ? {}
          : { ownedByBaseKey: ownedResourceIdsByBaseKey(input.ledger) }),
      };

      // Delegate to the existing planner's registry-walled `proposeClaims` (the
      // `ClaimPlan.candidates` are the typed `@adjudicate/core` `CandidateClaim`s
      // that PASSED the constrained-generation wall — the `runClaimsKernel` input
      // shape). WRAPPED in try/catch: the local 4B intermittently emits malformed
      // tool-call XML the model client THROWS on (~1/3 turns) — the FLAKE fail-open.
      // A SUCCESSFUL call (empty or not) is the planner's HONEST signal and is
      // surfaced UNCHANGED (see the `flaked` gate below); only a THROW triggers the
      // safe-terminal synthesis.
      let candidates: ReadonlyArray<CandidateClaim>;
      let flaked = false;
      try {
        candidates = (await planner.proposeClaims(input.cognition, auth)).candidates;
      } catch (err) {
        flaked = true;
        candidates = [];
        // OBSERVABILITY: the throw no longer escapes to @claustrum/core's
        // claims-validate (which used to log the "degrading to no-claims" degrade),
        // so the ~1/3-turn 4B tool-call flake would go SILENT in VictoriaLogs. Log
        // it HERE instead, with a stable event marker the logging pipeline keys on.
        // Best-effort + NEVER re-thrown (telemetry must not break a turn).
        logger.warn(
          {
            component: "claim-planner",
            event: "claim_planner.propose_failed",
            turnId: input.cognition.turnId,
            err: err instanceof Error ? err.message : String(err),
          },
          "claim-planner proposeClaims failed; synthesizing safe UNKNOWN candidates for required claim types",
        );
      }
      // BKL-077 (known adjacent bug — do NOT fix here): `proposeClaims` also returns
      // `forcedTerminal` (§O#9 ESCALATE / P4 CLARIFY), which this published-port
      // adapter DISCARDS (the `ClaimPlannerPort` surfaces only candidates). A turn
      // that SHOULD ESCALATE/CLARIFY is masked to a safe UNKNOWN by the synthesis
      // below — acceptable for now (still proposition-free, never prose); restoring
      // ESCALATE/CLARIFY fidelity needs a port widening, tracked as BKL-077.

      // F1 SAFE TERMINAL — synthesize ONLY on the FLAKE path. The discriminator is
      // `flaked ∧ required non-empty`:
      //   - flaked + a claim-requiring question (required non-empty) → synthesize a
      //     safe UNKNOWN so the turn degrades proposition-free, never to prose;
      //   - flaked + smalltalk (required empty) → synthetic is [] → keep [] so the
      //     conversational responder still runs;
      //   - a SUCCESSFUL proposeClaims (empty or not) → NEVER synthesized over. The
      //     §O#15 decomposer is DEMOTE-ONLY and its keyword markers also match
      //     STATEMENTS, so promoting a successful-empty proposal would override the
      //     prose draft with a non-sequitur "não localizei…" on a thanks/statement.
      //     KNOWN GAP (BKL-078): a successful-but-empty proposal on a genuinely
      //     claim-requiring question thus still falls through to prose (pre-existing).
      // On the flake path `candidates` is [] (so `covered` is empty → the full
      // required set is synthesized). The §O#15 decomposer runs ONLY here — a pure
      // keyword scan skipped entirely on the common successful path.
      const authPrincipal =
        input.customerId !== undefined && input.customerId.trim() !== ""
          ? input.customerId
          : "unauthenticated";
      const covered = new Set(candidates.map((c) => c.type));
      const synthetic = flaked
        ? synthesizeSafeTerminalCandidates(
            decomposeRequiredClaims(
              classifyRequestSpans(input.cognition.perception.text),
            ),
            covered,
            {
              principal: authPrincipal,
              sessionId: input.cognition.conversationId,
            },
          )
        : [];
      const all: ReadonlyArray<CandidateClaim> =
        synthetic.length === 0 ? candidates : [...candidates, ...synthetic];

      // OWNER-POSITIVE close (tag-then-derive STEP 2 for owner-scoped types) + the F1
      // synthetic value-bind: bind each candidate's value from the AUTHENTICATED
      // read already PRESENT in this turn's ledger, so the kernel's C6 compares a
      // first-party value (never a model value) and the legit owner — or a synthetic
      // STORE_OPEN_NOW backed by a fresh `schedule:store_open_now` read — VALIDATEs.
      // No ledger (an unwired host) → candidates pass through unchanged (fail-closed:
      // an undefined owner-scoped value → C6 ABSTAIN → UNKNOWN).
      //
      // BELT-AND-SUSPENDERS: @claustrum/core ≥ 0.4.0 CLAIMS-VALIDATE also performs
      // this exact ledger-exact value derivation in its per-turn reconcile (its
      // "(4b)" step) before `runClaimsKernel`. Doing it HERE too is idempotent (both
      // bind ONLY when `value === undefined`) and keeps the owner-positive close
      // self-contained + unit-testable at the ibatexas adapter layer, and resilient
      // to a host that wires an older claustrum without the reconcile.
      if (input.ledger === undefined) return all;
      const ledger = input.ledger;
      return all.map((c) => bindValueFromLedger(c, ledger));
    },
  };
}
