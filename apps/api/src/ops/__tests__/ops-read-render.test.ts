// ops-read-render — deterministic pt-BR rendering of a staff ops READ answer
// (BKL-100).
//
// Pins the anti-confabulation contract: a captured read renders BYTE-EXACT from
// the actual result; a degraded signal renders "indisponível" (never its zeros);
// a malformed shape / executor throw / unknown read name renders an honest
// zero-digit "couldn't check" line; and the demote-only clamp fires only on a
// declarative domain-number assertion.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPS_SNAPSHOT_READ_TOOL,
  OPS_SALES_ANALYTICS_READ_TOOL,
} from "@ibatexas/pack-ops";
import {
  clampUngroundedOpsFact,
  governGroundedOpsDraft,
  renderOpsReadAnswer,
  OPS_READ_RENDER_TEMPLATE_KEYS,
  OPS_SNAPSHOT_UNAVAILABLE_PTBR,
  OPS_SALES_UNAVAILABLE_PTBR,
  OPS_READ_UNAVAILABLE_PTBR,
  OPS_UNGROUNDED_CLAMP_PTBR,
  type CapturedOpsRead,
} from "../ops-read-render.js";

const TURN = "turn-1";

// The snapshot timestamp renders in RESTAURANT_TIMEZONE; pin it so "às HH:MM" is
// deterministic (21:00Z ⇒ 18:00 in America/Sao_Paulo, UTC-3).
let savedTz: string | undefined;
beforeEach(() => {
  savedTz = process.env.RESTAURANT_TIMEZONE;
  process.env.RESTAURANT_TIMEZONE = "America/Sao_Paulo";
});
afterEach(() => {
  if (savedTz === undefined) delete process.env.RESTAURANT_TIMEZONE;
  else process.env.RESTAURANT_TIMEZONE = savedTz;
});

/** A shape-complete OpsSnapshot fixture (clean day — nothing degraded). */
function snapshotFixture(over: Record<string, unknown> = {}): unknown {
  return {
    now: "2026-07-04T21:00:00.000Z",
    opsAlerts: { open: 3, bySeverity: { low: 1, medium: 1, high: 1 } },
    incidents: { open: 2 },
    kitchen: {
      activeTickets: 4,
      oldestTicketAgeMs: 300_000,
      queueDepth: [
        { status: "pending", count: 1 },
        { status: "preparing", count: 2 },
        { status: "ready", count: 1 },
      ],
    },
    caixa: {
      date: "2026-07-04",
      ordersCount: 12,
      grossCentavos: 120_000,
      settledCentavos: 110_000,
      refundedCentavos: 5_000,
      netCentavos: 105_000,
    },
    reservations: {
      date: "2026-07-04",
      total: 5,
      byStatus: [
        { status: "confirmed", count: 4 },
        { status: "pending", count: 1 },
      ],
    },
    degraded: [],
    ...over,
  };
}

/** A shape-complete SalesAnalytics fixture (clean day). */
function salesFixture(over: Record<string, unknown> = {}): unknown {
  return {
    now: "2026-07-04T21:00:00.000Z",
    orders: { ordersCount: 12, revenueCentavos: 144_000, aovCentavos: 12_000 },
    activeCarts: 3,
    newCustomers30d: 7,
    whatsapp: { conversionRatePct: 40, avgMessagesToCheckout: 6, outreachWeekly: 12 },
    degraded: [],
    ...over,
  };
}

function capture(name: string, over: Partial<CapturedOpsRead>): CapturedOpsRead {
  return { name, turnId: TURN, ...over };
}

