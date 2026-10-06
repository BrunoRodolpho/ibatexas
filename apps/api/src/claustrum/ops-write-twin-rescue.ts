// ops-write-twin-rescue.ts — BKL-262 STAGE 1 (owner ruling 2026-07-27, option (b)):
// the WRITE-TWIN READ RESCUE for the OPS render-vs-draft precedence lattice.
//
// ── THE DEFECT (two live proofs on the BKL-262 row) ──────────────────────────
// A staff QUESTION that the 4B mis-parses into a MUTATION is kernel-REFUSEd, and the
// refusal then HIJACKS the reply:
//
//   · LE2-013 (2026-07-26, turn 3eee7d6c-2e5e): "entregam em Ibaté?" mis-parsed to
//     `order.note.add` (the question text stuffed into `orderId`) → kernel REFUSE
//     state/order.not_found → the operator was told "Não, a loja está fechada…" on a
//     coverage question whose ground truth was **Sim**.
//   · BKL-234 (production-code-verified, the REAL createOpsResolver): "Qual horário de
//     funcionamento?" mis-parsed to `schedule.override.set` → kernel REFUSE → the
//     fabricated "Funcionamos todos os dias das 10h às 22h!" shipped verbatim on all
//     three hours phrasings **even while the correct hours claim VALIDATED in the same
//     turn**.
//
// MECHANISM, exactly: lattice rule 2 (`live_action_decision` — a REFUSE carrying ≥1
// envelope) is checked ABOVE rule 3 (`validated_render`), so the kept DRAFT wins over
// the validated claims render. `renderOpsActionAnswer` returns `undefined` for a
// refused dispatch (nothing committed), so that kept draft is not a deterministic
// action reply at all — it is the `conversationalRefusal` recovery synthesis, i.e. RAW
// MODEL PROSE, gated only by a false-SUCCESS lexicon that a fabricated statement of
// FACT passes clean. The turn therefore converts a parser misparse directly into a
// confident fabricated answer.
//
// ── THE FIX (Stage 1 only) ───────────────────────────────────────────────────
// When the refused envelope is the declared WRITE TWIN of the READ that was actually
// asked, AND that read's claims VALIDATED and ANSWER the question, the validated
// render outranks the kept draft. This is a RANKING fix and nothing else. Stage 2
// (grounded recovery synthesis, option (c)) is a SEPARATE PR and is NOT attempted
// here — the false-SUCCESS lexicon gate stays exactly as it is.
//
// ── WHY THIS CANNOT MASK A REAL REFUSAL ──────────────────────────────────────
// Five conjuncts, each independently able to decline the rescue, and the DEFAULT on
// every one is "rule 2 stands" (see {@link isOpsWriteTwinReadRescue}). The one that
// carries the counter-case is #4: a turn carrying an imperative/mutation shape is
// never rescued, so a staff member who genuinely tried to change the hours and got
// refused still SEES the refusal.
//
// PURE: no clock, no RNG, no IO, no model, no logging (mirrors
// claims-render-precedence.ts, which consumes it). The input is STRUCTURAL rather
// than the seam's `RenderPrecedenceContext` so this module and the lattice do not
// import each other.

import type { ClaimVerdict } from "@adjudicate/core";
import {
  checkRequiredClaimCompleteness,
  classifyRequestSpans,
  decomposeRequiredClaims,
  hasMutationImperative,
  type SpanClass,
} from "./required-claim-decomposer.js";

