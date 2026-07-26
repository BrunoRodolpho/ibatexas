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

// ── BKL-240 — template selection is gated on the BUSINESS OUTCOME ─────────────
//
// An `executed` dispatch proves only that `tool.execute` RETURNED WITHOUT THROWING
// (@claustrum's dispatcher never inspects the returned value), so a tool that RETURNS
// `{ success:false }` landed here as fully executed and drew its full success
// template — a false success reported to STAFF, who then act on it. The gate is
// `success === false` ⇒ abstain (the ratified BKL-247 polarity), and it sits BEFORE
// template selection so the generic fallback cannot leak a success claim either.

describe("BKL-240 — a REPORTED executor failure renders NO success template", () => {
  /** A failure result in the shape a tool returns rather than throws. */
  const FAILED = { success: false, message: "Falha ao aplicar a alteração." };

  it.each(OPS_ACTION_RENDER_TEMPLATE_KEYS.map((k) => [k] as const))(
    "%s → undefined (falls through to the honest grounded path)",
    (kind) => {
      // The payload is deliberately the WELL-FORMED one for each verb where it
      // matters: the gate must win even when the template would have rendered
      // perfectly. Uniform across every registered template — a future verb
      // inherits the safety without editing this file.
      expect(
        renderOpsActionAnswer(
          executed(
            kind,
            { date: "2026-07-11", isOpen: false, available: false, priceCentavos: 9_500 },
            { ...FAILED, newStatus: "ready", displayId: 42, refundAmountCentavos: 100 },
          ),
        ),
      ).toBeUndefined();
    },
  );

  it("the headline: a FAILED schedule.override.set never says 'fechei a loja'", () => {
    const out = renderOpsActionAnswer(
      executed(
        "schedule.override.set",
        { date: "2026-07-11", isOpen: false },
        { success: false, message: "Não foi possível salvar o horário." },
      ),
    );
    expect(out).toBeUndefined();
    // The operator must never be told the store was closed when the write failed.
    expect(out ?? "").not.toContain("fechei");
  });

  it("a FAILED unregistered verb does not leak the GENERIC success line either", () => {
    // "Pronto — ação concluída." is truthful only of a verb that actually ran, so the
    // gate has to precede the fallback, not just the per-kind templates.
    const out = renderOpsActionAnswer(executed("some.future.verb", { any: 1 }, FAILED));
    expect(out).toBeUndefined();
    expect(out).not.toBe(OPS_ACTION_GENERIC_PTBR);
  });

  it("rewritten_and_executed carrying a FAILED result renders nothing", () => {
    expect(
      renderOpsActionAnswer({
        kind: "rewritten_and_executed",
        envelope: { kind: "schedule.override.set", payload: { date: "2026-07-11", isOpen: false } },
        toolId: "t",
        result: FAILED,
        reason: "clamped",
      }),
    ).toBeUndefined();
  });

  it("a MIXED executed_plan (one committed, one failed) renders NOTHING, not a partial success", () => {
    // Rendering only the successful line would read as a COMPLETE success for the
    // turn and silently swallow the failure — the same false-success class one level
    // up. The whole turn falls to the grounded path, which voices both.
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
          result: FAILED,
        },
      ],
    });
    expect(out).toBeUndefined();
    expect(out ?? "").not.toContain("esgotado");
  });

  it("an EXPLICIT success:true renders exactly as before", () => {
    expect(
      renderOpsActionAnswer(
        executed(
          "schedule.override.set",
          { date: "2026-07-11", isOpen: false },
          { success: true, date: "2026-07-11", isOpen: false },
        ),
      ),
    ).toBe("Pronto — fechei a loja em 11/07/2026.");
  });

  it.each([
    ["absent success (every ops executor today)", { date: "2026-07-11", isOpen: false }],
    ["empty result", {}],
    ["undefined result", undefined],
    ["null result", null],
    ["non-record result", "ok"],
  ])(
    "%s still renders — the `!== false` polarity, not `=== true`",
    (_label, result) => {
      // Every registered ops executor returns a DOMAIN-shaped result with no
      // `success` field, so a `=== true` gate would silently stop rendering all of
      // them and reintroduce the false-FAILURE this module was built to kill. Only
      // an EXPLICIT `success: false` withholds the render.
      expect(
        renderOpsActionAnswer(
          executed("schedule.override.set", { date: "2026-07-11", isOpen: false }, result),
        ),
      ).toBe("Pronto — fechei a loja em 11/07/2026.");
    },
  );
});

