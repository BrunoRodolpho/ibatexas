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
  CandidateClaim,
  CanonicalClaim,
  ClaimsKernelResult,
  ConsistencyClaim,
  TurnTerminal,
} from "@adjudicate/core";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import { ORDER_FULFILLMENT_STAGE } from "../slot-grammar.js";
import {
  REGISTRY_SPECS,
  type RegistryClaimSpec,
  type RegistryClaimType,
} from "../claim-registry.js";
import {
  createIbatexasClaimsKernelDeps,
  PROVABLY_EMPTY_KIND,
} from "../ibatexas-claims-kernel-deps.js";
import {
  createIbatexasClaimsRenderer,
  ownershipFromActiveResources,
} from "../claims-renderer-adapter.js";

const claim = (
  type: string,
  verdict: ConsistencyClaim["verdict"],
  value: unknown,
  subject = "order-1",
): ConsistencyClaim => ({ subject, type, verdict, value });

/**
 * inv.17 — MINT the kernel-stamped CanonicalClaim set the adapter requires. The
 * adapter consumes `renderableCanonical` (NOT the raw renderable), so we drive the
 * REAL `runClaimsKernel` over a ledger that validates each VALIDATED renderable: it
 * records every requiredEvidence key with the claim's value (so C6 binds), with no
 * falsifier present, owns-all. Non-VALIDATED renderables never mint (the kernel drops
 * them), exactly as in production.
 */
const NOW = 10_000;
function mintRenderable(
  renderable: readonly ConsistencyClaim[],
): readonly CanonicalClaim[] {
  const validated = renderable.filter((c) => c.verdict === "VALIDATED");
  if (validated.length === 0) return [];
  const ledger = new EvidenceLedger("t");
  const candidates: CandidateClaim[] = validated.map((c) => {
    const spec: RegistryClaimSpec = REGISTRY_SPECS[c.type as RegistryClaimType];
    for (const e of spec.requiredEvidence) {
      ledger.record({
        key: e.key,
        value: c.value,
        source: "test",
        fetchedAt: NOW,
        sourceMode: "live",
        taint: "TRUSTED",
        originProvenance: "FIRST_PARTY",
      });
    }
    // Bind every required-key's resource to the subject so the C1 ownership check
    // (ownershipPolicy: "required") resolves to an OWNED resource (owns()=>true);
    // an absent binding for a required key is "no owner" → REFUSED.
    const resources = Object.fromEntries(
      spec.requiredEvidence.map((e) => [e.key, c.subject]),
    );
    return {
      soundness: {
        requiredEvidence: spec.requiredEvidence,
        minSourceIntegrity: spec.minSourceIntegrity,
        kind: spec.kind,
        actor: c.subject,
        resources,
        ...(spec.falsifierComplete === true
          ? { falsifierComplete: true, falsifiers: spec.falsifiers ?? [] }
          : {}),
        ...(spec.valueBinding === undefined ? {} : { valueBinding: spec.valueBinding }),
      },
      subject: c.subject,
      type: c.type,
      value: c.value,
    };
  });
  return runClaimsKernel(
    ledger,
    candidates,
    createIbatexasClaimsKernelDeps({ now: () => NOW, owns: () => true }),
  ).renderableCanonical;
}

/** Build a minimal `ClaimsKernelResult` from a renderable set + terminal. */
const kernelResult = (
  renderable: readonly ConsistencyClaim[],
  terminal: TurnTerminal,
): ClaimsKernelResult => ({
  perClaim: [],
  renderable,
  // inv.17 — the merged adapter renders from the kernel-MINTED CanonicalClaim set
  // (`renderableCanonical`), so we MINT it via the real kernel (`mintRenderable`);
  // an empty set would make the adapter render nothing and the non-empty-render
  // assertions below would be vacuous.
  renderableCanonical: mintRenderable(renderable),
  terminal,
  consistency: { renderable, terminal, suppressions: [] },
});