/**
 * THE WRITE-TWIN TABLE — the CLOSED, DECLARED mapping from an ops MUTATION kind to the
 * READ span families a staff question about that subject legitimately classifies into.
 *
 * DECLARED, not heuristic, and deliberately SMALL: it lists exactly the two misparse
 * classes BKL-262 measured in production. Every other ops kind is absent, and absence
 * means NO RESCUE — a refused `payment.refund.issue`, `order.status.transition`,
 * `product.price.set`, `menu.special.set`, `ops.alert.resolve.staff`, … always keeps
 * rule 2 and surfaces its refusal. Adding a row is a reviewable decision that has to
 * argue the twin relation, which is the property the owner asked for over a
 * "does the kind look read-ish" heuristic.
 *
 * Read each row as: "a staff question in THESE read families is the thing this write
 * kind plausibly mis-parses FROM".
 *
 *   · `schedule.override.set` ← the SCHEDULE/HOURS read family. The BKL-233/234 case:
 *     the ops roster's only schedule-shaped capability is this WRITE, so "Qual horário
 *     de funcionamento?" pattern-matches onto it and the 4B fabricates a payload.
 *     Both hours spans are listed: `STORE_OPEN_NOW_Q` (the undated "que horas abre?"
 *     phrasings — the generated markers) and `STORE_HOURS_FOR_DATE_Q` (the
 *     date-anchored "qual o horário de domingo?"), because the override write is
 *     per-date and the misparse happens from both.
 *   · `order.note.add` ← the COVERAGE / ORDER-STATUS read families. The LE2-013 case:
 *     a free-text question gets stuffed into the note's `orderId`/body, so any staff
 *     question the planner cannot place lands here. `DELIVERY_COVERAGE_Q` is the
 *     measured one ("entregam em Ibaté?"); `ORDER_STATUS_Q` is its sibling per the
 *     row's "the coverage/status reads" formulation — an order-note write is the
 *     write twin of an order-status read by construction (same subject, same
 *     resource).
 *
 * `satisfies` pins every value to the closed {@link SpanClass} union, so a renamed or
 * deleted span class is a COMPILE error here rather than a silently dead row.
 */
export const OPS_WRITE_TWIN_READ_FAMILIES = {
  "schedule.override.set": ["STORE_OPEN_NOW_Q", "STORE_HOURS_FOR_DATE_Q"],
  "order.note.add": ["DELIVERY_COVERAGE_Q", "ORDER_STATUS_Q"],
} as const satisfies Readonly<Record<string, readonly SpanClass[]>>;

/** The structural facts the rescue predicate needs from a turn. */
export interface OpsWriteTwinRescueInput {
  /** The turn Decision's kind (`REFUSE`, `EXECUTE`, `REQUEST_CONFIRMATION`, …). */
  readonly decisionKind: string;
  /** The intent kinds of the envelopes the plan carried into adjudication. */
  readonly envelopeKinds: readonly string[];
  /** The claims kernel terminal for this turn. */
  readonly claimsTerminal: string;
  /** This turn's per-claim registry types + §5 verdicts, as the kernel produced them. */
  readonly perClaim: ReadonlyArray<{ readonly type: string; readonly verdict: ClaimVerdict }>;
  /** The raw inbound staff utterance. */
  readonly requestText: string;
}

/**
 * Fold this turn's per-claim verdicts into a per-TYPE verdict map for the §O#15
 * completeness check.
 *
 * The fold rule is the STRICT one: a type counts as VALIDATED here IFF **every**
 * instance of it validated. A later VALIDATED instance must never overwrite an earlier
 * UNKNOWN/REFUSED one, because that would report a type satisfied while a weaker
 * instance was silently dropped — the "render the easy half" collapse §O#15 exists to
 * prevent. `claims-renderer-adapter.ts` folds by the same rule for the same reason.
 *
 * STRICTNESS, not byte-identity with the adapter, is what is load-bearing here: this
 * fold only ever makes the rescue HARDER to earn (see the completeness note in
 * {@link isOpsWriteTwinReadRescue}).
 */
function resolveVerdictsByType(
  perClaim: OpsWriteTwinRescueInput["perClaim"],
): Map<string, ClaimVerdict> {
  const resolved = new Map<string, ClaimVerdict>();
  for (const c of perClaim) {
    const prior = resolved.get(c.type);
    if (prior === undefined || (prior === "VALIDATED" && c.verdict !== "VALIDATED")) {
      resolved.set(c.type, c.verdict);
    }
  }
  return resolved;
}

