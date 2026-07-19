// claims-renderer-adapter.ts — the ibatexas bridge that wires the pure
// `renderer-from-claims` into the claustrum `ClaimsRendererPort` seam (SDD §B /
// §Q.7; v1.1 §3; Plan 1 Phase 3 / E-2). This is the loop-level closure of the
// "claims-not-prose" thesis: when the claims pipeline is wired (flag ON),
// `handleTurn` stage 6a renders the reply TEXT from the validated claim set via
// THIS adapter, superseding the model draft's text.
//
// The adapter is a thin, PURE projection — it owns NO rendering policy. It maps
// the published `@adjudicate/core` `ClaimsKernelResult` (the SAME shape the
// CLAIMS-VALIDATE stage emits) onto the `renderer-from-claims` `render` inputs:
//
//   - `renderable`              → the renderable VALIDATED+consistent claim set
//   - `terminal`                → the turn terminal (RENDER | UNKNOWN | ESCALATE | CLARIFY)
//   - `consistency.suppressions`→ the proposition-free suppression records (§O#5)
//
// then returns the rendered text as a `ClaimsRenderResult`. Determinism +
// proposition-freedom + the Inv 6 1:1 binding are ALL enforced inside
// `renderer-from-claims` (this adapter adds none of its own); C6 value-from-
// ledger is closed UPSTREAM by the kernel's `valueBindingVerdict` (a VALIDATED
// claim's value at the bound `path` is proven equal to its licensing ledger
// entry), so the field the slot grammar reads is the ledger-sourced value — the
// adapter never re-derives or widens it.
//
// Dependency arrow stays `adjudicate → claustrum → ibatexas`: this adapter is the
// ibatexas (downstream) deliverable; claustrum exposes only the port contract.

import type { ClaimsKernelResult, ClaimVerdict } from "@adjudicate/core";
import type {
  ActiveResourceRef,
  ClaimsRenderContext,
  ClaimsRenderPrecedence,
  ClaimsRendererPort,
  ClaimsRenderResult,
} from "@claustrum/core";
import { logger } from "../lib/logger.js";
import {
  decideRenderPrecedence,
  type RenderPrecedenceContext,
} from "./claims-render-precedence.js";
import {
  type ActiveResourceOwnership,
  checkRequiredClaimCompleteness,
  classifyRequestSpans,
  decomposeRequiredClaims,
} from "./required-claim-decomposer.js";
import { PROVABLY_EMPTY_KIND } from "./ibatexas-claims-kernel-deps.js";
import { render } from "./renderer-from-claims.js";

/** De-dupe a type-name list, preserving first-seen order (deterministic). */
function distinctTypes(types: readonly string[]): string[] {
  return [...new Set(types)];
}

/**
 * BKL-111 — emit the ONE structured `claims.terminal` signal for a claims-ENGAGED
 * RENDER-path turn (the render/terminal supersession point). This fires EXACTLY
 * when `handleTurn` stage 6a calls the renderer — i.e. when CLAIMS-VALIDATE
 * produced a kernel result (a NON-empty candidate set survived to the kernel).
 * The COMPLEMENTARY empty-candidate collapse ("prose_preserved") is emitted
 * upstream in `ibatexas-claim-planner.ts` (the renderer is never called then), so
 * across the two mutually-exclusive seams there is exactly ONE `claims.terminal`
 * per claims-engaged turn. No-op when `ENABLE_CLAIMS_PIPELINE` is off: the whole
 * renderer seam is only constructed by `buildClaimsSeams` when the flag is on, so
 * a flag-off boot never reaches this code (byte-identical).
 *
 * OBSERVE-ONLY: a best-effort telemetry side-channel that reads ONLY the kernel
 * result's structural identity (posture + registry TYPE names + verdicts +
 * counts). It changes NO control flow and NO rendered text — the render contract
 * (pure deterministic TEXT of `(claims, context)`) is preserved (the text is a
 * function of the SAME inputs, unaffected by this log). SIGNAL-ONLY (one line per
 * turn) and PII-FREE by construction: it emits registry type names, three-valued
 * verdicts, the terminal posture and counts — NEVER a claim VALUE, the request
 * text, or the rendered text.
 *
 * `posture` is the FINAL rendered posture (the terminal the adapter actually
 * renders): `VALIDATED_RENDER` (kernel RENDER, not degraded), `UNKNOWN`,
 * `ESCALATE`, or `CLARIFY`. `degradedFromRender` separates the §O#15 completeness
 * DOWNGRADE (kernel said RENDER, the adapter degraded it to UNKNOWN) from an
 * intrinsic kernel UNKNOWN — the exact distinction the two live-validation rounds
 * had to reconstruct by byte-matching delivered text against slot templates.
 *
 * BKL-117 (CLOSED — @claustrum/core 0.8.0): `ClaimsRenderContext` now carries the
 * `turnId` (claustrum populates it from `Capsule.turnId`), so the RENDER-path
 * `claims.terminal` is now JOINABLE by id to `turn_trace` / the BKL-110
 * `claim_planner.candidate_demoted` event (which the `prose_preserved` companion
 * planner seam already carries). Threaded in `render` below and emitted here as the
 * `turnId` field WHEN PRESENT; absent (seam unwired / pre-0.8.0) → the field is
 * omitted → byte-identical to the pre-BKL-117 log line.
 */
