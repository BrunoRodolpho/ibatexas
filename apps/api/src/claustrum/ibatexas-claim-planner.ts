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
// UNCHANGED except for the BKL-110 demote-only relevance filter (below): the §O#15
// decomposer is a DEMOTE-ONLY completeness net whose keyword markers also match
// STATEMENTS ("pagode", "meu pedido chegou, obrigado!", "vou pagar com pix"
// mid-checkout), so promoting a successful-empty proposal into the claims path
// would override the prose draft with a non-sequitur "não localizei…". KNOWN GAP
// (BKL-078): a successful-but-empty proposal on a genuinely claim-requiring
// question therefore still falls through to prose (pre-existing behavior); closing
// it needs an interrogative/imperative span signal the keyword decomposer does not
// provide.
//
// BKL-110 DEMOTE-ONLY RELEVANCE FILTER (successful path only). Live-proven defect
// (round-2, turn 157bbfff): with the claims pipeline on, "oi, tudo bem?" got the
// SAFE_UNKNOWN template because the 4B claim-planner OVER-PROPOSED a schedule claim
// on smalltalk — a non-empty candidate set defeats @claustrum/core's
// emptiness/prose-preservation gate, and the over-proposed claim could not
// validate → UNKNOWN terminal clobbered the greeting. The filter DROPS a
// model-proposed candidate whose type is within the decomposer's demote-authority
// (its span-class markers scan for it) but whose span was NOT detected this turn,
// so the candidate set collapses back to empty → the prose gate is preserved. It
// is strictly DEMOTE-ONLY (never adds/synthesizes a candidate here) and scoped to
// {@link RELEVANCE_GOVERNED_TYPES}: a type the decomposer has no marker for
// (MENU_ITEM_ALLERGENS, PURCHASE_COMPLETED) is NEVER demoted — the net has no
// authority to call it irrelevant, so its behavior is byte-identical to today
// (this is why the filter cannot be the literal "keep iff type ∈ required set":
// the Triad-scoped decomposer required-set is empty for a legitimate allergens
// question, which would wrongly demote the answer). BOUNDED RESIDUAL (BKL-078
// territory, not worsened): a STATEMENT whose keywords net-match a governed type
// (e.g. "meu pedido chegou, obrigado!") keeps its over-proposed claim (the net
// cannot tell a statement from a question), so it can still render the UNKNOWN
// non-sequitur — the worst case is unchanged-from-today, never worse.

import type { CandidateClaim, EvidenceLedger } from "@adjudicate/core";
import type {
  ClaimPlannerForcedTerminal,
  ClaimPlannerInput,
  ClaimPlannerPort,
  ClaimPlannerResult,
} from "@claustrum/core";
import { logger } from "../lib/logger.js";
import {
  buildClassifyOnlyCandidates,
  classifyOnlyReadsEnabled,
  classifyOnlyRequiredTypes,
} from "./classify-only-reads.js";
import { selectCandidateClaim, type RegistryClaimType } from "./claim-registry.js";
import type { ClaimAuthContext, ClaimAwarePlannerPort } from "./ibatexas-planner.js";
import { ownedResourceIdsByBaseKey } from "./ibatexas-claims-kernel-deps.js";
import { completeWithResilience } from "./complete-with-retry.js";
import {
  classifyRequestSpans,
  decomposeRequiredClaims,
  REQUIRED_CLAIM_CLOSURE,
} from "./required-claim-decomposer.js";

// BKL-168 — total proposeClaims completion attempts (incl. the first) before the F1
// safe-terminal degrade. The F1 catch already guarantees never-silent (a throw →
// synthesized safe UNKNOWN); this adds a bounded jittered RETRY before that degrade
// so a transient 4B tool-call-XML flake self-heals instead of always degrading.
// Reuses the planner's EXISTING extraction retry budget (same planner-layer
// completion-retry concern, already an .env.example knob) rather than minting a new
// env var — config-from-env (Hard Rule #3), no new knob to document.
const PROPOSE_CLAIMS_RETRY_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.EXTRACTION_EMPTY_RETRY_MAX_ATTEMPTS ?? "2", 10) || 2,
);

