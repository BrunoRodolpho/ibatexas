/**
 * claims-renderer-adapter tests (Plan 1 Phase 3 / E-2; SDD §B / §Q.7).
 *
 * The adapter is the ibatexas bridge from the pure `renderer-from-claims` to the
 * claustrum `ClaimsRendererPort` seam. These tests pin that the bridge:
 *   - projects a `ClaimsKernelResult` onto `render(renderable, terminal,
 *     suppressions)` and returns its text as a `ClaimsRenderResult` (NON-VACUOUS:
 *     the rendered text IS a render of the VALIDATED claim's bound field — C6);
 *   - emits ONLY the proposition-free safe template on a non-RENDER terminal;
 *   - returns EMPTY text on an empty renderable set (so the claustrum loop falls
 *     back to the operational draft — the E-2 no-renderable-claim fallback);
 *   - is PURE/deterministic (same input ⟹ byte-identical text).
 *
 * Against the LINKED `@adjudicate/core` claims types — not a stub. No model, no DB.
 */
import { describe, expect, it } from "vitest";
import type {
  ClaimsKernelResult,
  ConsistencyClaim,
  TurnTerminal,
} from "@adjudicate/core";
import { ORDER_FULFILLMENT_STAGE } from "../slot-grammar.js";
import { createIbatexasClaimsRenderer } from "../claims-renderer-adapter.js";

const claim = (
  type: string,
  verdict: ConsistencyClaim["verdict"],
  value: unknown,
  subject = "order-1",
): ConsistencyClaim => ({ subject, type, verdict, value });

/** Build a minimal `ClaimsKernelResult` from a renderable set + terminal. */
const kernelResult = (
  renderable: readonly ConsistencyClaim[],
  terminal: TurnTerminal,
): ClaimsKernelResult => ({
  perClaim: [],
  renderable,
  terminal,
  consistency: { renderable, terminal, suppressions: [] },
});

describe("claims-renderer-adapter — E-2 bridge to ClaimsRendererPort", () => {
  it("renders a VALIDATED claim's LEDGER-bound field value (C6) into its template", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The kernel's C6 guaranteed `value.stage` equals the licensing ledger entry;
    // the adapter renders exactly that bound field — no model-authored surplus.
    const out = renderer.render(
      kernelResult([claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { stage: "em preparo" })], "RENDER"),
    );
    expect(out.text).toBe("Seu pedido está na etapa: em preparo.");
  });

  it("emits ONLY the proposition-free safe template on a non-RENDER terminal", () => {
    const renderer = createIbatexasClaimsRenderer();
    const out = renderer.render(kernelResult([], "ESCALATE"));
    expect(out.text).not.toBe("");
    // No domain proposition leaks — it is the escalate posture, not an order fact.
    expect(out.text).not.toContain("etapa");
  });

  it("returns EMPTY text on an empty RENDER set (the no-renderable-claim fallback)", () => {
    const renderer = createIbatexasClaimsRenderer();
    const out = renderer.render(kernelResult([], "RENDER"));
    expect(out.text).toBe("");
  });

  it("is deterministic — same input ⟹ byte-identical text", () => {
    const renderer = createIbatexasClaimsRenderer();
    const input = kernelResult(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { stage: "saiu para entrega" })],
      "RENDER",
    );
    expect(renderer.render(input).text).toBe(renderer.render(input).text);
  });
});