function emitClaimsTerminal(
  claims: ClaimsKernelResult,
  degraded: boolean,
  turnId?: string,
): void {
  const finalTerminal = degraded ? "UNKNOWN" : claims.terminal;
  const posture =
    finalTerminal === "RENDER" ? "VALIDATED_RENDER" : finalTerminal;
  const suppressedTypes = distinctTypes(
    claims.consistency.suppressions.flatMap((s) => s.conflictTypes),
  );
  logger.info(
    {
      component: "claims",
      event: "claims.terminal",
      // BKL-117 — the turn_trace join key (present since @claustrum/core 0.8.0
      // threads ClaimsRenderContext.turnId); omitted when the seam is unwired.
      ...(turnId === undefined ? {} : { turnId }),
      posture,
      // The RAW kernel terminal, so `kernelTerminal: RENDER` + `posture: UNKNOWN`
      // uniquely identifies a §O#15 completeness-gate degrade.
      kernelTerminal: claims.terminal,
      degradedFromRender: degraded,
      // The candidate types that reached the kernel (post-BKL-110-demote input
      // set), each with its three-valued §5 verdict split out.
      candidateTypes: distinctTypes(claims.perClaim.map((c) => c.type)),
      validatedTypes: distinctTypes(
        claims.perClaim.filter((c) => c.verdict === "VALIDATED").map((c) => c.type),
      ),
      // Kernel-DROPPED candidate types (non-VALIDATED — UNKNOWN/REFUSED). This is
      // DISTINCT from the planner-side BKL-110 demote (pre-kernel), which is
      // separately observable as `claim_planner.candidate_demoted`.
      droppedClaimTypes: distinctTypes(
        claims.perClaim.filter((c) => c.verdict !== "VALIDATED").map((c) => c.type),
      ),
      // How many canonical claims actually render (0 on any non-VALIDATED_RENDER
      // posture, including a degrade — the kernel mints `renderableCanonical` under
      // RENDER, but the adapter renders the safe terminal when it degrades).
      renderedCount:
        posture === "VALIDATED_RENDER" ? claims.renderableCanonical.length : 0,
      ...(suppressedTypes.length > 0 ? { suppressedTypes } : {}),
    },
    "claims terminal finalized (render path)",
  );
}

/**
 * Derive the #8 {@link ActiveResourceOwnership} signal for the §O#15 decomposer from
 * THIS turn's threaded active-resource refs (the `activeResourcesFromLedger` seam
 * output on `ClaimsRenderContext.activeResources`). BKL-073.
 *
 * `undefined` input (the seam is UNWIRED / no ledger this turn) → `undefined`: the
 * decomposer is then called WITHOUT ownership → nothing is ever dropped → BYTE-
 * IDENTICAL to the pre-BKL-073 adapter.
 *
 * Otherwise a flag is `false` ONLY on a POSITIVE provable-empty determination — a
 * `{ kind: PROVABLY_EMPTY_KIND, id }` sentinel present in the refs (Rule B′ in the
 * seam: that dimension's enumeration marker resolved PRESENT with count 0 ∧ no
 * positive ref of that kind; or the guest path — a guest owns nothing). The sentinel
 * is the ONLY thing that yields `false`, so the decomposer's load-bearing "false ⟺
 * positive first-party determination" contract holds: any uncertainty (marker
 * errored/absent → NO sentinel) leaves the flag `true` → the companion is KEPT →
 * honest UNKNOWN, never "render the easy half."
 *
 * Both flags are now symmetric (BKL-073 order + BKL-079 payment): `hasActiveOrder`
 * goes `false` via the order sentinel (the `active_orders` marker's count-0 Rule B′,
 * or the guest path) and `hasActivePayment` via the payment sentinel (the
 * `active_payments` marker's count-0 Rule B′, or the guest path). This adapter needs
 * NO change for BKL-079 — it already consumes a `payment` sentinel; BKL-079 only
 * adds the authed PRODUCER (investigator marker + seam Rule B′).
 */