/** BKL-168 — test seam: injectable retry timing for the proposeClaims resilience
 *  wrap, so a forced-throw test drives the retry without real timers. Defaults
 *  (production): the shared bounded/jittered sleep + the env-tuned attempt budget. */
export interface ClaimPlannerCompletionRetryOptions {
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly delayForAttempt?: (n: number) => number;
}

/**
 * BKL-110 — the claim types the §O#15 decomposer has DEMOTE-AUTHORITY over: the
 * ones whose span-class markers it actually scans for. Derived from the single
 * source of truth (`REQUIRED_CLAIM_CLOSURE`'s Triad value-union: STORE_OPEN_NOW,
 * ORDER_FULFILLMENT_STAGE, PAYMENT_STATUS) plus STORE_HOURS — the schedule-cluster
 * SIBLING of STORE_OPEN_NOW (both are covered by the STORE_OPEN_NOW_Q markers
 * `/abert|fechad|que horas|funciona|hor[áa]rio/`; the decomposer's Triad closure
 * only NAMES STORE_OPEN_NOW, so STORE_HOURS is spliced in here). A type OUTSIDE this
 * set is one the net has no marker for (MENU_ITEM_ALLERGENS, PURCHASE_COMPLETED) — it
 * is NEVER demoted, so a legitimate allergens/purchase claim is surfaced
 * byte-identically to today (demote-only-safe). If the closure grows a Triad row,
 * this domain auto-expands.
 *
 * BKL-121 (why STORE_HOURS is spliced HERE, not added to the required closure): a
 * TODAY'S-hours claim has honest override/holiday FALSIFIERS, so it degrades to
 * UNKNOWN on an exception day. Adding STORE_HOURS to the STORE_OPEN_NOW_Q REQUIRED
 * set would couple it to STORE_OPEN_NOW's completeness — a required-but-UNKNOWN (or,
 * on the common turn where the model proposes only STORE_OPEN_NOW, required-but-
 * ABSENT) STORE_HOURS would DEGRADE the whole turn and LOSE the live-proven
 * STORE_OPEN_NOW answer. So STORE_HOURS stays ADDITIVE at the PROPOSAL layer (per
 * BKL-121 D3): the persona proposes it, this filter KEEPS it on a schedule turn, and
 * it renders its own line independently — never re-routing the STORE_OPEN_NOW_Q span
 * and never coupling completeness.
 */
const RELEVANCE_GOVERNED_TYPES: ReadonlySet<string> = new Set<string>([
  ...Object.values(REQUIRED_CLAIM_CLOSURE).flat(),
  "STORE_HOURS",
]);

/**
 * BKL-110 — the DEMOTE-ONLY relevance predicate for one model-proposed candidate.
 * Returns whether the candidate stays; the caller drops it when this is `false`.
 * KEEP (never demote) when:
 *   - the type is OUTSIDE {@link RELEVANCE_GOVERNED_TYPES} — the decomposer has no
 *     marker for it, so no authority to call it irrelevant (unchanged-from-today);
 *   - the decomposer REQUIRED the type this turn (its span was detected);
 *   - it is STORE_HOURS on a turn the schedule span-class fired (STORE_OPEN_NOW is
 *     required) — the two share the STORE_OPEN_NOW_Q markers, so a legitimate hours
 *     question that maps to STORE_OPEN_NOW must never demote a STORE_HOURS answer
 *     (the additive schedule-cluster companion; BKL-121 D3 keeps it at the proposal
 *     layer rather than the required-completeness closure — see the module note).
 * Otherwise the type is governed but its span was NOT detected → DEMOTE. Pure.
 */