describe("renderOpsReadAnswer — byte-pinned templates", () => {
  it("renders the FULL ops_snapshot panorama from a complete result", () => {
    const out = renderOpsReadAnswer(
      [capture(OPS_SNAPSHOT_READ_TOOL, { result: snapshotFixture() })],
      TURN,
    );
    expect(out).toBe(
      [
        "Panorama operacional (às 18:00):",
        "- Alertas abertos: 3 (1 de alta, 1 de média, 1 de baixa).",
        "- Incidentes abertos: 2.",
        "- Cozinha: 4 tickets ativos, mais antigo há 5 min (fila: pendente 1, preparando 2, pronto 1).",
        "- Caixa (2026-07-04): 12 pedidos, bruto R$ 1.200,00, líquido R$ 1.050,00 (recebido R$ 1.100,00, reembolsado R$ 50,00).",
        "- Reservas de hoje: 5 (confirmada 4, pendente 1).",
      ].join("\n"),
    );
  });

  it("renders the FULL ops_sales_analytics panorama from a complete result", () => {
    const out = renderOpsReadAnswer(
      [capture(OPS_SALES_ANALYTICS_READ_TOOL, { result: salesFixture() })],
      TURN,
    );
    expect(out).toBe(
      [
        "Vendas de hoje (às 18:00):",
        "- Pedidos: 12 (ticket médio R$ 120,00).",
        "- Faturamento: R$ 1.440,00.",
        "- Carrinhos ativos: 3.",
        "- Novos clientes (30 dias): 7.",
        "- WhatsApp: conversão 40%, média de 6 mensagens até o checkout, 12 contatos proativos na semana.",
      ].join("\n"),
    );
  });

  it("maps an unmapped kitchen status to the RAW status (fallback)", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, {
          result: snapshotFixture({
            kitchen: {
              activeTickets: 1,
              oldestTicketAgeMs: 0,
              queueDepth: [{ status: "weird_status", count: 1 }],
            },
          }),
        }),
      ],
      TURN,
    );
    expect(out).toContain("fila: weird_status 1");
  });
});

describe("renderOpsReadAnswer — degraded signals render 'indisponível', never zeros", () => {
  it("renders a degraded kitchen + caixa as indisponível with NO zeros", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, {
          result: snapshotFixture({
            kitchen: { activeTickets: 0, oldestTicketAgeMs: 0, queueDepth: [] },
            caixa: {
              date: "2026-07-04",
              ordersCount: 0,
              grossCentavos: 0,
              settledCentavos: 0,
              refundedCentavos: 0,
              netCentavos: 0,
            },
            degraded: ["kitchen", "caixa"],
          }),
        }),
      ],
      TURN,
    );
    expect(out).toContain("- Cozinha: indisponível no momento.");
    expect(out).toContain("- Caixa: indisponível no momento.");
    // The degraded signals' fallback zeros must NEVER surface.
    expect(out).not.toContain("R$ 0,00");
    expect(out).not.toContain("0 pedidos");
    expect(out).not.toContain("0 tickets");
    // The intact signals still render their real values.
    expect(out).toContain("- Alertas abertos: 3");
  });

  it("renders a degraded orders signal as indisponível for BOTH pedidos + faturamento", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SALES_ANALYTICS_READ_TOOL, {
          result: salesFixture({
            orders: { ordersCount: 0, revenueCentavos: 0, aovCentavos: 0 },
            degraded: ["orders"],
          }),
        }),
      ],
      TURN,
    );
    expect(out).toContain("- Pedidos: indisponível no momento.");
    expect(out).toContain("- Faturamento: indisponível no momento.");
    expect(out).not.toContain("R$ 0,00");
    // The other signals stay real.
    expect(out).toContain("- Carrinhos ativos: 3.");
  });
});

describe("renderOpsReadAnswer — honest failure tiers (zero digits, never a number)", () => {
  const noDigits = (s: string | undefined) => expect(/\d/.test(s ?? "x")).toBe(false);

  it("executor THREW → honest snapshot line, no digits", () => {
    const out = renderOpsReadAnswer(
      [capture(OPS_SNAPSHOT_READ_TOOL, { error: new Error("projection down") })],
      TURN,
    );
    expect(out).toBe(OPS_SNAPSHOT_UNAVAILABLE_PTBR);
    noDigits(out);
  });

  it("malformed snapshot shape → honest snapshot line, no digits", () => {
    // Missing bySeverity → fails structural validation.
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, {
          result: { now: "2026-07-04T21:00:00.000Z", opsAlerts: { open: 3 } },
        }),
      ],
      TURN,
    );
    expect(out).toBe(OPS_SNAPSHOT_UNAVAILABLE_PTBR);
    noDigits(out);
  });

  it("malformed sales shape → honest sales line, no digits", () => {
    const out = renderOpsReadAnswer(
      [capture(OPS_SALES_ANALYTICS_READ_TOOL, { result: { now: "x", orders: {} } })],
      TURN,
    );
    expect(out).toBe(OPS_SALES_UNAVAILABLE_PTBR);
    noDigits(out);
  });

  it("unknown read name → generic honest line, no digits", () => {
    const out = renderOpsReadAnswer(
      [capture("ops_bogus_read", { result: { anything: true } })],
      TURN,
    );
    expect(out).toBe(OPS_READ_UNAVAILABLE_PTBR);
    noDigits(out);
  });
});

