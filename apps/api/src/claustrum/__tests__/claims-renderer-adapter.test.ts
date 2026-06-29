/**
 * claims-renderer-adapter tests (Plan 1 Phase 3 / E-2; SDD §B / §Q.7).
 *
 * The adapter is the ibatexas bridge from the pure `renderer-from-claims` to the
 * claustrum `ClaimsRendererPort` seam. These tests pin that the bridge:
 *   - projects a `ClaimsKernelResult` onto `render(renderable, terminal,
 *     suppressions)` and returns its text as a `ClaimsRenderResult` (NON-VACUOUS:
 *     the rendered text IS a render of the VALIDATED claim's bound field — C6);
 *   - emits ONLY the proposition-free safe template on a non-RENDER terminal;
 *   - returns EMPTY text on a degenerate empty RENDER set (the claustrum loop then
 *     emits a proposition-free SAFE TERMINAL, never the model draft — F6);
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

// ── F2: the §O#15 required-completeness gate in the live render path ───────────
describe("claims-renderer-adapter — F2 required-claim completeness gate (§O#15)", () => {
  const STORE_OPEN_NOW = "STORE_OPEN_NOW";

  /** A kernel result with explicit per-claim verdicts (so the gate can quantify). */
  const resultWith = (
    perClaim: ReadonlyArray<{ type: string; verdict: ConsistencyClaim["verdict"] }>,
    renderable: readonly ConsistencyClaim[],
  ): ClaimsKernelResult => ({
    perClaim: perClaim.map((p) => ({ subject: "s", type: p.type, verdict: p.verdict })),
    renderable,
    terminal: "RENDER",
    consistency: { renderable, terminal: "RENDER", suppressions: [] },
  });

  it("a PICKUP_Q with a MISSING required companion DEGRADES to a proposition-free UNKNOWN — not a partial render", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The planner answered the easy half (STORE_OPEN_NOW VALIDATED) but the
    // required companion ORDER_FULFILLMENT_STAGE resolved UNKNOWN. A pickup
    // question requires BOTH (REQUIRED_CLAIM_CLOSURE.PICKUP_Q) → the turn degrades.
    const out = renderer.render(
      resultWith(
        [
          { type: STORE_OPEN_NOW, verdict: "VALIDATED" },
          { type: ORDER_FULFILLMENT_STAGE, verdict: "UNKNOWN" },
        ],
        [claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "jantar" })],
      ),
      { requestText: "posso retirar meu pedido agora?" },
    );
    // The proposition-free UNKNOWN safe template — NOT the store-open assertion.
    expect(out.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    expect(out.text).not.toContain("funcionamento");
    expect(out.text).not.toContain("jantar");
  });

  it("a PICKUP_Q with an ABSENT required companion (never proposed) ALSO degrades", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The companion type produced NO claim at all (the §O#15 ABSENT hole).
    const out = renderer.render(
      resultWith(
        [{ type: STORE_OPEN_NOW, verdict: "VALIDATED" }],
        [claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "jantar" })],
      ),
      { requestText: "posso buscar agora?" },
    );
    expect(out.text).not.toContain("funcionamento");
    expect(out.text).not.toContain("jantar");
  });

  it("NON-VACUITY: a STORE_OPEN_NOW-only question with its sole required claim VALIDATED RENDERS in full", () => {
    const renderer = createIbatexasClaimsRenderer();
    const out = renderer.render(
      resultWith(
        [{ type: STORE_OPEN_NOW, verdict: "VALIDATED" }],
        [claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "jantar" })],
      ),
      { requestText: "vocês estão abertos agora?" },
    );
    // STORE_OPEN_NOW_Q requires only STORE_OPEN_NOW → complete → full render.
    expect(out.text).toBe("No momento, o período de funcionamento é: jantar.");
  });
});
