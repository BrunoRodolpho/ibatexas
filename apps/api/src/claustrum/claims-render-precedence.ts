// claims-render-precedence.ts — the ibatexas RENDER-vs-DRAFT precedence lattice
// (BKL-155 / BKL-153), adopting the @claustrum/core 0.7.0 `claimsRenderPrecedence`
// seam. Core holds NO policy: absent seam → "render" → byte-identical to 0.6.0's
// UNCONDITIONAL step-6a supersession. THIS module is where the adopter owns the
// policy of whether the claims render supersedes the responder draft.
//
// WHY (two live-proven customer-facing defects, both a claims safe-degrade render
// wrongly SUPERSEDING a good draft):
//   · BKL-155 — a mutating turn parks REQUEST_CONFIRMATION, but the claim-planner
//     ALSO over-proposes a spurious degrade-forcing claim → the safe-degrade render
//     hides the kernel's 'Identifiquei o item mais recente… Confirma?' prompt →
//     the confirm loop is silently un-completable. FIXED by rule 2.
//   · BKL-153 — 'meu pedido chegou, obrigado!' is a gratitude STATEMENT the keyword
//     net over-classifies as an order question → a guest-owns-no-order degrade →
//     the safe copy 'Não localizei essa informação…' supersedes the responder's
//     (correct, friendly) prose (a tone non-sequitur). FIXED by rule 4.
//
// PURE & self-contained (mirrors interrogative-discriminator.ts): no clock / RNG /
// IO, no model import, no logging. The telemetry-emitting factory that wraps this
// for the seam lives in claims-renderer-adapter.ts (createIbatexasClaimsRenderPrecedence),
// so this lattice stays unit-testable in isolation.
//
// The input type is DERIVED from the published `ClaimsRenderPrecedence` seam
// (`Parameters<…>[0]`) so it can NEVER drift from the contract handleTurn calls it
// with: `{ decision, plan, claims, requestText }`.

import type { ClaimsRenderPrecedence } from "@claustrum/core";
import { shouldDegradeToSafeUnknown } from "./interrogative-discriminator.js";

/** The seam's turn context — the exact shape @claustrum/core 0.7.0 passes in. */
export type RenderPrecedenceContext = Parameters<ClaimsRenderPrecedence>[0];

/** Which lattice rule decided this turn — the telemetry `mechanism` join field. */
export type RenderPrecedenceMechanism =
  | "claims_escalate_or_suppression" // rule 1 — safety-first / no-leak
  | "live_action_decision" // rule 2 — the deterministic kernel reply wins
  | "validated_render" // rule 3 — never withhold a validated fact
  | "safe_degrade" // rule 4 — a question degrades honestly
  | "conversational_prose"; // rule 4 — a statement's prose stands

/** The lattice verdict: the seam decision plus WHICH rule produced it. */
export interface RenderPrecedenceVerdict {
  readonly decision: "render" | "keep_draft";
  readonly mechanism: RenderPrecedenceMechanism;
}

/**
 * TRUE iff this turn's Decision is a LIVE ACTION decision whose deterministic,
 * proposition-safe kernel reply is the turn's deliverable and must WIN over any
 * claims render (rule 2): a confirm prompt (`REQUEST_CONFIRMATION`), a human-handoff
 * line (`ESCALATE`), or a verbatim refusal of a proposed mutation (`REFUSE` carrying
 * ≥1 envelope). A `REFUSE` with an EMPTY plan is not a refused mutation — it is a
 * conversational disposition and falls through to rules 3/4. Pure.
 */
function isLiveActionDecision(ctx: RenderPrecedenceContext): boolean {
  const { decision, plan } = ctx;
  return (
    decision.kind === "REQUEST_CONFIRMATION" ||
    decision.kind === "ESCALATE" ||
    (decision.kind === "REFUSE" && plan.envelopes.length >= 1)
  );
}

/**
 * The RATIFIED precedence lattice (termprecdesign 2026-07-10) — TOP WINS. Given the
 * seam context, decide whether the claims render supersedes the responder draft.
 * PURE: same inputs ⟹ same verdict (the only text input, `requestText`, is read by
 * the pure {@link shouldDegradeToSafeUnknown}).
 *
 *   1. claims ESCALATE OR any set-gate suppression → RENDER (safety-first; the safe
 *      template must win — a suppressed proposition must NEVER re-leak via a kept
 *      draft). HARD invariant; checked FIRST so nothing below can override no-leak.
 *   2. a LIVE ACTION decision (REQUEST_CONFIRMATION / ESCALATE / REFUSE-with-envelopes)
 *      → KEEP DRAFT — the deterministic kernel reply is the deliverable, winning even
 *      over a claims VALIDATED RENDER. Fixes BKL-155.
 *   3. a claims VALIDATED terminal (RENDER) → RENDER — claims-not-prose: never
 *      withhold an independently-validated fact.
 *   4. a claims degrade (UNKNOWN / CLARIFY, no suppression — rule 1 already took
 *      those) on a conversational turn → the request SHAPE decides: a question
 *      degrades honestly to the safe render (RENDER — preserves BKL-078); a
 *      statement / gratitude / action-imperative keeps its grounded prose (KEEP
 *      DRAFT — fixes BKL-153). Reuses the independence-pinned interrogative
 *      discriminator; a statement has no question to fabricate an answer to, so
 *      keeping prose is soundness-monotonic.
 *
 * By construction anything reaching rules 3/4 is a CONVERSATIONAL disposition:
 * rule 1 peeled off ESCALATE + suppression and rule 2 peeled off the live action
 * decisions, so the remaining terminals are RENDER (→ 3) or a no-suppression
 * UNKNOWN/CLARIFY degrade (→ 4).
 */
export function decideRenderPrecedence(
  ctx: RenderPrecedenceContext,
): RenderPrecedenceVerdict {
  const { claims, requestText } = ctx;

  // Rule 1 — safety-first / no-leak (HARD invariant; first so nothing overrides it).
  if (
    claims.terminal === "ESCALATE" ||
    claims.consistency.suppressions.length > 0
  ) {
    return { decision: "render", mechanism: "claims_escalate_or_suppression" };
  }

  // Rule 2 — the live action decision's deterministic kernel reply is the deliverable.
  if (isLiveActionDecision(ctx)) {
    return { decision: "keep_draft", mechanism: "live_action_decision" };
  }

  // Rule 3 — a validated terminal render: never withhold a validated fact.
  if (claims.terminal === "RENDER") {
    return { decision: "render", mechanism: "validated_render" };
  }

  // Rule 4 — a conversational degrade: the request SHAPE decides render-safe vs prose.
  return shouldDegradeToSafeUnknown(requestText)
    ? { decision: "render", mechanism: "safe_degrade" }
    : { decision: "keep_draft", mechanism: "conversational_prose" };
}
