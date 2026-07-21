// ops-action-render.test — BKL-149 unit proofs: an ops EXECUTE (mutation-success)
// reply is rendered DETERMINISTICALLY from the adjudicated envelope (kind + resolved
// payload) + dispatch result, per registered verb — never model-authored prose. The
// headline row is the exact live falsehood (turn 377ca7a1): a schedule.override.set
// CLOSE renders "fechei em 11/07/2026", NOT a store-OPEN sentence.

import { describe, expect, it } from "vitest";
import {
  executedOpsActions,
  renderOpsActionAnswer,
  OPS_ACTION_GENERIC_PTBR,
  OPS_ACTION_RENDER_TEMPLATE_KEYS,
} from "../ops-action-render.js";
import { listOpsToolDefinitions } from "../ops-tool-registry.js";

/** Build a single-envelope `executed` DispatchResult (the acted shape handleTurn
 *  hands the responder for a committed single-envelope EXECUTE). */
function executed(kind: string, payload: unknown, result: unknown = {}): unknown {
  return { kind: "executed", envelope: { kind, payload }, toolId: `t.${kind}`, result };
}

describe("BKL-149 — schedule.override.set is the live-falsehood verb", () => {
  it("CLOSE renders a truthful 'fechei em <date>', NOT the store-OPEN falsehood", () => {
    const out = renderOpsActionAnswer(
      executed(
        "schedule.override.set",
        { date: "2026-07-11", isOpen: false },
        { date: "2026-07-11", isOpen: false },
      ),
    );
    expect(out).toBe("Pronto — fechei a loja em 11/07/2026.");
    // The exact 377ca7a1 falsehood must be impossible: no OPEN state, no wrong day,
    // no "Hoje", no "dia inteiro"/"almoço".
    const lower = out!.toLowerCase();
    expect(lower).not.toContain("aberta");
    expect(lower).not.toContain("aberto");
    expect(lower).not.toContain("dia inteiro");
    expect(lower).not.toContain("almoço");
    expect(lower).not.toContain("hoje");
    // The date renders WITHOUT a timezone shift — the plain business-day label.
    expect(out).toContain("11/07/2026");
  });

  it("OPEN with blocks renders the resolved windows deterministically", () => {
    const out = renderOpsActionAnswer(
      executed("schedule.override.set", {
        date: "2026-07-11",
        isOpen: true,
        blocks: [{ label: "Jantar", start: "18:00", end: "23:00" }],
      }),
    );
    expect(out).toBe(
      "Pronto — atualizei o horário de 11/07/2026: Jantar das 18:00 às 23:00.",
    );
  });

  it("OPEN with no blocks (defensive) states the truthful state, no invented hours", () => {
    const out = renderOpsActionAnswer(
      executed("schedule.override.set", { date: "2026-07-11", isOpen: true }),
    );
    expect(out).toBe("Pronto — marquei a loja como aberta em 11/07/2026.");
  });
});