function isCandidateRelevant(
  type: string,
  required: ReadonlySet<RegistryClaimType>,
): boolean {
  if (!RELEVANCE_GOVERNED_TYPES.has(type)) return true;
  if ((required as ReadonlySet<string>).has(type)) return true;
  return type === "STORE_HOURS" && required.has("STORE_OPEN_NOW");
}

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
  options: { readonly completionRetry?: ClaimPlannerCompletionRetryOptions } = {},
): ClaimPlannerPort {
  return {
    async propose(
      input: ClaimPlannerInput,
    ): Promise<ClaimPlannerResult> {
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

      // FE-T18 (FE-3.0 / D1) — the classify-only read bypass. Gated OFF by
      // default (ENABLE_CLASSIFY_ONLY_READS); when ON, a turn whose text
      // classifies WHOLESALE into the narrow owner-scoped eligible set
      // (classify-only-reads.ts) skips the model's `propose_claim` call
      // entirely — the candidate claim is framed deterministically from the
      // AUTHENTICATED owner-scoped context instead. Any OTHER turn (flag OFF,
      // no read span matched, or a mixed/ineligible span) falls through to the
      // EXISTING model-call path below, byte-identical to today.
      const classifyOnlyRequired = classifyOnlyReadsEnabled()
        ? classifyOnlyRequiredTypes(input.cognition.perception.text)
        : undefined;

      // Delegate to the existing planner's registry-walled `proposeClaims` (the
      // `ClaimPlan.candidates` are the typed `@adjudicate/core` `CandidateClaim`s
      // that PASSED the constrained-generation wall — the `runClaimsKernel` input
      // shape). WRAPPED in try/catch: the local 4B intermittently emits malformed
      // tool-call XML the model client THROWS on (~1/3 turns) — the FLAKE fail-open.
      // A SUCCESSFUL call (empty or not) is the planner's HONEST signal and is
      // surfaced UNCHANGED (see the `flaked` gate below); only a THROW triggers the
      // safe-terminal synthesis. SKIPPED ENTIRELY on the classify-only path — no
      // model call is made, so there is nothing to flake.
      let candidates: ReadonlyArray<CandidateClaim>;
      // BKL-077 — the planner-FORCED turn terminal (§O#9 safety ESCALATE / P4-unmapped
      // or owner-scoped-ambiguity CLARIFY). `proposeClaims` already COMPUTES it; the
      // adapter now CAPTURES it and returns it in the widened `ClaimPlannerProposal`
      // shape so claustrum's CLAIMS-VALIDATE honors it (resolveTurnTerminal): a forced
      // ESCALATE outranks a would-be RENDER, and a forced CLARIFY is honored even on an
      // EMPTY candidate set (the 3-payments "which order?" turn). Stays `undefined` on
      // the flake (throw) path — the model produced no signal, so the turn still
      // degrades to the synthesized safe UNKNOWN below, never a masked ESCALATE. On the
      // classify-only path a forced CLARIFY instead comes from FIX 2's ≥2-owned
      // ambiguity (buildClassifyOnlyCandidates) — the deterministic mirror of the
      // model path's OWN FIX 2 branch, never a safety ESCALATE (see
      // classify-only-reads.ts's documented residual FE-D12: no model call ⟹
      // no model-self-reported safety marker on this path).
      let forcedTerminal: ClaimPlannerForcedTerminal | undefined;
      let flaked = false;
      if (classifyOnlyRequired !== undefined) {
        const built = buildClassifyOnlyCandidates(
          classifyOnlyRequired,
          auth,
          input.cognition.conversationId,
        );
        candidates = built.candidates;
        forcedTerminal = built.forcedTerminal;
        logger.info(
          {
            component: "claim-planner",
            event: "claim_planner.classify_only",
            turnId: input.cognition.turnId,
            candidateTypes: [...new Set(candidates.map((c) => c.type))],
            ...(forcedTerminal === undefined ? {} : { forcedTerminal }),
          },
          "claim-planner: classify-only read path — propose_claim model call skipped",
        );
      } else {
        // BKL-168 — a bounded, jittered RETRY around the completion boundary BEFORE
        // the F1 safe-terminal degrade: a transient 4B tool-call-XML flake (the
        // ~1/3-turn Ollama throw) self-heals on a re-prompt instead of ALWAYS
        // degrading. `completeWithResilience` CAPTURES the throw internally, so there
        // is NO duplicate catch layer — `ok:false` arrives only after every attempt
        // threw, and is then the SAME safe-UNKNOWN degrade as before (flaked = true),
        // now with a structured completion_error event.
        const retry = options.completionRetry ?? {};
        const proposeResult = await completeWithResilience(
          () => planner.proposeClaims(input.cognition, auth),
          {
            maxAttempts: retry.maxAttempts ?? PROPOSE_CLAIMS_RETRY_MAX_ATTEMPTS,
            ...(retry.sleep ? { sleep: retry.sleep } : {}),
            ...(retry.delayForAttempt ? { delayForAttempt: retry.delayForAttempt } : {}),
          },
        );
        if (proposeResult.ok) {
          candidates = proposeResult.completion.candidates;
          forcedTerminal = proposeResult.completion.forcedTerminal;
        } else {
          flaked = true;
          candidates = [];
          forcedTerminal = undefined;
          // OBSERVABILITY: the throw no longer escapes to @claustrum/core's
          // claims-validate (which used to log the "degrading to no-claims" degrade),
          // so the ~1/3-turn 4B tool-call flake would go SILENT in VictoriaLogs. Log
          // it HERE with a stable, STRUCTURED completion_error marker (reason +
          // attempts, mirroring the planner's extraction_failure seam). Best-effort +
          // NEVER re-thrown (telemetry must not break a turn).
          logger.warn(
            {
              component: "claim-planner",
              event: "claim_planner.propose_failed",
              reason: "completion_error",
              turnId: input.cognition.turnId,
              attempts: proposeResult.attempts,
              err:
                proposeResult.error instanceof Error
                  ? proposeResult.error.message
                  : String(proposeResult.error),
            },
            "claim-planner proposeClaims failed after retry; synthesizing safe UNKNOWN candidates for required claim types",
          );
        }
      }
      // BKL-111 — the model's proposal (constrained-generation survivors) BEFORE the
      // demote filter reassigns `candidates`, so the prose-preserved signal below can
      // report WHAT collapsed. Empty on the flake path (candidates = []).
      const proposedTypes = candidates.map((c) => c.type);

      // The §O#15 required-claim set for THIS turn — the SAME pure keyword scan
      // BKL-005 uses. Computed ONCE and shared by the BKL-110 demote-only relevance
      // filter (successful path) and the F1 safe-terminal synthesis (flake path).
      const required = decomposeRequiredClaims(
        classifyRequestSpans(input.cognition.perception.text),
      );

      // BKL-110 DEMOTE-ONLY RELEVANCE FILTER — runs ONLY on the SUCCESSFUL propose
      // path (the flake path leaves `candidates` = [] so this is a no-op and the F1
      // synthesis below stays byte-identical; the BKL-005 throw path is untouched).
      // Drop each model-proposed candidate the decomposer GOVERNS but did NOT
      // require this turn (over-proposed on a span with no matching marker — the
      // live smalltalk hijack). STRICTLY demote-only: no candidate is ever added
      // here. When something drops, reassign to the kept set; when nothing drops,
      // leave `candidates` untouched so its reference (and byte-identity) is
      // preserved for the "surfaced unchanged" contract.
      // BKL-111 — the demoted types, hoisted so the prose-preserved signal below can
      // attribute a demote-to-empty collapse. Empty unless the demote filter fires.
      let demotedTypes: readonly string[] = [];
      if (!flaked && candidates.length > 0) {
        const kept: CandidateClaim[] = [];
        const droppedClaimTypes: string[] = [];
        for (const c of candidates) {
          if (isCandidateRelevant(c.type, required)) kept.push(c);
          else droppedClaimTypes.push(c.type);
        }
        if (droppedClaimTypes.length > 0) {
          logger.info(
            {
              component: "claim-planner",
              event: "claim_planner.candidate_demoted",
              turnId: input.cognition.turnId,
              // Ride the existing `droppedClaimTypes` telemetry vocabulary with a
              // DISTINCT reason so the constrained-generation out-of-enum drops
              // (planner-side) and these relevance demotions stay separable.
              droppedClaimTypes,
              reason: "not_required_for_span",
            },
            "claim-planner demoted over-proposed candidate(s) not indicated by the request span",
          );
          candidates = kept;
          demotedTypes = droppedClaimTypes;
        }
      }

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
      // required set is synthesized).
      const authPrincipal =
        input.customerId !== undefined && input.customerId.trim() !== ""
          ? input.customerId
          : "unauthenticated";
      const covered = new Set(candidates.map((c) => c.type));
      const synthetic = flaked
        ? synthesizeSafeTerminalCandidates(required, covered, {
            principal: authPrincipal,
            sessionId: input.cognition.conversationId,
          })
        : [];
      const all: ReadonlyArray<CandidateClaim> =
        synthetic.length === 0 ? candidates : [...candidates, ...synthetic];

      // BKL-111 — the COMPLEMENTARY `claims.terminal` signal for the PROSE-PRESERVED
      // collapse. When the returned candidate set is EMPTY, CLAIMS-VALIDATE returns
      // undefined (handle-turn 6a is skipped) and the model's prose draft stands, so
      // the RENDER-path emitter in claims-renderer-adapter.ts never fires for this
      // turn. Emit the single `claims.terminal` HERE instead — carrying `turnId`
      // (available at this seam, unlike the renderer), the collapse reason, and the
      // types that collapsed. MUTUALLY EXCLUSIVE with the render-path emit (`all`
      // non-empty ⟺ the renderer runs), so exactly ONE `claims.terminal` is logged
      // per claims-engaged turn. OBSERVE-ONLY + PII-free: registry type names +
      // turnId only, never a claim value or request text. Byte-identical when the
      // flag is off (this adapter is only wired when ENABLE_CLAIMS_PIPELINE).
      //
      // BKL-077 GUARD (`forcedTerminal === undefined`): a forced ESCALATE/CLARIFY on an
      // EMPTY candidate set is NOT prose-preserved — claustrum's CLAIMS-VALIDATE runs
      // the kernel over `[]` and STAMPS the forced terminal (it does NOT return
      // undefined), so the render-path `claims.terminal` emitter fires downstream.
      // Logging prose_preserved here too would both MIS-STATE the turn as prose and
      // DOUBLE-EMIT, breaking the one-`claims.terminal`-per-engaged-turn invariant. So
      // this emits ONLY when the turn genuinely falls through to prose (no forced
      // terminal). When `forcedTerminal` is undefined this is byte-identical to before.
      if (all.length === 0 && forcedTerminal === undefined) {
        logger.info(
          {
            component: "claims",
            event: "claims.terminal",
            turnId: input.cognition.turnId,
            posture: "prose_preserved",
            reason: flaked
              ? "planner_flake"
              : demotedTypes.length > 0
                ? "demoted_to_empty"
                : "no_candidates",
            candidateTypes: [...new Set(proposedTypes)],
            ...(demotedTypes.length > 0
              ? { droppedClaimTypes: [...new Set(demotedTypes)] }
              : {}),
          },
          "claims terminal finalized (prose preserved — empty candidate set)",
        );
      }

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
      let finalCandidates: ReadonlyArray<CandidateClaim> = all;
      if (input.ledger !== undefined) {
        const ledger = input.ledger;
        finalCandidates = all.map((c) => bindValueFromLedger(c, ledger));
      }

      // WIDENED RETURN (BKL-077): emit the `{ candidates, forcedTerminal }` proposal
      // ONLY when a terminal was forced; otherwise return the BARE array so every
      // no-forced-terminal turn is BYTE-IDENTICAL to the pre-widening behavior
      // (claustrum's `normalizeClaimPlannerResult` reads a bare array as
      // `forcedTerminal: undefined`, and reference-identity of the surfaced array is
      // preserved for the "surfaced unchanged" contract). This makes the "must not
      // change a turn with no forced terminal" guarantee STRUCTURAL, not incidental.
      return forcedTerminal === undefined
        ? finalCandidates
        : { candidates: finalCandidates, forcedTerminal };
    },
  };
}