describe("renderOpsReadAnswer — turn scoping + panorama", () => {
  it("returns undefined when NO read was captured this turn", () => {
    expect(renderOpsReadAnswer([], TURN)).toBeUndefined();
    expect(
      renderOpsReadAnswer(
        [capture(OPS_SNAPSHOT_READ_TOOL, { result: snapshotFixture(), turnId: "other" })],
        TURN,
      ),
    ).toBeUndefined();
  });

  it("joins DISTINCT reads into one panorama", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, { result: snapshotFixture() }),
        capture(OPS_SALES_ANALYTICS_READ_TOOL, { result: salesFixture() }),
      ],
      TURN,
    );
    expect(out).toContain("Panorama operacional");
    expect(out).toContain("Vendas de hoje");
  });
});

describe("OPS_READ_RENDER_TEMPLATE_KEYS — the drift-gate renderable set", () => {
  it("has a template for exactly the two advertised reads", () => {
    expect(new Set(OPS_READ_RENDER_TEMPLATE_KEYS)).toEqual(
      new Set([OPS_SNAPSHOT_READ_TOOL, OPS_SALES_ANALYTICS_READ_TOOL]),
    );
  });
});

describe("clampUngroundedOpsFact — demote-only, conservative", () => {
  it("clamps a declarative domain-number assertion (number → noun)", () => {
    expect(clampUngroundedOpsFact("Temos 7 reservas hoje.")).toBe(
      OPS_UNGROUNDED_CLAMP_PTBR,
    );
  });

  it("clamps a money-adjacent domain assertion (noun → R$)", () => {
    expect(clampUngroundedOpsFact("O caixa fechou em R$ 5.000 hoje.")).toBe(
      OPS_UNGROUNDED_CLAMP_PTBR,
    );
  });

  it("clamps a fabricated order count", () => {
    expect(clampUngroundedOpsFact("Foram 12 pedidos e 3 incidentes.")).toBe(
      OPS_UNGROUNDED_CLAMP_PTBR,
    );
  });

  it("does NOT clamp a QUESTION about a domain number", () => {
    expect(clampUngroundedOpsFact("Quantas reservas temos hoje?")).toBeNull();
  });

  it("does NOT clamp non-numeric conversational glue", () => {
    expect(clampUngroundedOpsFact("Beleza, vou verificar isso pra você.")).toBeNull();
    expect(clampUngroundedOpsFact("Tudo certo por aqui, sem novidades.")).toBeNull();
  });

  it("does NOT clamp a number that is NOT near a domain noun", () => {
    expect(clampUngroundedOpsFact("Te aviso em 5 minutos.")).toBeNull();
  });

  // ── Adversarial-review fixes ────────────────────────────────────────────────

  it("FIX: clamps the trailing-engagement-question register (declarative number + comma + question tail)", () => {
    // Pre-fix, whole-sentence question tagging exempted this — the model's
    // habitual shape for a confabulated count.
    expect(
      clampUngroundedOpsFact("Hoje tivemos 12 pedidos, quer que eu detalhe?"),
    ).toBe(OPS_UNGROUNDED_CLAMP_PTBR);
    expect(clampUngroundedOpsFact("Foram 12 pedidos, certo?")).toBe(
      OPS_UNGROUNDED_CLAMP_PTBR,
    );
  });

  it("FIX: clamps a QUESTION that itself states an ungrounded domain number", () => {
    // Any digit the model emits on a no-read turn is ungrounded — phrasing it as
    // a question does not ground it.
    expect(clampUngroundedOpsFact("Você quer ver os 12 pedidos de hoje?")).toBe(
      OPS_UNGROUNDED_CLAMP_PTBR,
    );
  });

  it("FIX: does NOT clamp a number echoed from an allowed source (the staff's own message)", () => {
    expect(
      clampUngroundedOpsFact("Vou verificar o pedido 4242 pra você.", [
        "como está o pedido 4242?",
      ]),
    ).toBeNull();
  });

  it("FIX: an allowed echo does NOT launder a SECOND ungrounded number in the same sentence", () => {
    expect(
      clampUngroundedOpsFact("O pedido 4242 é um dos 23 pedidos de hoje.", [
        "como está o pedido 4242?",
      ]),
    ).toBe(OPS_UNGROUNDED_CLAMP_PTBR);
  });
});

