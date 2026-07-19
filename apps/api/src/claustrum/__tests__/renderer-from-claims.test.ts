/**
 * Renderer-from-claims tests (SDD §J.6 / §O#3 / §O#5 / §Q.7; Inv 6).
 *
 * NON-VACUOUS: every test asserts a real behaviour of the pure template-filler
 * against the LINKED `@adjudicate/core` claims types (ClaimVerdict / TurnTerminal /
 * ConsistencyClaim / SuppressionRecord) — not a stub. No live model, no DB.
 *
 * The auditor must scrutinise especially:
 *   - test 3 (NO model prose / determinism — grep + byte-identity), and
 *   - test 4 (§O#5 no re-leak of a suppressed value), and
 *   - test 6 (NON-VACUITY: removing the proposition-free guard turns 2/4 RED).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CandidateClaim,
  CanonicalClaim,
  ConsistencyClaim,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import { EvidenceLedger, runClaimsKernel } from "@adjudicate/core";
import {
  isPropositionFree,
  ORDER_FULFILLMENT_STAGE,
  PAYMENT_STATUS,
  SAFE_TEMPLATES,
  SAFE_UNKNOWN_ALLERGEN_TEMPLATE,
  STORE_OPEN_NOW,
  type Template,
} from "../slot-grammar.js";
import { REGISTRY_SPECS } from "../claim-registry.js";
import { createIbatexasClaimsKernelDeps } from "../ibatexas-claims-kernel-deps.js";
// The bulk of these tests exercise the PURE template-filler core directly (it takes
// raw renderable claims incl. the UNKNOWN/REFUSED postures the kernel-minted set never
// carries). Production egress goes through `render`, which REQUIRES kernel-minted
// CanonicalClaims (the inv.17 entry brand) — covered in the dedicated block below.
import { render, renderRenderables } from "../renderer-from-claims.js";

// ── builders ────────────────────────────────────────────────────────────────
const claim = (
  type: string,
  verdict: ConsistencyClaim["verdict"],
  value: unknown,
  subject = "order-1",
): ConsistencyClaim => ({ subject, type, verdict, value });

const RENDER: TurnTerminal = "RENDER";

describe("renderer-from-claims — §Q.7 pure template-filler", () => {
  // ── Acceptance 1: a VALIDATED claim renders via its template, 1:1 (Inv 6). ──
  it("renders a VALIDATED claim's field value in its template slot (Inv 6 1:1)", () => {
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "em preparo" })],
      RENDER,
    );
    expect(out.terminal).toBe("RENDER");
    expect(out.text).toBe("Seu pedido está na etapa: em preparo.");
    expect(out.lines).toEqual([
      { kind: "ASSERTION", claimType: ORDER_FULFILLMENT_STAGE, text: "Seu pedido está na etapa: em preparo." },
    ]);
  });

  it("binds each proposition slot 1:1 to the right claim type+field (no cross-fill)", () => {
    const out = renderRenderables(
      [
        claim(PAYMENT_STATUS, "VALIDATED", { status: "aprovado" }),
        claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "almoço" }, "order-1"),
      ],
      RENDER,
    );
    expect(out.text).toContain("O status do seu pagamento é: aprovado.");
    expect(out.text).toContain("No momento, o período de funcionamento é: almoço.");
    // The payment line must carry ONLY the payment field, not the store-open one, and v.v.
    const paymentLine = out.lines.find((l) => l.claimType === PAYMENT_STATUS);
    expect(paymentLine?.text).not.toContain("almoço");
  });

  // ── Inv 6 1:1 (literal-falsehood regression): two VALIDATED claims of the SAME
  // type on DISTINCT owned subjects each render THEIR OWN value — never the
  // first-of-type. Before the fix, `fillProposition` read `byType.get(type)` (the
  // FIRST validated claim of that type) for every line, so order B's line rendered
  // order A's stage → the customer was told a literal falsehood ("em preparo" for a
  // pedido already "saiu para entrega"), breaking the 1:1 claim↔proposition binding.
  it("Inv 6: same-type claims on distinct subjects each render their OWN value (not first-of-type)", () => {
    const out = renderRenderables(
      [
        claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" }, "order-A"),
        claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "in_delivery" }, "order-B"),
      ],
      RENDER,
    );
    // Two ASSERTION lines, each carrying its OWN subject's localized stage.
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toEqual({
      kind: "ASSERTION",
      claimType: ORDER_FULFILLMENT_STAGE,
      text: "Seu pedido está na etapa: em preparo.",
    });
    expect(out.lines[1]).toEqual({
      kind: "ASSERTION",
      claimType: ORDER_FULFILLMENT_STAGE,
      text: "Seu pedido está na etapa: saiu para entrega.",
    });
    // The joined text carries BOTH distinct stages — order B is NOT mis-told order
    // A's stage (the literal falsehood the fix closes).
    expect(out.text).toBe(
      "Seu pedido está na etapa: em preparo. Seu pedido está na etapa: saiu para entrega.",
    );
  });

  // ── Acceptance 2: UNKNOWN/REFUSED → proposition-free; NO domain fact. ──
  it("renders an UNKNOWN claim as a proposition-free self-report (no domain fact)", () => {
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "UNKNOWN", { fulfillmentStatus: "entregue" })],
      RENDER,
    );
    // It must be an epistemic self-report / offer (registry §5)...
    expect(out.text).toContain("Não localizei");
    expect(out.text).toContain("verifique");
    // ...and assert NO domain proposition — the suppressed/absent "stage" value
    // ("entregue") must NOT appear, nor any fulfillment/payment assertion verb.
    expect(out.text).not.toContain("entregue");
    expect(out.text).not.toContain("etapa");
    expect(out.text).not.toContain("status");
    expect(out.lines[0]?.kind).toBe("ABSTENTION");
  });

  it("renders a REFUSED claim as a proposition-free could-not-confirm (no domain fact)", () => {
    const out = renderRenderables(
      [claim(PAYMENT_STATUS, "REFUSED", { status: "aprovado" })],
      RENDER,
    );
    expect(out.text).toContain("Não consegui confirmar");
    expect(out.text).not.toContain("aprovado"); // the domain value must not leak
    expect(out.text).not.toContain("pagamento é");
  });

  // ── Acceptance 5 / Inv 6: a slot with no backing validated claim → abstain. ──
  it("abstains (no fabricated fact) when a proposition slot has no backing validated claim", () => {
    // VALIDATED claim of the right TYPE, but the value is MISSING the bound field.
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { somethingElse: "x" })],
      RENDER,
    );
    expect(out.lines[0]?.kind).toBe("UNFILLABLE");
    expect(out.text).toContain("Não localizei"); // abstention, not an assertion
    expect(out.text).not.toContain("etapa:"); // the asserting template did NOT fire
  });

  it("empty/blank field value resolves to abstention, never a blank proposition (registry §5)", () => {
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "   " })],
      RENDER,
    );
    expect(out.lines[0]?.kind).toBe("UNFILLABLE");
    expect(out.text).not.toContain("etapa:");
  });

  // ── Acceptance 4 / §O#5: a suppressed (ESCALATE) value does NOT re-leak. ──
  it("§O#5: an ESCALATE terminal from the set-gate never re-asserts the suppressed value", () => {
    // The suppression record is proposition-free by design (no `value` field);
    // the renderer must emit ONLY the safe terminal template.
    const suppression: SuppressionRecord = {
      subject: "order-1",
      conflictTypes: [ORDER_FULFILLMENT_STAGE, STORE_OPEN_NOW],
      reason: "MUTUAL_EXCLUSION_CONFLICT",
      terminal: "ESCALATE",
    };
    // Even if a caller (wrongly) still passes the suppressed claims AND the
    // terminal is ESCALATE, the value must not surface.
    const out = renderRenderables(
      [
        claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "entregue" }),
        claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "almoço" }),
      ],
      "ESCALATE",
      [suppression],
    );
    expect(out.terminal).toBe("ESCALATE");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    // The suppressed propositions ("entregue", "almoço") must NOT appear.
    expect(out.text).not.toContain("entregue");
    expect(out.text).not.toContain("almoço");
    expect(out.text).not.toContain("etapa");
    // It IS the safe handoff template.
    expect(out.text).toContain("encaminhar para um atendente");
  });

  it("§O#5: a set-gate UNKNOWN terminal also emits only the safe template", () => {
    const out = renderRenderables(
      [claim(PAYMENT_STATUS, "VALIDATED", { status: "aprovado" })],
      "UNKNOWN",
      [],
    );
    expect(out.terminal).toBe("UNKNOWN");
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    expect(out.text).not.toContain("aprovado");
  });

  // ── Acceptance 3 / §O#3: deterministic, byte-identical, NO model call. ──
  it("§O#3: identical input yields byte-identical output (pure, no model)", () => {
    const input: ConsistencyClaim[] = [
      claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "saiu para entrega" }),
      claim(PAYMENT_STATUS, "UNKNOWN", { status: "x" }),
    ];
    const a = renderRenderables(input, RENDER);
    const b = renderRenderables(input, RENDER);
    expect(a.text).toBe(b.text);
    expect(a).toEqual(b);
  });

  it("§O#3: the renderer module has NO code path that calls a model/LLM", () => {
    const modulePath = fileURLToPath(
      new URL("../renderer-from-claims.ts", import.meta.url),
    );
    const grammarPath = fileURLToPath(
      new URL("../slot-grammar.ts", import.meta.url),
    );
    const source = readFileSync(modulePath, "utf8") + "\n" + readFileSync(grammarPath, "utf8");
    // No model/LLM/network call surfaces. (Words appearing only inside comments
    // explaining the BAN are fine; we forbid the call/import IDENTIFIERS.)
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bcreateChatCompletion\b/);
    expect(source).not.toMatch(/\bgenerate(Text|Content|Response)\s*\(/);
    expect(source).not.toMatch(/from\s+["'][^"']*ollama[^"']*["']/);
    expect(source).not.toMatch(/from\s+["'][^"']*openai[^"']*["']/);
    expect(source).not.toMatch(/from\s+["'][^"']*anthropic[^"']*["']/);
    expect(source).not.toMatch(/import\s+["'][^"']*provider[^"']*["']/);
  });

  // ── Acceptance 7: consumes the linked kernel types, not a stub. ──
  it("consumes @adjudicate/core ConsistencyClaim/SuppressionRecord/TurnTerminal types", () => {
    // If these were a stub, the structural types below would not type-check
    // against the renderer's signature. The runtime assertion confirms the
    // verdict union the kernel defines drives the branch.
    const validated: ConsistencyClaim = claim(PAYMENT_STATUS, "VALIDATED", { status: "aprovado" });
    const out = renderRenderables([validated], "RENDER" satisfies TurnTerminal);
    expect(out.text).toBe("O status do seu pagamento é: aprovado.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 — terminal routing: an honest-ignorance UNKNOWN renders the epistemic
// SELF-REPORT, NOT the human-handoff/ESCALATE copy.
//
// SDD Inv 6 (render-template purity: UNKNOWN/REFUSED templates assert nothing
// factual) + §I (the turn terminals RENDER · UNKNOWN · ESCALATE · CLARIFY are
// DISTINCT, first-class). The routing is now three-way (BKL-148):
// `ESCALATE → escalate; CLARIFY → clarify; else (UNKNOWN) → unknown`. ESCALATE
// renders the handoff copy; UNKNOWN the honest-ignorance self-report; and CLARIFY
// a DISTINCT disambiguation ASK ("tenho mais de um registro possível — pode me
// dizer o número…?"). Pre-BKL-148, CLARIFY collapsed into the UNKNOWN self-report,
// answering a disambiguation turn with a bare "não localizei". All three copies are
// proposition-free. These tests are NON-VACUOUS — collapsing CLARIFY back into
// UNKNOWN turns (c) RED (the clarify ask would be replaced by "não localizei").
// ─────────────────────────────────────────────────────────────────────────────
describe("renderer-from-claims — R3 terminal routing (Inv 6; §I distinct terminals)", () => {
  const UNKNOWN: TurnTerminal = "UNKNOWN";
  const ESCALATE: TurnTerminal = "ESCALATE";
  const CLARIFY: TurnTerminal = "CLARIFY";

  // Distinguishing copy fragments (sourced from slot-grammar's SAFE_TEMPLATES).
  const SELF_REPORT = "Não localizei"; // unique to SAFE_TEMPLATES.unknown
  const HANDOFF = "encaminhar para um atendente"; // unique to SAFE_TEMPLATES.escalate
  const CLARIFY_ASK = "mais de um registro possível"; // unique to SAFE_TEMPLATES.clarify

  // The exact rendered string of a proposition-free safe template = its LITERAL
  // text. Deriving it from SAFE_TEMPLATES ties each assertion to the grammar
  // itself (not a hand-copied string), so "renders SAFE_TEMPLATES.unknown" is
  // asserted directly.
  const literalText = (t: Template): string =>
    t.slots.map((s) => (s.kind === "LITERAL" ? s.text : "")).join("");

  // (a) NON-VACUOUS: revert to `CLARIFY ? unknown : escalate` and an UNKNOWN
  // terminal routes to the escalate/handoff copy → this test goes RED.
  it("terminal UNKNOWN renders SAFE_TEMPLATES.unknown (self-report), NOT the handoff (a)", () => {
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "entregue" })],
      UNKNOWN,
    );
    expect(out.terminal).toBe("UNKNOWN");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    // It IS the epistemic self-report (SAFE_TEMPLATES.unknown), byte-for-byte.
    expect(out.text).toBe(literalText(SAFE_TEMPLATES.unknown));
    expect(out.text).toContain(SELF_REPORT);
    // ...and is explicitly NOT the human-handoff/escalate copy.
    expect(out.text).not.toContain(HANDOFF);
  });

  // (b) ESCALATE keeps rendering the handoff/escalate template.
  it("terminal ESCALATE renders SAFE_TEMPLATES.escalate (handoff copy) (b)", () => {
    const out = renderRenderables(
      [claim(PAYMENT_STATUS, "VALIDATED", { status: "aprovado" })],
      ESCALATE,
    );
    expect(out.terminal).toBe("ESCALATE");
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    expect(out.text).toBe(literalText(SAFE_TEMPLATES.escalate));
    expect(out.text).toContain(HANDOFF);
    expect(out.text).not.toContain(SELF_REPORT);
  });

  // (c) BKL-148: CLARIFY now renders the DISTINCT disambiguation ask
  // (SAFE_TEMPLATES.clarify) — NOT the UNKNOWN self-report, and NOT the handoff.
  it("terminal CLARIFY renders SAFE_TEMPLATES.clarify (disambiguation ask), NOT unknown/handoff (c)", () => {
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "em preparo" })],
      CLARIFY,
    );
    expect(out.terminal).toBe("CLARIFY");
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    // It IS the clarify disambiguation ask, byte-for-byte…
    expect(out.text).toBe(literalText(SAFE_TEMPLATES.clarify));
    expect(out.text).toContain(CLARIFY_ASK);
    // …and is explicitly NEITHER the generic UNKNOWN self-report NOR the handoff.
    expect(out.text).not.toContain(SELF_REPORT);
    expect(out.text).not.toContain(HANDOFF);
  });

  // (d) Inv 6: the chosen UNKNOWN/ESCALATE/CLARIFY templates are proposition-free —
  // they assert nothing factual about an order/payment, even with real claims in hand.
  it("the UNKNOWN, ESCALATE and CLARIFY terminal templates remain proposition-free (d; Inv 6)", () => {
    // Structural: all three safe templates carry ZERO proposition slots.
    expect(isPropositionFree(SAFE_TEMPLATES.unknown)).toBe(true);
    expect(isPropositionFree(SAFE_TEMPLATES.escalate)).toBe(true);
    expect(isPropositionFree(SAFE_TEMPLATES.clarify)).toBe(true);
    // Behavioural: with real domain claims present, NO order/payment fact leaks.
    for (const terminal of [UNKNOWN, ESCALATE, CLARIFY] as const) {
      const out = renderRenderables(
        [
          claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "entregue" }),
          claim(PAYMENT_STATUS, "VALIDATED", { status: "aprovado" }),
          claim(STORE_OPEN_NOW, "VALIDATED", { mealPeriod: "almoço" }),
        ],
        terminal,
      );
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]?.kind).toBe("TERMINAL");
      // No domain proposition (stage / payment status / store-open) surfaces.
      expect(out.text).not.toContain("entregue");
      expect(out.text).not.toContain("aprovado");
      expect(out.text).not.toContain("almoço");
      expect(out.text).not.toContain("etapa");
      expect(out.text).not.toContain("pagamento é");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BKL-170 — CLARIFY-with-candidates (@claustrum/core 0.8.0 `disambiguationCandidates`
// carrier). When the adopter threads first-party, owner-scoped candidate labels, a
// CLARIFY renders the proposition-free ask that VOICES the specific handles,
// superseding the generic clarify. Absent/empty candidates → the generic clarify
// (byte-identical to pre-0.8.0). NON-VACUOUS: dropping the candidates branch turns
// (a) RED (the voiced labels would vanish); passing candidates on a non-CLARIFY
// terminal must NOT change the output (b).
// ─────────────────────────────────────────────────────────────────────────────
describe("renderer-from-claims — BKL-170 CLARIFY-with-candidates (0.8.0 carrier)", () => {
  const CLARIFY: TurnTerminal = "CLARIFY";
  const literalText = (t: Template): string =>
    t.slots.map((s) => (s.kind === "LITERAL" ? s.text : "")).join("");
  const anyClaim = [
    claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "em preparo" }),
  ];
  const candidates = [
    { kind: "order", id: "order_01A", label: "#1042" },
    { kind: "order", id: "order_01B", label: "#1043" },
  ];

  it("(a) CLARIFY + candidates → voices the specific labels (supersedes generic clarify)", () => {
    const out = renderRenderables(anyClaim, CLARIFY, [], candidates);
    expect(out.terminal).toBe("CLARIFY");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    // Both first-party labels are voiced, joined pt-BR ("… #1042 ou #1043?").
    expect(out.text).toContain("#1042");
    expect(out.text).toContain("#1043");
    expect(out.text).toContain(" ou ");
    // It is NOT the generic clarify copy (which asks the customer to TYPE the number).
    expect(out.text).not.toBe(literalText(SAFE_TEMPLATES.clarify));
    expect(out.text).not.toContain("pode me dizer o número");
    // Still proposition-free: it asserts NO domain fact about either order.
    expect(out.text).not.toContain("em preparo");
    expect(out.text).not.toContain("etapa");
  });

  it("(a') three candidates render the pt-BR enumerated join ('a, b ou c')", () => {
    const three = [
      { kind: "order", id: "o1", label: "#1" },
      { kind: "order", id: "o2", label: "#2" },
      { kind: "order", id: "o3", label: "#3" },
    ];
    const out = renderRenderables(anyClaim, CLARIFY, [], three);
    expect(out.text).toContain("#1, #2 ou #3");
  });

  it("(b) candidates on a NON-CLARIFY terminal are ignored (byte-identical)", () => {
    const withCands = renderRenderables(anyClaim, "UNKNOWN", [], candidates);
    const without = renderRenderables(anyClaim, "UNKNOWN", []);
    expect(withCands.text).toBe(without.text);
    expect(withCands.text).toBe(literalText(SAFE_TEMPLATES.unknown));
  });

  it("(c) BYTE-IDENTICAL-ABSENT: CLARIFY with empty/omitted candidates → the generic clarify", () => {
    const omitted = renderRenderables(anyClaim, CLARIFY);
    const empty = renderRenderables(anyClaim, CLARIFY, [], []);
    expect(omitted.text).toBe(literalText(SAFE_TEMPLATES.clarify));
    expect(empty.text).toBe(literalText(SAFE_TEMPLATES.clarify));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F1 — ORDER_FULFILLMENT_STAGE renderer field alignment (slot reads
// `fulfillmentStatus`, the C6 value-binding field). A VALIDATED ORDER claim now
// RENDERS instead of abstaining to UNKNOWN.
//
// F3 — PRESENTATION-ONLY pt-BR enum localization. The DISPLAYED string is
// localized at the render seam; the claim's BOUND value stays the RAW LEDGER ENUM
// so C6 keeps binding. Unmapped enum → SAFE fallback (raw). These are NON-VACUOUS:
// reverting F1 turns the first RED (UNFILLABLE); reverting F3 turns the localized
// assertions RED (raw English would surface).
//
// These exercise the PURE filler core `renderRenderables` (raw renderable claims);
// the canonical-gated `render` entry is exercised by the inv.17 block below.
// ─────────────────────────────────────────────────────────────────────────────
describe("renderer-from-claims — F1 ORDER field bind + F3 pt-BR enum localization", () => {
  // F1: a VALIDATED ORDER claim carrying the ACTUAL ledger field `fulfillmentStatus`
  // (raw enum) renders — and F3 localizes the displayed enum to pt-BR.
  it("F1: a VALIDATED ORDER_FULFILLMENT_STAGE claim renders its stage (was UNFILLABLE)", () => {
    const out = renderRenderables(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" })],
      RENDER,
    );
    expect(out.lines[0]?.kind).toBe("ASSERTION");
    // F1 + F3: the raw ledger enum `preparing` renders, localized to pt-BR.
    expect(out.text).toBe("Seu pedido está na etapa: em preparo.");
  });

  // F3 + C6: PAYMENT_STATUS `paid` DISPLAYS as `pago` while the claim's BOUND value
  // stays the raw ledger enum `paid` (the renderer never mutates the claim).
  it("F3: PAYMENT_STATUS paid → 'pago' in the text WHILE claim.value stays 'paid' (C6 binds)", () => {
    const input = claim(PAYMENT_STATUS, "VALIDATED", { status: "paid" });
    const out = renderRenderables([input], RENDER);
    // Displayed string is localized…
    expect(out.text).toBe("O status do seu pagamento é: pago.");
    // …but the BOUND value is UNCHANGED — still the raw ledger enum (C6 value-
    // binding compares THIS, so it must stay `paid`, never `pago`).
    expect((input.value as { status: string }).status).toBe("paid");
    expect(out.text).not.toContain("paid");
  });

  it("F3: STORE_OPEN_NOW closed → 'fechado' and lunch/dinner → 'almoço'/'jantar'", () => {
    expect(
      renderRenderables([claim("STORE_OPEN_NOW", "VALIDATED", { mealPeriod: "closed" })], RENDER).text,
    ).toBe("No momento, o período de funcionamento é: fechado.");
    expect(
      renderRenderables([claim("STORE_OPEN_NOW", "VALIDATED", { mealPeriod: "lunch" })], RENDER).text,
    ).toBe("No momento, o período de funcionamento é: almoço.");
    expect(
      renderRenderables([claim("STORE_OPEN_NOW", "VALIDATED", { mealPeriod: "dinner" })], RENDER).text,
    ).toBe("No momento, o período de funcionamento é: jantar.");
  });

  it("F3: ORDER fulfillment delivered → 'entregue', ready → 'pronto'", () => {
    expect(
      renderRenderables([claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "delivered" })], RENDER).text,
    ).toBe("Seu pedido está na etapa: entregue.");
    expect(
      renderRenderables([claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "ready" })], RENDER).text,
    ).toBe("Seu pedido está na etapa: pronto.");
  });

  it("F3: an UNMAPPED enum member degrades SAFE to the raw value (never crash, never blank)", () => {
    const out = renderRenderables(
      [claim(PAYMENT_STATUS, "VALIDATED", { status: "chargeback_pending" })],
      RENDER,
    );
    // Unmapped → SAFE fallback to the raw value (the claim still renders, not UNKNOWN).
    expect(out.lines[0]?.kind).toBe("ASSERTION");
    expect(out.text).toBe("O status do seu pagamento é: chargeback_pending.");
  });

  it("F3 is DISPLAY-only: localization never mutates the input claim value (C6 preserved)", () => {
    const input = claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { fulfillmentStatus: "preparing" });
    renderRenderables([input], RENDER);
    // The bound value the kernel's C6 compares is untouched after rendering.
    expect((input.value as { fulfillmentStatus: string }).fulfillmentStatus).toBe("preparing");
  });
});

// ── inv.17 ENTRY BRAND: `render` REQUIRES kernel-minted CanonicalClaims ────────
//
// The renderer's PUBLIC entry can author prose ONLY from a CanonicalClaim minted by
// `runClaimsKernel` on the VALIDATED ∧ P2-consistent renderable set. A raw claim +
// model value can NEVER reach prose: a forged `as CanonicalClaim` literal throws at
// `unwrapCanonical`. This is the type-level + runtime form of "claims, not prose".
describe("renderer-from-claims — render() requires a kernel-minted CanonicalClaim (inv.17)", () => {
  it("THROWS on a forged (non-minted) CanonicalClaim cast — no prose from a raw claim", () => {
    const forged = {
      subject: "s",
      type: STORE_OPEN_NOW,
      value: { mealPeriod: "jantar" },
    } as unknown as CanonicalClaim;
    expect(() => render([forged], RENDER)).toThrow(/forged or non-minted/);
  });

  it("renders a STORE_OPEN_NOW claim ONLY from the kernel-minted renderableCanonical", () => {
    // Drive the REAL kernel: a present, fresh schedule signal with the bound
    // `mealPeriod` field; no ScheduleOverride present (falsifier does not fire).
    const NOW = 10_000;
    const ledger = new EvidenceLedger("t");
    ledger.record({
      key: "schedule:store_open_now",
      value: { mealPeriod: "jantar" },
      source: "schedule.getSignal",
      fetchedAt: NOW,
      sourceMode: "live",
      taint: "TRUSTED",
      originProvenance: "FIRST_PARTY",
    });
    const candidate: CandidateClaim = {
      soundness: REGISTRY_SPECS.STORE_OPEN_NOW.requiredEvidence
        ? {
            requiredEvidence: REGISTRY_SPECS.STORE_OPEN_NOW.requiredEvidence,
            minSourceIntegrity: REGISTRY_SPECS.STORE_OPEN_NOW.minSourceIntegrity,
            kind: REGISTRY_SPECS.STORE_OPEN_NOW.kind,
            actor: "system",
            falsifierComplete: true,
            falsifiers: REGISTRY_SPECS.STORE_OPEN_NOW.falsifiers ?? [],
            valueBinding: REGISTRY_SPECS.STORE_OPEN_NOW.valueBinding,
          }
        : (undefined as never),
      subject: "store",
      type: STORE_OPEN_NOW,
      value: { mealPeriod: "jantar" },
    };
    const result = runClaimsKernel(
      ledger,
      [candidate],
      createIbatexasClaimsKernelDeps({ now: () => NOW }),
    );
    // Sanity: the kernel actually minted a renderable canonical claim.
    expect(result.terminal).toBe("RENDER");
    expect(result.renderableCanonical).toHaveLength(1);
    const out = render(result.renderableCanonical, RENDER);
    expect(out.text).toBe("No momento, o período de funcionamento é: jantar.");
  });
});

// ── BKL-184 — the allergen-ask UNKNOWN variant (abstain + human-handoff OFFER) ──
// Gated ONLY by the adapter-computed `allergenAsk` flag AND an UNKNOWN terminal;
// every other posture/flag combination is byte-identical to the generic templates.
describe("BKL-184 — allergen-ask UNKNOWN renders the abstain-plus-offer variant", () => {
  it("UNKNOWN + allergenAsk → the allergen offer copy (proposition-free)", () => {
    const out = renderRenderables([], "UNKNOWN", [], [], true);
    expect(out.text).toBe(
      "Não localizei essa informação de alérgenos confirmada agora — por segurança, prefiro não arriscar uma resposta. Quer que eu peça para um atendente confirmar com a cozinha?",
    );
    // The conservative allergen ruling: never a negative assurance.
    expect(out.text).not.toContain("não contém");
  });

  it("UNKNOWN without the flag → the generic template, byte-identical", () => {
    const flagged = renderRenderables([], "UNKNOWN", [], [], false);
    const bare = renderRenderables([], "UNKNOWN");
    expect(flagged.text).toBe(bare.text);
    expect(bare.text).toBe("Não localizei essa informação confirmada agora. Quer que eu verifique?");
  });

  it("the flag NEVER touches other terminals (ESCALATE/CLARIFY byte-identical)", () => {
    expect(renderRenderables([], "ESCALATE", [], [], true).text).toBe(
      renderRenderables([], "ESCALATE").text,
    );
    expect(renderRenderables([], "CLARIFY", [], [], true).text).toBe(
      renderRenderables([], "CLARIFY").text,
    );
  });

  it("the variant template is structurally proposition-free (the §O#3 mechanical guarantee)", () => {
    expect(isPropositionFree(SAFE_UNKNOWN_ALLERGEN_TEMPLATE)).toBe(true);
  });
});