/**
 * TRUE iff this turn earns the BKL-262 Stage-1 rescue: the kernel refused a WRITE that
 * is the declared twin of the READ the operator actually asked, and the claims pipeline
 * already holds a VALIDATED answer to that read.
 *
 * FIVE CONJUNCTS — all must hold; every default is "no rescue, rule 2 stands":
 *
 *  1. REFUSE-with-envelopes ONLY. `REQUEST_CONFIRMATION` and `ESCALATE` — the other two
 *     legs of rule 2 — are NOT touched, so park/confirm semantics for legitimate action
 *     turns are unchanged (a confirm prompt still wins; that was BKL-155's fix and it
 *     stays). A REFUSE with an EMPTY plan never reached rule 2 in the first place.
 *  2. The claims terminal is a VALIDATED `RENDER`. A degraded/UNKNOWN/CLARIFY claims
 *     turn earns nothing — there is no validated fact to promote, and the refusal is
 *     then genuinely the most informative thing the turn has.
 *  3. The turn is QUESTION-shaped: `classifyRequestSpans` (the ops claims pipeline's
 *     OWN decomposer, not a new classifier) found at least one READ span.
 *  4. THE COUNTER-CASE GUARD — the turn carries NO imperative/mutation verb, per the
 *     SAME {@link hasMutationImperative} net `classifyRequestSpans` gates its own spans
 *     on. This is what keeps a REAL refused mutation visible: "muda o horário de amanhã
 *     para 10h às 22h" is a genuine attempt to change the hours, and it must surface its
 *     refusal — not be answered with today's hours as though nothing was asked for.
 *     Note this guard is REQUIRED rather than implied by #3: the schedule markers fire
 *     on the word "horário" regardless of the verb, so that mutation DOES carry a read
 *     span. Shape beats span here, deliberately.
 *  5. Every refused envelope kind is a declared twin (see
 *     {@link OPS_WRITE_TWIN_READ_FAMILIES}) of a span that ACTUALLY FIRED this turn,
 *     AND the validated claims ANSWER that read (§O#15 required-claim completeness over
 *     the fired spans — not merely "some claim validated"). EVERY envelope must
 *     qualify: a turn that also proposed an unrelated mutation keeps rule 2.
 *
 * ON THE COMPLETENESS CHECK being deliberately UNFILTERED: `decomposeRequiredClaims` is
 * called with NO ownership signal and NO date-anchor signal, and without the ops plane's
 * `customerScopedCompanionsApply: false` filter. Every one of those inputs can only ever
 * REMOVE a required companion, so the set computed here is a SUPERSET of the set the
 * renderer adapter gated the actual render on. Completeness over a superset is strictly
 * harder to satisfy, so if this passes, the adapter's own §O#15 gate provably passed too
 * — i.e. the render being promoted is a real answer and not a degraded abstain. Being
 * stricter is also why no cross-module coupling to the adapter is needed.
 *
 * Pure.
 */
export function isOpsWriteTwinReadRescue(input: OpsWriteTwinRescueInput): boolean {
  // 1 — the REFUSE leg of rule 2, and only it.
  if (input.decisionKind !== "REFUSE") return false;
  if (input.envelopeKinds.length === 0) return false;

  // 2 — there must be a VALIDATED render to promote.
  if (input.claimsTerminal !== "RENDER") return false;

  // 4 — the counter-case guard, checked before the span work: a mutation-shaped turn is
  // never rescued, whatever its incidental read spans.
  if (hasMutationImperative(input.requestText)) return false;

  // 3 — QUESTION-shaped: the decomposer's own read spans for this turn.
  const spans = classifyRequestSpans(input.requestText);
  if (spans.length === 0) return false;
  const firedSpans = new Set<string>(spans);

  // 5a — every refused envelope must be a declared twin of a span that fired.
  const twinOf = (kind: string): readonly SpanClass[] | undefined =>
    Object.prototype.hasOwnProperty.call(OPS_WRITE_TWIN_READ_FAMILIES, kind)
      ? OPS_WRITE_TWIN_READ_FAMILIES[kind as keyof typeof OPS_WRITE_TWIN_READ_FAMILIES]
      : undefined;
  const everyEnvelopeIsATwin = input.envelopeKinds.every((kind) => {
    const families = twinOf(kind);
    return families !== undefined && families.some((f) => firedSpans.has(f));
  });
  if (!everyEnvelopeIsATwin) return false;

  // 5b — the validated claims must ANSWER the asked read.
  const required = decomposeRequiredClaims(spans);
  return checkRequiredClaimCompleteness(required, resolveVerdictsByType(input.perClaim))
    .complete;
}