describe("BKL-149 — per-verb deterministic success templates", () => {
  it("product.availability.set false → esgotado; true → disponível", () => {
    expect(
      renderOpsActionAnswer(
        executed("product.availability.set", { productId: "prod_1", available: false }),
      ),
    ).toBe("Pronto — produto marcado como esgotado (86).");
    expect(
      renderOpsActionAnswer(
        executed("product.availability.set", { productId: "prod_1", available: true }),
      ),
    ).toBe("Pronto — produto marcado como disponível novamente.");
  });

  it("product.price.set renders integer centavos as pt-BR BRL", () => {
    expect(
      renderOpsActionAnswer(
        executed("product.price.set", { productId: "prod_1", priceCentavos: 9_500 }),
      ),
    ).toBe("Pronto — preço do produto atualizado para R$ 95,00.");
  });

  it("menu.special.set renders the business-day + promo price", () => {
    expect(
      renderOpsActionAnswer(
        executed("menu.special.set", {
          productId: "prod_1",
          date: "2026-07-11",
          promoPriceCentavos: 4_500,
        }),
      ),
    ).toBe("Pronto — especial de 11/07/2026 definido por R$ 45,00.");
  });

  it("menu.special.set without a promo price omits the value truthfully", () => {
    expect(
      renderOpsActionAnswer(
        executed("menu.special.set", { productId: "prod_1", date: "2026-07-11" }),
      ),
    ).toBe("Pronto — especial de 11/07/2026 definido.");
  });

  it("order.status.transition renders the projection displayId + pt-BR status", () => {
    // displayId + newStatus come from the committed WRITE RESULT, never the payload.
    expect(
      renderOpsActionAnswer(
        executed(
          "order.status.transition",
          { orderId: "order_uuid", newStatus: "ready" },
          { displayId: 42, newStatus: "ready", previousStatus: "preparing", version: 3, customerId: null },
        ),
      ),
    ).toBe("Pronto — pedido #42 agora está pronto.");
  });

  it("payment.refund.issue renders the committed refund amount as pt-BR BRL", () => {
    // refundAmountCentavos comes from the committed ledger write, never the model.
    expect(
      renderOpsActionAnswer(
        executed(
          "payment.refund.issue",
          { paymentId: "pay_1" },
          { paymentId: "pay_1", refundAmountCentavos: 5_000, newStatus: "refunded", version: 4 },
        ),
      ),
    ).toBe("Pronto — reembolso de R$ 50,00 emitido.");
  });

  it("order.note.add / ops.alert.resolve.staff / incident.ticket.close.staff render truthful fixed lines", () => {
    expect(renderOpsActionAnswer(executed("order.note.add", { orderId: "o" }, { noteId: "n", orderId: "o" }))).toBe(
      "Pronto — observação adicionada ao pedido.",
    );
    expect(
      renderOpsActionAnswer(executed("ops.alert.resolve.staff", { alertId: "a" }, { alertId: "a", status: "RESOLVED" })),
    ).toBe("Pronto — alerta operacional resolvido.");
    expect(
      renderOpsActionAnswer(executed("incident.ticket.close.staff", { incidentId: "i" }, { incidentId: "i", status: "RESOLVED" })),
    ).toBe("Pronto — incidente fechado.");
  });
});

describe("BKL-156 — product-name enrichment (truthful; degrade to generic when absent)", () => {
  it("product.availability.set names the product when the resolver stamped productName", () => {
    expect(
      renderOpsActionAnswer(
        executed("product.availability.set", {
          productId: "prod_1",
          available: false,
          productName: "Picanha",
        }),
      ),
    ).toBe('Pronto — produto "Picanha" marcado como esgotado (86).');
    expect(
      renderOpsActionAnswer(
        executed("product.availability.set", {
          productId: "prod_1",
          available: true,
          productName: "Picanha",
        }),
      ),
    ).toBe('Pronto — produto "Picanha" marcado como disponível novamente.');
  });

  it("product.price.set names the product when stamped", () => {
    expect(
      renderOpsActionAnswer(
        executed("product.price.set", {
          productId: "prod_1",
          priceCentavos: 9_500,
          productName: "Picanha",
        }),
      ),
    ).toBe('Pronto — preço do produto "Picanha" atualizado para R$ 95,00.');
  });

  it("menu.special.set names the product (with and without a promo price)", () => {
    expect(
      renderOpsActionAnswer(
        executed("menu.special.set", {
          productId: "prod_1",
          date: "2026-07-11",
          promoPriceCentavos: 4_500,
          productName: "Feijoada",
        }),
      ),
    ).toBe('Pronto — "Feijoada" definido como especial de 11/07/2026 por R$ 45,00.');
    expect(
      renderOpsActionAnswer(
        executed("menu.special.set", {
          productId: "prod_1",
          date: "2026-07-11",
          productName: "Feijoada",
        }),
      ),
    ).toBe('Pronto — "Feijoada" definido como especial de 11/07/2026.');
  });

  it("a blank/whitespace productName degrades to the generic form (never fabricated or empty)", () => {
    expect(
      renderOpsActionAnswer(
        executed("product.availability.set", {
          productId: "prod_1",
          available: false,
          productName: "   ",
        }),
      ),
    ).toBe("Pronto — produto marcado como esgotado (86).");
  });

  it("a non-string productName is ignored by the render (degrade, never throw)", () => {
    expect(
      renderOpsActionAnswer(
        executed("product.price.set", {
          productId: "prod_1",
          priceCentavos: 9_500,
          productName: 123,
        }),
      ),
    ).toBe("Pronto — preço do produto atualizado para R$ 95,00.");
  });
});