export function ownershipFromActiveResources(
  rs?: readonly ActiveResourceRef[],
): ActiveResourceOwnership | undefined {
  if (rs === undefined) return undefined;
  const provablyEmpty = (id: string): boolean =>
    rs.some((r) => r.kind === PROVABLY_EMPTY_KIND && r.id === id);
  return {
    hasActiveOrder: !provablyEmpty("order"),
    hasActivePayment: !provablyEmpty("payment"),
  };
}

/**
 * Build the ibatexas `ClaimsRendererPort` from the pure `renderer-from-claims`.
 * PURE/deterministic: same `(ClaimsKernelResult, context)` ⟹ same text (no
 * clock/RNG/IO). On a non-RENDER terminal it returns ONLY the proposition-free
 * safe template.
 *
 * §O#15 REQUIRED-CLAIM COMPLETENESS GATE (Plan 1 Phase 3 / F2). Before rendering,
 * the adapter runs the DETERMINISTIC, PLANNER-INDEPENDENT decomposer over THIS
 * request: it classifies the request text into span-classes
 * ({@link classifyRequestSpans}), decomposes the MANDATORY required-claim set
 * ({@link decomposeRequiredClaims}), and checks it against the kernel's per-claim
 * verdicts ({@link checkRequiredClaimCompleteness}). A required companion that
 * resolved ABSENT / UNKNOWN / REFUSED DEGRADES the turn to a proposition-free
 * UNKNOWN — closing the "render the easy half" hole (a literal-true subset
 * rendered while a required companion silently disappeared from the renderable
 * set). DEMOTE-ONLY: the gate only turns a `RENDER` into `UNKNOWN`; it never
 * upgrades, and never touches an already-safe ESCALATE/CLARIFY/UNKNOWN terminal.
 */
/** Construction opts for the ibatexas claims renderer. */
export interface IbatexasClaimsRendererOptions {
  /**
   * BKL-152-edge — set `true` ONLY where the adopter wired the RenderCarriersForTurn
   * seam (claustrum-bootstrap), so the completeness gate can read the seam's
   * clock-resolved `resolvedQueryDate` for the EXACT weekday==today STORE_OPEN_NOW
   * decision. Default (unset / tests) → the pure #301 date-anchor rule, byte-identical.
   */
  readonly renderCarriersActive?: boolean;
}

export function createIbatexasClaimsRenderer(
  opts?: IbatexasClaimsRendererOptions,
): ClaimsRendererPort {
  const renderCarriersActive = opts?.renderCarriersActive === true;
  return {
    render(
      claims: ClaimsKernelResult,
      context?: ClaimsRenderContext,
    ): ClaimsRenderResult {
      // §O#15 required-completeness gate over THIS request's span-classes. BKL-073:
      // the #8 ownership signal (provable-empty sentinels on `activeResources`) drops
      // an ownership-gated companion the customer PROVABLY cannot have; undefined
      // (seam unwired) keeps the pre-#8 over-including behavior byte-identical.
      // BKL-152-edge: the dateAnchor signal (seam-active + the 0.8.0 clock-resolved
      // resolvedQueryDate) makes the date-anchor STORE_OPEN_NOW suppression exact on
      // weekday==today; seam-inactive falls back to the pure #301 rule.
      const required = decomposeRequiredClaims(
        classifyRequestSpans(context?.requestText ?? ""),
        ownershipFromActiveResources(context?.activeResources),
        {
          seamActive: renderCarriersActive,
          ...(context?.resolvedQueryDate === undefined
            ? {}
            : { resolvedQueryDate: context.resolvedQueryDate }),
        },
      );
      // §O#15 completeness reads a per-TYPE verdict map. When one turn resolves
      // MULTIPLE claims of the SAME type (e.g. a multi-order request that binds two
      // ORDER_FULFILLMENT_STAGE instances to distinct owned subjects), a later
      // VALIDATED instance must NOT MASK an earlier UNKNOWN/REFUSED one — a plain
      // last-entry-wins Map would report the type satisfied while the weaker
      // instance is silently dropped from `renderableCanonical` (the "render the
      // easy half" collapse the gate exists to prevent). The gate only distinguishes
      // VALIDATED from not-VALIDATED, so we keep the FIRST non-VALIDATED verdict seen
      // for a type and never let a later VALIDATED overwrite it: a type ends up
      // VALIDATED here IFF EVERY instance of it validated (no verdict-rank table needed).
      const resolved = new Map<string, ClaimVerdict>();
      for (const c of claims.perClaim) {
        const prior = resolved.get(c.type);
        if (prior === undefined || (prior === "VALIDATED" && c.verdict !== "VALIDATED")) {
          resolved.set(c.type, c.verdict);
        }
      }
      const degrade =
        claims.terminal === "RENDER" &&
        !checkRequiredClaimCompleteness(required, resolved).complete;

      // BKL-111 — one structured `claims.terminal` signal per RENDER-path turn
      // (observe-only; see {@link emitClaimsTerminal}). Emitted BEFORE the pure
      // `render` call so the log reflects the same terminal the render uses; it
      // reads only structural identity and never the rendered text. BKL-117 — thread
      // the turnId (0.8.0 ClaimsRenderContext) so the terminal joins to turn_trace.
      emitClaimsTerminal(claims, degrade, context?.turnId);

      const result = render(
        // inv.17 — the renderer's REQUIRED input is the kernel-MINTED CanonicalClaim
        // set (`renderableCanonical`, 1:1 with `renderable`), NOT the raw renderable
        // claims. The renderer cannot author prose from a raw claim + model value;
        // only the kernel mints canonical claims, on the VALIDATED ∧ P2-consistent set.
        claims.renderableCanonical,
        // Demote-only: a missing required companion forces a proposition-free
        // UNKNOWN; otherwise the kernel's own terminal stands.
        degrade ? "UNKNOWN" : claims.terminal,
        claims.consistency.suppressions,
        // BKL-170 — pass the 0.8.0 owner-scoped disambiguation candidates so a CLARIFY
        // renders the proposition-free CLARIFY-with-candidates ask that voices the
        // specific handles. Absent → the generic clarify (byte-identical). Only ever
        // voiced on a CLARIFY terminal; ignored on every other terminal.
        context?.disambiguationCandidates ?? [],
      );
      return { text: result.text };
    },
  };
}

