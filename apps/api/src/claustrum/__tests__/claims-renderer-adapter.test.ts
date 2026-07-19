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
import { describe, expect, it, vi } from "vitest";
import type {
  CandidateClaim,
  CanonicalClaim,
  ClaimsKernelResult,
  ConsistencyClaim,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import { logger } from "../../lib/logger.js";
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

  // BKL-079 — the PAYMENT mirror (#8b): a bare-"status" question classifies to BOTH
  // ORDER_STATUS_Q + PAYMENT_STATUS_Q, so it requires ORDER_FULFILLMENT_STAGE AND
  // PAYMENT_STATUS. A customer who PROVABLY owns no active payment must not lose the
  // (VALIDATED) order-status answer to a forced, unresolvable PAYMENT companion.
  it("NO-DROP-ON-FAILURE (payment §O#15 falsifier): activeResources WITHOUT a payment sentinel keeps the PAYMENT companion → honest UNKNOWN", () => {
    const renderer = createIbatexasClaimsRenderer();
    // The order resolved VALIDATED but the payment companion resolved UNKNOWN; with
    // NO payment sentinel (enumeration errored/absent) the PAYMENT companion is KEPT →
    // the turn degrades rather than render the order "easy half" while omitting payment.
    const out = renderer.render(
      resultWith(
        [
          { type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" },
          { type: "PAYMENT_STATUS", verdict: "UNKNOWN" },
        ],
        [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" })],
      ),
      { requestText: "qual o status?", activeResources: [] },
    );
    expect(out.text).toBe(UNKNOWN_TEMPLATE);
    expect(out.text).not.toContain("etapa");
    expect(out.text).not.toContain("preparo");
  });

  it("SOUND-DROP (payment): the payment PROVABLY_EMPTY sentinel drops the PAYMENT companion → the order-status half renders in full", () => {
    const renderer = createIbatexasClaimsRenderer();
    // Same inputs EXCEPT the payment sentinel: the customer PROVABLY owns no active
    // payment → PAYMENT_STATUS drops from the required set → only ORDER_FULFILLMENT_STAGE
    // remains (VALIDATED) → the order status renders in full. Isolates the drop.
    const out = renderer.render(
      resultWith(
        [
          { type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" },
          { type: "PAYMENT_STATUS", verdict: "UNKNOWN" },
        ],
        [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" })],
      ),
      {
        requestText: "qual o status?",
        activeResources: [{ kind: PROVABLY_EMPTY_KIND, id: "payment" }],
      },
    );
    expect(out.text).toBe("Seu pedido está na etapa: em preparo.");
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

// ── BKL-111: the render-path `claims.terminal` observability signal ────────────
//
// The renderer is the terminal/render supersession point: `handleTurn` 6a calls it
// EXACTLY when CLAIMS-VALIDATE produced a kernel result. These tests pin that ONE
// structured `claims.terminal` is emitted per RENDER-path render, carrying the
// FINAL rendered posture + the candidate/validated/dropped registry TYPE names —
// so "which terminal fired" is one log query, not template byte-matching — while
// asserting it is observe-only (no text change), signal-only (one line), and
// PII-free (never a claim value / rendered text). The `prose_preserved` collapse
// is emitted at the PLANNER seam (ibatexas-claim-planner.test.ts), not here — the
// renderer is never called on an empty candidate set.
describe("claims-renderer-adapter — BKL-111 claims.terminal signal", () => {
  const STORE_OPEN_NOW = "STORE_OPEN_NOW";

  const resultOf = (args: {
    perClaim: ReadonlyArray<{ type: string; verdict: ConsistencyClaim["verdict"] }>;
    renderable?: readonly ConsistencyClaim[];
    terminal?: TurnTerminal;
    suppressions?: readonly SuppressionRecord[];
  }): ClaimsKernelResult => {
    const renderable = args.renderable ?? [];
    const terminal = args.terminal ?? "RENDER";
    return {
      perClaim: args.perClaim.map((p) => ({
        subject: "s",
        type: p.type,
        verdict: p.verdict,
      })),
      renderable,
      renderableCanonical: mintRenderable(renderable),
      terminal,
      consistency: { renderable, terminal, suppressions: args.suppressions ?? [] },
    };
  };

  /** The `claims.terminal` info payloads emitted during a spied render. */
  function terminalPayloads(
    spy: ReturnType<typeof vi.spyOn>,
  ): Array<Record<string, unknown>> {
    return spy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((o) => o?.event === "claims.terminal");
  }

  function renderSpied(
    result: ClaimsKernelResult,
    context?: Parameters<ReturnType<typeof createIbatexasClaimsRenderer>["render"]>[1],
  ): { text: string; payloads: Array<Record<string, unknown>> } {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const text = createIbatexasClaimsRenderer().render(result, context).text;
      return { text, payloads: terminalPayloads(infoSpy) };
    } finally {
      infoSpy.mockRestore();
    }
  }

  it("a VALIDATED RENDER → ONE claims.terminal posture=VALIDATED_RENDER + the candidate types", () => {
    const { text, payloads } = renderSpied(
      resultOf({
        perClaim: [{ type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" }],
        renderable: [
          claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" }),
        ],
        terminal: "RENDER",
      }),
    );
    // The render itself is UNAFFECTED (observe-only) — the bound field still renders.
    expect(text).toBe("Seu pedido está na etapa: em preparo.");
    // EXACTLY ONE claims.terminal (signal-only; not per-stage).
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      component: "claims",
      event: "claims.terminal",
      posture: "VALIDATED_RENDER",
      kernelTerminal: "RENDER",
      degradedFromRender: false,
      candidateTypes: [ORDER_FULFILLMENT_STAGE],
      validatedTypes: [ORDER_FULFILLMENT_STAGE],
      droppedClaimTypes: [],
      renderedCount: 1,
    });
    // PII-free: no claim VALUE / rendered text leaked into the structured payload.
    const dump = JSON.stringify(payloads[0]);
    expect(dump).not.toContain("preparing");
    expect(dump).not.toContain("preparo");
    expect(payloads[0]).not.toHaveProperty("text");
  });

  it("an intrinsic UNKNOWN terminal → posture=UNKNOWN, renderedCount 0, the UNKNOWN type dropped", () => {
    const { payloads } = renderSpied(
      resultOf({
        perClaim: [{ type: ORDER_FULFILLMENT_STAGE, verdict: "UNKNOWN" }],
        renderable: [],
        terminal: "UNKNOWN",
      }),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      posture: "UNKNOWN",
      kernelTerminal: "UNKNOWN",
      degradedFromRender: false,
      candidateTypes: [ORDER_FULFILLMENT_STAGE],
      validatedTypes: [],
      droppedClaimTypes: [ORDER_FULFILLMENT_STAGE],
      renderedCount: 0,
    });
  });

  it("a §O#15 completeness DEGRADE → posture=UNKNOWN but kernelTerminal=RENDER + degradedFromRender=true", () => {
    // The kernel said RENDER (STORE_OPEN_NOW validated), but a pickup question
    // requires the ORDER_FULFILLMENT_STAGE companion, which resolved UNKNOWN → the
    // adapter degrades. The signal separates this from an intrinsic kernel UNKNOWN.
    const { text, payloads } = renderSpied(
      resultOf({
        perClaim: [
          { type: STORE_OPEN_NOW, verdict: "VALIDATED" },
          { type: ORDER_FULFILLMENT_STAGE, verdict: "UNKNOWN" },
        ],
        renderable: [claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "jantar" })],
        terminal: "RENDER",
      }),
      { requestText: "posso retirar meu pedido agora?" },
    );
    // Degraded to the proposition-free UNKNOWN template (control flow unchanged).
    expect(text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      posture: "UNKNOWN",
      kernelTerminal: "RENDER",
      degradedFromRender: true,
      candidateTypes: [STORE_OPEN_NOW, ORDER_FULFILLMENT_STAGE],
      validatedTypes: [STORE_OPEN_NOW],
      droppedClaimTypes: [ORDER_FULFILLMENT_STAGE],
      // The kernel minted a canonical claim, but the DEGRADE renders none.
      renderedCount: 0,
    });
    expect(JSON.stringify(payloads[0])).not.toContain("jantar");
  });

  it("an ESCALATE with suppressions → posture=ESCALATE + suppressedTypes (conflict TYPE names only)", () => {
    const { payloads } = renderSpied(
      resultOf({
        perClaim: [
          { type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" },
          { type: "PAYMENT_STATUS", verdict: "VALIDATED" },
        ],
        renderable: [],
        terminal: "ESCALATE",
        suppressions: [
          {
            subject: "s",
            conflictTypes: [ORDER_FULFILLMENT_STAGE, "PAYMENT_STATUS"],
            reason: "UNMODELLED_SAME_SUBJECT",
            terminal: "ESCALATE",
          },
        ],
      }),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      posture: "ESCALATE",
      kernelTerminal: "ESCALATE",
      degradedFromRender: false,
      suppressedTypes: [ORDER_FULFILLMENT_STAGE, "PAYMENT_STATUS"],
      renderedCount: 0,
    });
  });

  it("a CLARIFY terminal → posture=CLARIFY (no suppressedTypes key when none)", () => {
    const { payloads } = renderSpied(
      resultOf({
        perClaim: [{ type: ORDER_FULFILLMENT_STAGE, verdict: "UNKNOWN" }],
        renderable: [],
        terminal: "CLARIFY",
      }),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ posture: "CLARIFY", degradedFromRender: false });
    // suppressedTypes is omitted (not `[]`) when there are no suppressions.
    expect(payloads[0]).not.toHaveProperty("suppressedTypes");
  });

  // ── BKL-117 (Rider A) — the 0.8.0 ClaimsRenderContext.turnId flows into the
  // claims.terminal event, giving the terminal↔turn_trace join key. ──
  it("BKL-117: context.turnId flows into the claims.terminal event (the turn_trace join key)", () => {
    const { payloads } = renderSpied(
      resultOf({
        perClaim: [{ type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" }],
        renderable: [
          claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" }),
        ],
        terminal: "RENDER",
      }),
      { turnId: "turn-abc-123" },
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ turnId: "turn-abc-123", posture: "VALIDATED_RENDER" });
    // PII-free contract preserved: turnId is an opaque loop id, never a claim value.
    expect(JSON.stringify(payloads[0])).not.toContain("preparing");
  });

  it("BKL-117 BYTE-IDENTICAL-ABSENT: no context.turnId → the event OMITS the turnId key", () => {
    const { payloads } = renderSpied(
      resultOf({
        perClaim: [{ type: ORDER_FULFILLMENT_STAGE, verdict: "VALIDATED" }],
        renderable: [
          claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" }),
        ],
        terminal: "RENDER",
      }),
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("turnId");
  });

  // ── BKL-152-edge (Rider C) — the construction-time `renderCarriersActive` flag +
  // the 0.8.0 `resolvedQueryDate` carrier both reach the required-claim decomposer,
  // making the STORE_OPEN_NOW date-anchor suppression EXACT on weekday==today. Proved
  // via the completeness DEGRADE: STORE_HOURS_FOR_DATE VALIDATED + STORE_OPEN_NOW
  // UNKNOWN on a date-anchored hours question — suppressed ⇒ complete (no degrade);
  // kept ⇒ incomplete (degrade). The two directions differ ONLY by the carrier. ──
  const STORE_HOURS_FOR_DATE = "STORE_HOURS_FOR_DATE";
  const dateHoursResult = () =>
    resultOf({
      perClaim: [
        { type: STORE_HOURS_FOR_DATE, verdict: "VALIDATED" },
        { type: STORE_OPEN_NOW, verdict: "UNKNOWN" },
      ],
      renderable: [],
      terminal: "RENDER",
    });
  const degradeFor = (
    renderer: ReturnType<typeof createIbatexasClaimsRenderer>,
    context: Parameters<ReturnType<typeof createIbatexasClaimsRenderer>["render"]>[1],
  ): boolean => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      renderer.render(dateHoursResult(), context);
      return terminalPayloads(infoSpy)[0]?.degradedFromRender === true;
    } finally {
      infoSpy.mockRestore();
    }
  };

  it("BKL-152-edge WIRING: seam active + resolvedQueryDate PRESENT (non-today) → suppressed → NO degrade", () => {
    const active = createIbatexasClaimsRenderer({ renderCarriersActive: true });
    expect(
      degradeFor(active, {
        requestText: "que horas vocês abrem amanhã?",
        resolvedQueryDate: "2026-07-24",
      }),
    ).toBe(false);
  });

  it("BKL-152-edge WIRING: seam active + resolvedQueryDate ABSENT (today) → kept → DEGRADE", () => {
    const active = createIbatexasClaimsRenderer({ renderCarriersActive: true });
    expect(degradeFor(active, { requestText: "que horas vocês abrem amanhã?" })).toBe(true);
  });

  it("BKL-152-edge BYTE-IDENTICAL-ABSENT: default renderer (seam inactive) → pure #301 suppress → NO degrade", () => {
    const inactive = createIbatexasClaimsRenderer();
    expect(degradeFor(inactive, { requestText: "que horas vocês abrem amanhã?" })).toBe(false);
  });
});

// ── BKL-184 — the adapter selects the allergen UNKNOWN variant from requestText ──
describe("BKL-184 — allergen-ask UNKNOWN via the adapter (requestText-gated)", () => {
  /** A kernel result whose terminal is an intrinsic UNKNOWN (no renderables). */
  const unknownResult = (): ClaimsKernelResult => ({
    perClaim: [],
    renderable: [],
    renderableCanonical: [],
    terminal: "UNKNOWN",
    consistency: { renderable: [], terminal: "UNKNOWN", suppressions: [] },
  });

  it("an allergen question landing on UNKNOWN renders the abstain-plus-offer variant", () => {
    const renderer = createIbatexasClaimsRenderer();
    const out = renderer.render(unknownResult(), {
      requestText: "o brownie tem amendoim?",
    });
    expect(out.text).toContain("alérgenos");
    expect(out.text).toContain("atendente");
    // Never a negative assurance (the conservative allergen ruling).
    expect(out.text).not.toContain("não contém");
  });

  it("a NON-allergen question landing on UNKNOWN renders the generic template, byte-identical", () => {
    const renderer = createIbatexasClaimsRenderer();
    const out = renderer.render(unknownResult(), {
      requestText: "cadê meu pedido?",
    });
    expect(out.text).toBe(
      "Não localizei essa informação confirmada agora. Quer que eu verifique?",
    );
  });
});