describe("BKL-149 — safe degradation (a new verb is never a falsehood, only less specific)", () => {
  it("an executed kind with no template renders the safe generic line", () => {
    expect(renderOpsActionAnswer(executed("some.future.verb", { any: 1 }))).toBe(
      OPS_ACTION_GENERIC_PTBR,
    );
  });

  it("a malformed payload DEGRADES to the generic line, never throws", () => {
    // A schedule payload whose `date` slips the string guard must not crash.
    expect(renderOpsActionAnswer(executed("schedule.override.set", { date: 123, isOpen: false }))).toBe(
      OPS_ACTION_GENERIC_PTBR,
    );
    // A refund result missing the amount degrades rather than inventing a number.
    expect(renderOpsActionAnswer(executed("payment.refund.issue", { paymentId: "p" }, {}))).toBe(
      OPS_ACTION_GENERIC_PTBR,
    );
  });
});

describe("BKL-149 — only COMMITTED dispatch kinds render (never a false success)", () => {
  it.each([
    ["deferred", { kind: "deferred", signal: "await_payment", timeoutMs: 1000 }],
    ["failed", { kind: "failed", phase: "EXECUTE", code: "TOOL_THREW", message: "boom" }],
    ["refused", { kind: "refused", userText: "x", code: "c", refusalKind: "BUSINESS_RULE" }],
    ["awaiting_confirmation", { kind: "awaiting_confirmation", prompt: "?" }],
    ["escalated", { kind: "escalated", to: "human", reason: "r" }],
    ["undefined", undefined],
    ["null", null],
  ])("%s → undefined (fall through to the honest grounded path)", (_label, acted) => {
    expect(renderOpsActionAnswer(acted)).toBeUndefined();
    expect(executedOpsActions(acted)).toEqual([]);
  });
});

describe("BKL-149 — rewritten_and_executed + a transactional multi-envelope plan", () => {
  it("rewritten_and_executed renders the REWRITTEN (actually-executed) envelope", () => {
    const out = renderOpsActionAnswer({
      kind: "rewritten_and_executed",
      envelope: { kind: "schedule.override.set", payload: { date: "2026-07-11", isOpen: false } },
      toolId: "t",
      result: { date: "2026-07-11", isOpen: false },
      reason: "clamped",
    });
    expect(out).toBe("Pronto — fechei a loja em 11/07/2026.");
  });

  it("executed_plan renders each committed mutation in plan order, joined", () => {
    const out = renderOpsActionAnswer({
      kind: "executed_plan",
      executions: [
        {
          envelope: { kind: "product.availability.set", payload: { productId: "p1", available: false } },
          toolId: "t1",
          result: {},
        },
        {
          envelope: { kind: "schedule.override.set", payload: { date: "2026-07-11", isOpen: false } },
          toolId: "t2",
          result: {},
        },
      ],
    });
    expect(out).toBe(
      "Pronto — produto marcado como esgotado (86).\n\nPronto — fechei a loja em 11/07/2026.",
    );
  });
});

describe("BKL-149 — registry parity: every registered ops EXECUTE verb has a template", () => {
  it("OPS_ACTION_RENDER_TEMPLATE_KEYS ⊇ every registered ops mutating verb kind", () => {
    // The deps are only read at EXECUTE time (closures), never at definition time,
    // so an empty stub enumerates the registered intent kinds safely.
    const registeredKinds = listOpsToolDefinitions({} as never).map((t) =>
      String(t.intentKind),
    );
    const templated = new Set(OPS_ACTION_RENDER_TEMPLATE_KEYS);
    const missing = registeredKinds.filter((k) => !templated.has(k));
    // A missing template is not a FALSEHOOD (the generic fallback is truthful), but
    // it means a new verb ships LESS SPECIFIC than it should — this gate makes that
    // a conscious choice (mirrors the BKL-100 advertised⊆renderable read gate).
    expect(missing).toEqual([]);
  });
});