// ── BKL-240 — the REACHABLE ops failure signals ────────────────────────────────
//
// The audit found NO ops executor sets a `success` field, so the gate above is
// forward-looking only. The signals that are actually reachable today are per-kind
// committed SHAPES, and each one is a real production path, not a hypothetical:
//
//  · ops.alert.resolve.staff / incident.ticket.close.staff — their SYSTEM-write layer
//    adjudicates the inner envelope itself and its contract makes `result` OPTIONAL
//    (ops-tool-registry.ts:199 / :211), so a non-EXECUTE inner decision yields no
//    result and the executors coerce it to `status: null` (:732 / :761). Nothing
//    threw ⇒ `executed` ⇒ the fixed line was stated over a still-OPEN alert.
//  · menu.special.set — `OpsDailySpecialWriter.update` is ROW-OR-NULL
//    (daily-special.service.ts:67) and the executor DISCARDED that null, reporting
//    `existing.id` regardless: a row deleted between the day's `list` and the
//    `update` announced a special that does not exist. The executor now propagates
//    the null as `specialId: null` and this render gates on it.

describe("BKL-240 — alert/incident abstain unless the SYSTEM write reported a status", () => {
  it("ops.alert.resolve.staff with status:null (inner adjudication did NOT execute) → undefined", () => {
    const out = renderOpsActionAnswer(
      executed("ops.alert.resolve.staff", { alertId: "alert_1" }, {
        alertId: "alert_1",
        status: null,
      }),
    );
    expect(out).toBeUndefined();
    // The operator must never be told a still-OPEN alert was resolved.
    expect(out ?? "").not.toContain("resolvido");
  });

  it("incident.ticket.close.staff with status:null → undefined", () => {
    const out = renderOpsActionAnswer(
      executed("incident.ticket.close.staff", { incidentId: "inc_1" }, {
        incidentId: "inc_1",
        status: null,
      }),
    );
    expect(out).toBeUndefined();
    expect(out ?? "").not.toContain("fechado");
  });

  it.each([
    ["absent status", { alertId: "alert_1" }],
    ["blank status", { alertId: "alert_1", status: "   " }],
    ["non-string status", { alertId: "alert_1", status: 200 }],
    ["non-record result", undefined],
  ])("%s also abstains — both executors ALWAYS report the key", (_label, result) => {
    expect(
      renderOpsActionAnswer(executed("ops.alert.resolve.staff", { alertId: "alert_1" }, result)),
    ).toBeUndefined();
  });

  it("a COMMITTED status still renders both lines (the gate is not over-broad)", () => {
    expect(
      renderOpsActionAnswer(
        executed("ops.alert.resolve.staff", { alertId: "a" }, { alertId: "a", status: "RESOLVED" }),
      ),
    ).toBe("Pronto — alerta operacional resolvido.");
    expect(
      renderOpsActionAnswer(
        executed("incident.ticket.close.staff", { incidentId: "i" }, {
          incidentId: "i",
          status: "RESOLVED",
        }),
      ),
    ).toBe("Pronto — incidente fechado.");
  });

  it("a MIXED plan whose alert leg reported no status renders NOTHING", () => {
    const out = renderOpsActionAnswer({
      kind: "executed_plan",
      executions: [
        {
          envelope: { kind: "schedule.override.set", payload: { date: "2026-07-11", isOpen: false } },
          toolId: "t1",
          result: { date: "2026-07-11", isOpen: false },
        },
        {
          envelope: { kind: "ops.alert.resolve.staff", payload: { alertId: "alert_1" } },
          toolId: "t2",
          result: { alertId: "alert_1", status: null },
        },
      ],
    });
    expect(out).toBeUndefined();
    expect(out ?? "").not.toContain("fechei a loja");
  });
});

describe("BKL-240 — menu.special.set abstains when the write touched NO row", () => {
  it("specialId:null (the row vanished between list and update) → undefined", () => {
    const out = renderOpsActionAnswer(
      executed(
        "menu.special.set",
        { productId: "prod_1", date: "2026-07-11", promoPriceCentavos: 7_900 },
        { specialId: null, productId: "prod_1", date: "2026-07-11", created: false },
      ),
    );
    expect(out).toBeUndefined();
    expect(out ?? "").not.toContain("especial");
  });

  it("a committed specialId renders the special line", () => {
    expect(
      renderOpsActionAnswer(
        executed(
          "menu.special.set",
          { productId: "prod_1", date: "2026-07-11", promoPriceCentavos: 7_900 },
          { specialId: "special_1", productId: "prod_1", date: "2026-07-11", created: true },
        ),
      ),
    ).toBe("Pronto — especial de 11/07/2026 definido por R$ 79,00.");
  });

  it("a result with NO specialId key still renders — this template is PAYLOAD-grounded", () => {
    // The committed SCN-114 fixtures carry no result at all; demanding the id would
    // silently stop rendering all of them (the false-FAILURE trap).
    expect(
      renderOpsActionAnswer(executed("menu.special.set", { productId: "p", date: "2026-07-11" })),
    ).toBe("Pronto — especial de 11/07/2026 definido.");
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
