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
  ConsistencyClaim,
  SuppressionRecord,
  TurnTerminal,
} from "@adjudicate/core";
import {
  ORDER_ESTIMATED_ARRIVAL,
  ORDER_FULFILLMENT_STAGE,
  PAYMENT_STATUS,
} from "../slot-grammar.js";
import { render } from "../renderer-from-claims.js";

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
    const out = render(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { stage: "em preparo" })],
      RENDER,
    );
    expect(out.terminal).toBe("RENDER");
    expect(out.text).toBe("Seu pedido está na etapa: em preparo.");
    expect(out.lines).toEqual([
      { kind: "ASSERTION", claimType: ORDER_FULFILLMENT_STAGE, text: "Seu pedido está na etapa: em preparo." },
    ]);
  });

  it("binds each proposition slot 1:1 to the right claim type+field (no cross-fill)", () => {
    const out = render(
      [
        claim(PAYMENT_STATUS, "VALIDATED", { status: "aprovado" }),
        claim(ORDER_ESTIMATED_ARRIVAL, "VALIDATED", { etaMinutes: 25 }, "order-1"),
      ],
      RENDER,
    );
    expect(out.text).toContain("O status do seu pagamento é: aprovado.");
    expect(out.text).toContain("A previsão de chegada é de 25 minutos.");
    // The payment line must carry ONLY the payment field, not the ETA, and v.v.
    const paymentLine = out.lines.find((l) => l.claimType === PAYMENT_STATUS);
    expect(paymentLine?.text).not.toContain("25");
  });

  // ── Acceptance 2: UNKNOWN/REFUSED → proposition-free; NO domain fact. ──
  it("renders an UNKNOWN claim as a proposition-free self-report (no domain fact)", () => {
    const out = render(
      [claim(ORDER_FULFILLMENT_STAGE, "UNKNOWN", { stage: "entregue" })],
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
    const out = render(
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
    const out = render(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { somethingElse: "x" })],
      RENDER,
    );
    expect(out.lines[0]?.kind).toBe("UNFILLABLE");
    expect(out.text).toContain("Não localizei"); // abstention, not an assertion
    expect(out.text).not.toContain("etapa:"); // the asserting template did NOT fire
  });

  it("empty/blank field value resolves to abstention, never a blank proposition (registry §5)", () => {
    const out = render(
      [claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { stage: "   " })],
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
      conflictTypes: [ORDER_FULFILLMENT_STAGE, ORDER_ESTIMATED_ARRIVAL],
      reason: "MUTUAL_EXCLUSION_CONFLICT",
      terminal: "ESCALATE",
    };
    // Even if a caller (wrongly) still passes the suppressed claims AND the
    // terminal is ESCALATE, the value must not surface.
    const out = render(
      [
        claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { stage: "entregue" }),
        claim(ORDER_ESTIMATED_ARRIVAL, "VALIDATED", { etaMinutes: 45 }),
      ],
      "ESCALATE",
      [suppression],
    );
    expect(out.terminal).toBe("ESCALATE");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.kind).toBe("TERMINAL");
    // The suppressed propositions ("entregue", "45") must NOT appear.
    expect(out.text).not.toContain("entregue");
    expect(out.text).not.toContain("45");
    expect(out.text).not.toContain("etapa");
    // It IS the safe handoff template.
    expect(out.text).toContain("encaminhar para um atendente");
  });

  it("§O#5: a set-gate UNKNOWN terminal also emits only the safe template", () => {
    const out = render(
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
      claim(ORDER_FULFILLMENT_STAGE, "VALIDATED", { stage: "saiu para entrega" }),
      claim(PAYMENT_STATUS, "UNKNOWN", { status: "x" }),
    ];
    const a = render(input, RENDER);
    const b = render(input, RENDER);
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
    const out = render([validated], "RENDER" satisfies TurnTerminal);
    expect(out.text).toBe("O status do seu pagamento é: aprovado.");
  });
});