describe("claims-renderer-adapter — E-2 bridge to ClaimsRendererPort", () => {
  it("renders a VALIDATED claim's LEDGER-bound field value (C6) into its template", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The kernel's C6 guaranteed `value.fulfillmentStatus` equals the licensing
    // ledger entry (the raw enum); the adapter renders exactly that bound field
    // (F1), localized to pt-BR for display (F3) — no model-authored surplus.
    const out = renderer.render(
      kernelResult(
        [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" })],
        "RENDER",
      ),
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
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "out_for_delivery" })],
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
    // inv.17 — mint the CanonicalClaim set via the real kernel (see `kernelResult`
    // above); the merged adapter renders from `renderableCanonical`.
    renderableCanonical: mintRenderable(renderable),
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

  it("M12: two same-type instances — a VALIDATED ordered AFTER an UNKNOWN does NOT mask it (worst-verdict fold)", () => {
    const renderer = createIbatexasClaimsRenderer();
    // A multi-order request binds TWO ORDER_FULFILLMENT_STAGE instances: order-1
    // resolved UNKNOWN, order-2 VALIDATED (and ordered LAST). A last-entry-wins
    // per-type map would report ORDER_FULFILLMENT_STAGE satisfied (VALIDATED) and
    // render order-2's stage while silently dropping the UNKNOWN order-1 — the
    // "render the easy half" collapse. The fold to the WORST verdict makes the
    // §O#15 gate see UNKNOWN → the turn degrades to a proposition-free UNKNOWN.
    const out = renderer.render(
      resultWith(
        [
          { type: ORDER_FULFILLMENT_STAGE, verdict: "UNKNOWN" },
          { type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" },
        ],
        [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" }, "order-2")],
      ),
      { requestText: "cadê meu pedido?" },
    );
    expect(out.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    // The literal-true half (order-2 "em preparo") is NOT leaked.
    expect(out.text).not.toContain("etapa");
    expect(out.text).not.toContain("preparo");
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

// ── BKL-073: the provable-empty ownership DROP in the live render path ─────────
describe("claims-renderer-adapter — BKL-073 provable-empty ownership drop", () => {
  const STORE_OPEN_NOW = "STORE_OPEN_NOW";
  const UNKNOWN_TEMPLATE =
    "Não localizei essa informação confirmada agora. Quer que eu verifique?";

  /** A kernel result with explicit per-claim verdicts (so the gate can quantify). */
  const resultWith = (
    perClaim: ReadonlyArray<{ type: string; verdict: ConsistencyClaim["verdict"] }>,
    renderable: readonly ConsistencyClaim[],
  ): ClaimsKernelResult => ({
    perClaim: perClaim.map((p) => ({ subject: "s", type: p.type, verdict: p.verdict })),
    renderable,
    renderableCanonical: mintRenderable(renderable),
    terminal: "RENDER",
    consistency: { renderable, terminal: "RENDER", suppressions: [] },
  });

  it("NO-DROP-ON-FAILURE (§O#15 falsifier): activeResources WITHOUT a sentinel keeps the ORDER companion → honest UNKNOWN", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The customer HAS an active order but the enumeration ERRORED → the seam emits
    // NO provably-empty sentinel (activeResources carries none). A pickup question
    // requires BOTH STORE_OPEN_NOW + ORDER_FULFILLMENT_STAGE; the order companion
    // resolved UNKNOWN → the turn MUST degrade — never render the store-open "easy
    // half" while omitting the real order status. This is the drop-a-drop falsifier:
    // even WITH the seam wired, an absent/errored marker keeps the companion.
    const out = renderer.render(
      resultWith(
        [
          { type: STORE_OPEN_NOW, verdict: "VALIDATED" },
          { type: ORDER_FULFILLMENT_STAGE, verdict: "UNKNOWN" },
        ],
        [claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "jantar" })],
      ),
      { requestText: "posso retirar meu pedido agora?", activeResources: [] },
    );
    expect(out.text).toBe(UNKNOWN_TEMPLATE);
    expect(out.text).not.toContain("funcionamento");
    expect(out.text).not.toContain("jantar");
  });

  it("SOUND-DROP: the order PROVABLY_EMPTY sentinel drops the ORDER companion → the store-open easy half renders in full", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The customer PROVABLY owns no active order (Rule B / guest sentinel) → the
    // ORDER companion of a pickup question is DROPPED (a companion about a non-
    // existent resource hides nothing), leaving only STORE_OPEN_NOW — VALIDATED —
    // so the turn renders in full. Same inputs as the NO-DROP case EXCEPT the
    // sentinel, isolating the drop.
    const out = renderer.render(
      resultWith(
        [{ type: STORE_OPEN_NOW, verdict: "VALIDATED" }],
        [claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "jantar" })],
      ),
      {
        requestText: "posso retirar meu pedido agora?",
        activeResources: [{ kind: PROVABLY_EMPTY_KIND, id: "order" }],
      },
    );
    expect(out.text).toBe("No momento, o período de funcionamento é: jantar.");
  });

  describe("ownershipFromActiveResources", () => {
    it("undefined (seam unwired) → undefined → decomposer called without ownership (byte-identical)", () => {
      expect(ownershipFromActiveResources(undefined)).toBeUndefined();
    });

    it("no sentinels → {hasActiveOrder:true, hasActivePayment:true} (over-include; a positive ref is NOT a sentinel)", () => {
      expect(ownershipFromActiveResources([])).toEqual({
        hasActiveOrder: true,
        hasActivePayment: true,
      });
      expect(ownershipFromActiveResources([{ kind: "order", id: "o1" }])).toEqual({
        hasActiveOrder: true,
        hasActivePayment: true,
      });
    });

    it("the order sentinel → hasActiveOrder:false (ONLY order dropped)", () => {
      expect(
        ownershipFromActiveResources([{ kind: PROVABLY_EMPTY_KIND, id: "order" }]),
      ).toEqual({ hasActiveOrder: false, hasActivePayment: true });
    });

    it("the payment sentinel → hasActivePayment:false (ONLY payment dropped)", () => {
      expect(
        ownershipFromActiveResources([{ kind: PROVABLY_EMPTY_KIND, id: "payment" }]),
      ).toEqual({ hasActiveOrder: true, hasActivePayment: false });
    });

    it("both sentinels (the guest case) → {false, false}", () => {
      expect(
        ownershipFromActiveResources([
          { kind: PROVABLY_EMPTY_KIND, id: "order" },
          { kind: PROVABLY_EMPTY_KIND, id: "payment" },
        ]),
      ).toEqual({ hasActiveOrder: false, hasActivePayment: false });
    });
  });
});
