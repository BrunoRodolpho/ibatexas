// safe-unknown-gate.ts — the ONE construction of the BKL-078 question-shape
// SAFE-UNKNOWN gate, shared by BOTH conversational planes (LE2 decision 6).
//
// The gate was born inline in the customer composition root (claustrum-bootstrap.ts)
// because only the customer conductor wired it: D5 pinned "ops NEVER wires
// safeUnknown". LE2 Implementation Decision 6 DISSOLVES D5 — the ops conductor now
// gains the full claims pipeline, and its factual paths degrade through the SAME
// gate. So the construction moves here and BOTH planes compose it; it is NOT forked
// per plane (the shape, the discriminator, and the proposition-free template are one
// object, so a customer/ops divergence is structurally impossible).
//
// What it is: the `IbatexasResponderDeps.safeUnknown` pair.
//   - `gate(text)`   — the pure discriminator. On the CUSTOMER plane: TRUE iff the
//                      message is a NON-smalltalk info-question. On the OPS plane
//                      (LE2-013, `retireRawProse`): TRUE iff the message is not
//                      smalltalk AT ALL — the raw-prose retirement. EITHER WAY
//                      smalltalk WINS (never degrades — the BKL-110 0/15 bar), so
//                      small talk on either plane keeps its natural conversational
//                      reply.
//   - `render(schedule, userText)` — the deterministic, proposition-free pt-BR
//                      SAFE_UNKNOWN reply (SAFE_TEMPLATES.unknown, the canonical
//                      literal — never re-typed here), optionally followed by the
//                      relevance-gated closed-hours disclosure.
//
// PURE construction: no clock / RNG / IO / model. The only per-plane knob is
// {@link SafeUnknownGateOptions.closedHoursOffer} (see its doc).

import { asksAboutStoreState, closedHoursDisclosure } from "./closed-hours.js";
import type { ScheduleSignal } from "./closed-hours.js";
import {
  shouldDegradeToSafeUnknown,
  shouldRetireRawProse,
} from "./interrogative-discriminator.js";
import { renderPropositionFreeText, SAFE_TEMPLATES } from "./slot-grammar.js";

/** The `IbatexasResponderDeps.safeUnknown` shape this factory builds. */
export interface SafeUnknownGate {
  gate(text: string): boolean;
  render(schedule: ScheduleSignal | undefined, userText: string): string;
}

export interface SafeUnknownGateOptions {
  /**
   * Append the closed-hours disclosure to a degraded ordering/hours question while
   * the store is CLOSED (D3, relevance-gated).
   *
   * `true` (the DEFAULT) is the customer plane, byte-identical to the pre-LE2 inline
   * construction: a customer whose question degraded still learns the store is shut
   * and is offered scheduled pickup.
   *
   * `false` is the OPS plane. `closedHoursDisclosure` is CUSTOMER copy — it offers
   * to register a pickup order ("Posso registrar seu pedido para retirada agendada"),
   * which is a non-sequitur voiced at the staff member who RUNS the store. Hard Rule
   * #4 keeps both planes pt-BR; the staff plane simply ships the bare epistemic
   * self-report, which asserts nothing either way and is the honest degrade the ops
   * convergence is for.
   */
  readonly closedHoursOffer?: boolean;

  /**
   * LE2-013 — RETIRE RAW PROSE on this plane: the gate becomes
   * {@link shouldRetireRawProse} (`!isSmalltalkOnly`) instead of
   * {@link shouldDegradeToSafeUnknown} (`!isSmalltalkOnly ∧ hasInfoQuestion`).
   *
   * `false` (the DEFAULT) is the CUSTOMER plane, byte-identical to LE2-011: the
   * positive info-question net decides, and a turn it does not recognise keeps the
   * conversational prose path.
   *
   * `true` is the OPS plane. The positive net's MISSES were the residual hole ticket
   * 13 closes: an information-bearing staff turn that matches no question marker
   * shipped model prose, and the ops digit clamp beneath it only demotes ungrounded
   * NUMBERS — so a digit-free invention ("o fornecedor confirmou a entrega de
   * amanhã") delivered clean. With the flag on, the empty-plan factual path
   * TERMINATES at the safe-unknown render and raw prose survives ONLY for small talk
   * (spec Implementation Decision 6). Still demote-only, still smalltalk-wins.
   *
   * ── The standing CLAUDE.SDD.md §R conflict, NARROWED ─────────────────────────
   * §R makes it a hard compile error for "any pathway where a plain string reaches a
   * (mock) user WITHOUT passing the three-valued Claims gate and the
   * renderer-from-claims". Decision 6 deliberately KEEPS raw prose for small talk, so
   * the two disagree. This option does not resolve that — it NARROWS it: before
   * LE2-013 the ungoverned surface on ops was "every empty-plan turn the positive
   * question net failed to recognise"; after it, the surface is exactly
   * `isSmalltalkOnly`, a CLOSED, enumerated phatic lexicon that asserts nothing about
   * the world by construction. The remaining reconciliation (does small talk itself
   * become a claims terminal?) is the OWNER's call and is deliberately NOT taken
   * here. See `interrogative-discriminator.ts` and the responder's REFUSE/empty-plan
   * branch, where the surviving branch carries the same note.
   */
  readonly retireRawProse?: boolean;
}

/**
 * Ordering / hours / availability relevance for the D3 disclosure gate: on a
 * topically-unrelated question the scheduled-pickup offer is unsolicited noise, so
 * the bare epistemic SAFE_UNKNOWN ships alone. Pure; carried VERBATIM from the
 * pre-LE2 inline customer construction.
 */
const ORDERING_OR_HOURS =
  /\b(pedid|pedir|encomend|entreg|retirad|agend|compr|reserv|cardapio|card[aá]pio|menu)/i;

/**
 * Build the question-shape SAFE-UNKNOWN gate. Wired ONLY when
 * `ENABLE_CLAIMS_PIPELINE` is on (both planes read the same flag — see
 * `claims-pipeline.ts` `claimsPipelineEnabled`); flag-OFF composition omits the dep
 * entirely and the responder's conversational branch is byte-identical.
 */
export function createSafeUnknownGate(
  options: SafeUnknownGateOptions = {},
): SafeUnknownGate {
  const closedHoursOffer = options.closedHoursOffer !== false;
  // LE2-013 — the plane's discriminator. OPT-IN (`=== true`), so every existing
  // composition and every future one that forgets the knob keeps the LE2-011
  // question-shape gate byte-for-byte.
  const gate =
    options.retireRawProse === true ? shouldRetireRawProse : shouldDegradeToSafeUnknown;
  return {
    gate: (text: string) => gate(text),
    render: (schedule: ScheduleSignal | undefined, userText: string): string => {
      const base = renderPropositionFreeText(SAFE_TEMPLATES.unknown);
      if (!closedHoursOffer) return base;
      const orderingOrHours =
        asksAboutStoreState(userText) || ORDERING_OR_HOURS.test(userText);
      return schedule?.isClosed && orderingOrHours
        ? `${base} ${closedHoursDisclosure(schedule)}`
        : base;
    },
  };
}
