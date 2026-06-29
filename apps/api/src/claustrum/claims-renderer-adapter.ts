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
  ClaimsRenderContext,
  ClaimsRendererPort,
  ClaimsRenderResult,
} from "@claustrum/core";
import {
  checkRequiredClaimCompleteness,
  classifyRequestSpans,
  decomposeRequiredClaims,
} from "./required-claim-decomposer.js";
import { render } from "./renderer-from-claims.js";

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
export function createIbatexasClaimsRenderer(): ClaimsRendererPort {
  return {
    render(
      claims: ClaimsKernelResult,
      context?: ClaimsRenderContext,
    ): ClaimsRenderResult {
      // §O#15 required-completeness gate over THIS request's span-classes.
      const required = decomposeRequiredClaims(
        classifyRequestSpans(context?.requestText ?? ""),
      );
      const resolved = new Map<string, ClaimVerdict>(
        claims.perClaim.map((c) => [c.type, c.verdict] as const),
      );
      const degrade =
        claims.terminal === "RENDER" &&
        checkRequiredClaimCompleteness(required, resolved).degrade;

      const result = render(
        claims.renderable,
        // Demote-only: a missing required companion forces a proposition-free
        // UNKNOWN; otherwise the kernel's own terminal stands.
        degrade ? "UNKNOWN" : claims.terminal,
        claims.consistency.suppressions,
      );
      return { text: result.text };
    },
  };
}
