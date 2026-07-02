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
      );
      return { text: result.text };
    },
  };
}