describe("governGroundedOpsDraft — the grounded (read+act) governor", () => {
  const CLEAN_DRAFT = "Alerta resolvido com sucesso.";

  it("appends the deterministic render when a read was captured this turn", () => {
    const captures = [
      capture(OPS_SNAPSHOT_READ_TOOL, { result: snapshotFixture() }),
    ];
    const out = governGroundedOpsDraft(CLEAN_DRAFT, captures, TURN, []);
    expect(out.startsWith(CLEAN_DRAFT)).toBe(true);
    expect(out).toContain("Panorama operacional");
    expect(out).toContain("12 pedidos"); // the TRUE caixa count, from the capture
  });

  it("clamps an ungrounded model number and PRESERVES the appended render", () => {
    const captures = [
      capture(OPS_SNAPSHOT_READ_TOOL, { result: snapshotFixture() }),
    ];
    const out = governGroundedOpsDraft(
      "Alerta resolvido! Hoje já foram 23 pedidos.",
      captures,
      TURN,
      [],
    );
    expect(out).not.toContain("23 pedidos"); // the model's fabrication is gone
    expect(out).toContain(OPS_UNGROUNDED_CLAMP_PTBR);
    expect(out).toContain("Panorama operacional"); // the true answer survives
  });

  it("a model number matching the RENDER is grounded (no clamp)", () => {
    const captures = [
      capture(OPS_SNAPSHOT_READ_TOOL, { result: snapshotFixture() }),
    ];
    const out = governGroundedOpsDraft(
      "Feito! O caixa registra 12 pedidos hoje.",
      captures,
      TURN,
      [],
    );
    expect(out.startsWith("Feito! O caixa registra 12 pedidos hoje.")).toBe(true);
    expect(out).toContain("Panorama operacional");
  });

  it("no captures + ungrounded number → the honest nudge (hop-1 mixed turn, read never ran)", () => {
    expect(governGroundedOpsDraft("Costela desativada! Hoje já foram 23 pedidos.", [], TURN, []))
      .toBe(OPS_UNGROUNDED_CLAMP_PTBR);
  });

  it("no captures + acted-summary-grounded number → untouched (a real refund amount)", () => {
    const acted = JSON.stringify({ dispatch: "payment.refund.issue", amountCentavos: 5000 });
    const draft = "Reembolso de R$ 50,00 emitido no pedido 4242.";
    expect(governGroundedOpsDraft(draft, [], TURN, [acted, "reembolsa o pedido 4242"]))
      .toBe(draft);
  });

  it("no captures + clean draft → byte-identical", () => {
    expect(governGroundedOpsDraft(CLEAN_DRAFT, [], TURN, [])).toBe(CLEAN_DRAFT);
  });
});

describe("renderOpsReadAnswer — template throw degrades to the honest line (never crashes the turn)", () => {
  it("an unparseable `now` (RangeError inside Intl) renders the honest line, not a throw", () => {
    const captures = [
      capture(OPS_SNAPSHOT_READ_TOOL, {
        result: snapshotFixture({ now: "not-a-date" }),
      }),
    ];
    const out = renderOpsReadAnswer(captures, TURN);
    expect(out).toBe(OPS_SNAPSHOT_UNAVAILABLE_PTBR);
    expect(out).not.toMatch(/\d/);
  });
});

describe("renderOpsReadAnswer — reservations line (BKL-127)", () => {
  it("renders 'nenhuma' for a zero-reservation day (a real zero, not a degrade)", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, {
          result: snapshotFixture({
            reservations: { date: "2026-07-04", total: 0, byStatus: [] },
          }),
        }),
      ],
      TURN,
    );
    expect(out).toContain("- Reservas de hoje: nenhuma.");
  });

  it("renders a DEGRADED reservations signal as indisponível, never zeros", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, {
          result: snapshotFixture({
            reservations: { date: "2026-07-04", total: 0, byStatus: [] },
            degraded: ["reservations"],
          }),
        }),
      ],
      TURN,
    );
    expect(out).toContain("- Reservas de hoje: indisponível no momento.");
    expect(out).not.toContain("Reservas de hoje: 0");
    expect(out).not.toContain("nenhuma");
  });

  it("maps an unmapped reservation status to the RAW status (fallback)", () => {
    const out = renderOpsReadAnswer(
      [
        capture(OPS_SNAPSHOT_READ_TOOL, {
          result: snapshotFixture({
            reservations: {
              date: "2026-07-04",
              total: 1,
              byStatus: [{ status: "weird_status", count: 1 }],
            },
          }),
        }),
      ],
      TURN,
    );
    expect(out).toContain("- Reservas de hoje: 1 (weird_status 1).");
  });
});
