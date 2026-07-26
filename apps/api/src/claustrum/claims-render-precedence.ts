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
//     hides the kernel's 'Identifiquei o seu pedido mais recente… Confirma?' prompt →
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
  | "committed_mutation_action" // rule 3b — a committed mutation's action reply wins over a degenerate render
  | "deterministic_read_render" // rule 3c — a deterministic READ render wins over a degenerate render
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
 * PLANE SIGNALS the lattice cannot derive from the published seam context. Optional
 * and absent by default — an omitted signal set leaves every verdict BYTE-IDENTICAL
 * to the pre-LE2 lattice (the customer plane passes nothing).
 */
export interface RenderPrecedenceSignals {
  /**
   * TRUE iff the responder's draft for THIS turn is a DETERMINISTIC read render
   * rather than model prose — the BKL-100 ops read-answer governor
   * (`readAnswer.render`), which answers a staff read from the ACTUAL captured read
   * result with no model call.
   *
   * LE2 decision 6 (ops convergence) needs it: once the ops conductor wires
   * `claimsRenderer`, an ops read turn whose claims happen to DEGRADE would have its
   * grounded, first-party read answer clobbered by the proposition-free UNKNOWN
   * copy — a strict LOSS of true information. This signal is the READ analog of
   * rule 3b (`committed_mutation_action`), and like it, it only ever protects a
   * draft from a DEGENERATE render: rule 1 (no-leak) and rule 3 (validated render)
   * are both checked first, so a genuinely VALIDATED claim still supersedes.
   */
  readonly deterministicReadRender?: boolean;
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
  signals: RenderPrecedenceSignals = {},
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

  // Rule 3 — a validated terminal render: never withhold a validated fact. Checked
  // BEFORE rule 3b so a genuinely-validated read on a mixed read+act turn still wins.
  if (claims.terminal === "RENDER") {
    return { decision: "render", mechanism: "validated_render" };
  }

  // Rule 3b (BKL-225) — a COMMITTED MUTATION's deterministic action reply is the
  // deliverable and must WIN over a DEGENERATE (non-RENDER) claims render. An
  // EXECUTE / REWRITE carrying ≥1 envelope committed a mutation this turn; the
  // responder's deterministic action render (customer-action-render.ts / BKL-215,
  // ops-action-render.ts / BKL-149 — never a model author) states WHAT THE VERB DID
  // and must not be clobbered by the UNKNOWN/CLARIFY render the mutation turn's own
  // (read-less) claims degrade to. The lattice predated those deterministic action
  // renders, so EXECUTE/REWRITE fell through rule 2 to here — the exact gap that
  // let a resumed amend EXECUTE ("sim" → the parked add executes) deliver a
  // degenerate render instead of "Pronto! Adicionei o item ao seu pedido." Rule 1
  // (suppression/ESCALATE) and rule 3 (validated read) are already peeled off above,
  // so this only ever fires on the safe degenerate-render case. Mirrors rule 2's
  // REFUSE-with-envelopes: a live mutation decision's deterministic reply is the
  // turn's deliverable.
  if (
    (ctx.decision.kind === "EXECUTE" || ctx.decision.kind === "REWRITE") &&
    ctx.plan.envelopes.length >= 1
  ) {
    return { decision: "keep_draft", mechanism: "committed_mutation_action" };
  }

  // Rule 3c (LE2 decision 6) — the READ analog of 3b: a DETERMINISTIC read render is
  // the turn's deliverable and must WIN over a DEGENERATE (non-RENDER) claims render.
  // The ops plane's BKL-100 read-answer governor answers a staff read from the ACTUAL
  // captured read (no model call, no authored number); replacing that grounded answer
  // with "Não localizei essa informação confirmada agora" because an UNRELATED claim
  // candidate failed would DESTROY true information — the mirror image of the
  // confabulation the pipeline exists to stop. Rule 1 (suppression/ESCALATE) and rule
  // 3 (validated read) are already peeled off above, so this only ever fires on the
  // safe degenerate-render case, and a genuinely VALIDATED claim still supersedes.
  // Absent signal (customer plane) → skipped → byte-identical.
  if (signals.deterministicReadRender === true) {
    return { decision: "keep_draft", mechanism: "deterministic_read_render" };
  }

  // Rule 4 — a conversational degrade: the request SHAPE decides render-safe vs prose.
  return shouldDegradeToSafeUnknown(requestText)
    ? { decision: "render", mechanism: "safe_degrade" }
    : { decision: "keep_draft", mechanism: "conversational_prose" };
}