/**
 * BKL-155/153 — emit the ONE structured `claims.render_precedence` signal per turn
 * the 0.7.0 precedence seam is consulted (i.e. a claims result exists AND
 * `claimsRenderer` is wired — the exact `handleTurn` 6a gate that also emits the
 * companion `claims.terminal`). The two lines fire adjacently for the SAME turn, so
 * `kernelTerminal` is the practical JOIN KEY across them (the published seam ctx
 * carries no turnId — same limitation `claims.terminal` documents; closing it needs
 * a claustrum change to thread turnId into the seam context).
 *
 * OBSERVE-ONLY + PII-FREE (same contract as {@link emitClaimsTerminal}): it reads
 * only the turn's STRUCTURAL identity — the seam decision, the deciding rule
 * (`mechanism`), the Decision kind, the kernel terminal, the suppression/envelope
 * counts — NEVER the request text, a claim value, or the rendered text. It changes
 * no control flow; the caller acts on the returned `decision`.
 */
function emitRenderPrecedence(
  ctx: RenderPrecedenceContext,
  verdict: ReturnType<typeof decideRenderPrecedence>,
): void {
  logger.info(
    {
      component: "claims",
      event: "claims.render_precedence",
      // The seam outcome + WHICH lattice rule produced it (rules 1-4).
      decision: verdict.decision,
      mechanism: verdict.mechanism,
      // Join/diagnosis fields — the inputs the lattice branched on.
      decisionKind: ctx.decision.kind,
      kernelTerminal: ctx.claims.terminal,
      suppressionCount: ctx.claims.consistency.suppressions.length,
      envelopeCount: ctx.plan.envelopes.length,
    },
    "claims render precedence decided (render vs draft)",
  );
}

/**
 * Build the ibatexas `ClaimsRenderPrecedence` seam (@claustrum/core 0.7.0). PAIRED
 * with {@link createIbatexasClaimsRenderer}: `buildClaimsSeams` wires the two
 * together so the RENDER-vs-DRAFT decision is only ever consulted on the claims-ON
 * customer plane where the renderer also runs. handleTurn calls this AFTER invoking
 * the render (so `claims.terminal` telemetry + observability side-effects already
 * fired); the seam gates ONLY whether that render OVERWRITES the responder draft.
 *
 * Thin bridge: it evaluates the PURE {@link decideRenderPrecedence} lattice, emits
 * the observe-only `claims.render_precedence` telemetry, and returns the seam
 * `"render" | "keep_draft"`. All policy lives in the pure lattice; this adds only
 * the side-channel log. Absent seam (flag OFF) → core defaults to "render" →
 * byte-identical to 0.6.0's unconditional supersession.
 */
export function createIbatexasClaimsRenderPrecedence(): ClaimsRenderPrecedence {
  return (ctx) => {
    const verdict = decideRenderPrecedence(ctx);
    emitRenderPrecedence(ctx, verdict);
    return verdict.decision;
  };
}
