// ops-scoped-claims.e2e — LE2 ticket 12: the OPS-SCOPED claim types at the TURN
// SEAM.
//
// The spec's Testing Decisions name the turn seam as the primary seam ("drive an
// utterance in and assert on what comes out … ops-plane grounded renders after
// convergence"), so this suite drives a REAL ops `handleTurn` through the REAL
// `composeOpsConductor` (real composed router, real kernel, real ops tool
// registry, real system channel) and asserts the DELIVERED REPLY — never a
// pipeline internal.
//
// What is faked: the ModelProvider (scripted), the ops READ ROSTER's two
// executors (the ONE IO boundary the ops resolvers cross), and the customer
// claims pipeline's `createDomainTriadReadBackend`. The investigator, the ops
// resolvers, the claim planner, the claims kernel, the render-from-claims
// renderer, the precedence lattice, the responder and the conductor are all
// PRODUCTION code.
//
// Coverage (ticket 12 acceptance):
//   AC1 — three store-level questions answered as claims-grounded renders
//         (orders-today · pending escalations · today's reservations)
//   AC2 — the EMPTY cases render an honest, VALIDATED "none" (a successful empty
//         read is a FACT, not an UNKNOWN)
//   AC3 — an ERRORED / DEGRADED read degrades via the safe-unknown gate, with
//         ZERO invented digits
//   AC5 — small talk unaffected · staff-actor stamping intact · resolvers go
//         through the ops read roster · flag OFF keeps the prior behaviour

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../../claustrum/claims-pipeline.js";
import {
  OPS_ORDERS_TODAY,
  OPS_PENDING_ESCALATIONS,
  OPS_RESERVATIONS_TODAY,
} from "../ops-claim-registry.js";
import type { OpsSnapshot } from "../ops-snapshot-compose.js";
import type { SalesAnalytics } from "../sales-analytics-compose.js";

// ── The customer-half read backend (the SAME mock LE2-011's suite uses) ───────
// `buildClaimsSeams` composes the ops gatherer as `customer reads ∪ ops reads`;
// its customer half builds `createDomainTriadReadBackend()` (Prisma + Redis +
// Medusa). Mock exactly that factory so the turn runs with no DB/network while
// every claims stage — including the whole ops half — stays genuine.
vi.mock("../../claustrum/turn-reads.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/turn-reads.js")>();
  const { buildTriadReadBackend } = await import(
    "../../__tests__/helpers/triad-backend-builder.js"
  );
  return {
    ...actual,
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => ({ isClosed: false, mealPeriod: "dinner" }),
        readScheduleOverride: async () => null,
        readStoreHours: async () => ({ hoursText: "18h às 23h" }),
        readHoliday: async () => null,
        readHoursForDate: async () => ({ hoursText: "18h às 23h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        // A staff principal owns no customer orders / payments / reservations —
        // present-with-count-0 is the honest answer.
        listActiveOrderIds: async () => [],
        listActiveReservationIds: async () => [],
        countActivePayments: async () => 0,
      }),
  };
});

const {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
} = await import("./ops-e2e-harness.js");

// ── The rendered contracts (slot-grammar frame × the resolver's pt-BR scalar) ──

const ORDERS_RENDER = "Pedidos de hoje: 12.";
const ORDERS_EMPTY_RENDER = "Pedidos de hoje: nenhum até agora.";
const ESCALATIONS_RENDER =
  "Escalações operacionais pendentes: 3 alertas (2 de alta, 1 de média, 0 de baixa) e 1 incidente.";
const ESCALATIONS_EMPTY_RENDER = "Escalações operacionais pendentes: nenhuma.";
const RESERVATIONS_RENDER = "Reservas de hoje: 5 (confirmada 3, pendente 2).";
const RESERVATIONS_EMPTY_RENDER = "Reservas de hoje: nenhuma.";

/** The proposition-free abstain every degraded claims turn renders. */
const SAFE_UNKNOWN =
  "Não localizei essa informação confirmada agora. Quer que eu verifique?";
/** The prose a converged turn must NEVER deliver (and its confabulated number). */
const MODEL_PROSE = "Hoje foram 47 pedidos e está tudo tranquilo por aqui!";

// ── Ops read-roster fixtures (the ONE faked IO boundary of the resolvers) ─────

function salesAnalytics(over: {
  ordersCount?: number;
  degraded?: readonly string[];
} = {}): SalesAnalytics {
  return {
    now: "2026-07-24T21:00:00.000Z",
    orders: {
      ordersCount: over.ordersCount ?? 12,
      revenueCentavos: 120_000,
      aovCentavos: 10_000,
    },
    activeCarts: 2,
    newCustomers30d: 7,
    whatsapp: { conversionRatePct: 20, avgMessagesToCheckout: 6, outreachWeekly: 3 },
    degraded: over.degraded ?? [],
  };
}

function opsSnapshot(over: {
  alertsOpen?: number;
  incidentsOpen?: number;
  reservationsTotal?: number;
  reservationsByStatus?: ReadonlyArray<{ status: string; count: number }>;
  degraded?: readonly string[];
} = {}): OpsSnapshot {
  const alertsOpen = over.alertsOpen ?? 3;
  return {
    now: "2026-07-24T21:00:00.000Z",
    opsAlerts: {
      open: alertsOpen,
      bySeverity: alertsOpen === 0 ? { low: 0, medium: 0, high: 0 } : { low: 0, medium: 1, high: 2 },
    },
    incidents: { open: over.incidentsOpen ?? 1 },
    kitchen: { activeTickets: 4, oldestTicketAgeMs: 600_000, queueDepth: [] },
    caixa: {
      date: "2026-07-24",
      ordersCount: 12,
      grossCentavos: 120_000,
      settledCentavos: 110_000,
      refundedCentavos: 0,
      netCentavos: 120_000,
    },
    reservations: {
      date: "2026-07-24",
      total: over.reservationsTotal ?? 5,
      byStatus:
        over.reservationsByStatus ??
        (over.reservationsTotal === 0
          ? []
          : [
              { status: "confirmed", count: 3 },
              { status: "pending", count: 2 },
            ]),
    },
    degraded: over.degraded ?? [],
  };
}

/**
 * The ops READ ROSTER the resolvers must go through. Each entry is a spy, so the
 * suite can assert the resolver never invented a second path (ticket constraint:
 * "resolvers go through the existing ops read executors/roster").
 */
function opsRoster(opts: {
  snapshot?: OpsSnapshot | (() => never);
  sales?: SalesAnalytics | (() => never);
} = {}): {
  executors: Record<string, ReturnType<typeof vi.fn>>;
} {
  const resolveOr = (value: unknown) =>
    vi.fn(async () => {
      if (typeof value === "function") return (value as () => never)();
      return value;
    });
  return {
    executors: {
      ops_snapshot: resolveOr(opts.snapshot ?? opsSnapshot()),
      ops_sales_analytics: resolveOr(opts.sales ?? salesAnalytics()),
    },
  };
}

/**
 * A three-role scripted model (the LE2-011 idiom): a converged ops turn makes up
 * to THREE completions — the INTENT planner, the CLAIM planner (`propose_claim`)
 * and the responder. Dispatch is by tool surface, never by call order.
 */
function claimsScriptedModel(opts: {
  readonly intentCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  readonly claim?: { readonly type: string; readonly subject: string };
  readonly responderText?: string;
}): ModelProvider & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    const toolNames = (req.tools ?? []).map((t) => t.name);
    const base = {
      model: "mock",
      stopReason: "end_turn",
      inputTokens: 5,
      outputTokens: 4,
    } as const;
    if (toolNames.includes(PROPOSE_CLAIM_TOOL)) {
      return {
        ...base,
        text: "",
        toolCalls:
          opts.claim === undefined
            ? []
            : [{ id: "claim-1", name: PROPOSE_CLAIM_TOOL, input: { ...opts.claim } }],
      };
    }
    if (toolNames.length > 0) {
      const calls = opts.intentCalls ?? [];
      return {
        ...base,
        text: calls.length > 0 ? "" : "ok (mock planner pass — nothing to propose)",
        toolCalls: [...calls],
      };
    }
    return { ...base, text: opts.responderText ?? MODEL_PROSE, toolCalls: [] };
  });
  return {
    complete,
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as ModelProvider & { complete: ReturnType<typeof vi.fn> };
}

function buildDeps(
  model: ModelProvider,
  roster: Record<string, ReturnType<typeof vi.fn>>,
): {
  deps: ReturnType<typeof composeOpsDeps>;
  sink: ReturnType<typeof makeCapturingAuditSink>;
} {
  const sink = makeCapturingAuditSink();
  const { tools } = buildOpsTools({}, sink);
  return {
    sink,
    deps: composeOpsDeps({
      adjudicator: makeAuditedAdjudicator({ sink }),
      session: makeStatefulSession(),
      tools,
      model,
      opsReadToolExecutors: roster,
      buildResolver: () => ({
        resolve: async ({ plan }: { plan: { envelopes: readonly unknown[] } }) =>
          plan.envelopes.map((envelope) => ({ envelope, state: {} })),
      }),
    }),
  };
}

/** Drive one staff turn asking `text`, with the 4B tagging `claimType`. */
async function askOps(
  text: string,
  claimType: string,
  roster: Record<string, ReturnType<typeof vi.fn>>,
): Promise<string> {
  const model = claimsScriptedModel({
    claim: { type: claimType, subject: "loja" },
    responderText: MODEL_PROSE,
  });
  const { deps } = buildDeps(model, roster);
  const out = await runOpsTurn(deps, { role: "OWNER", staffId: "owner1", text });
  return out.response;
}

describe("LE2-012 — ops-scoped claim types render grounded on the ops thread", () => {
  beforeEach(() => {
    process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  });

  // ── AC1: three store-level questions, answered from VALIDATED claims ───────

  describe("AC1 — DATA present: the reply is the claims render, never model prose", () => {
    it("orders-today: 'quantos pedidos hoje?' renders the read's OWN count", async () => {
      const { executors } = opsRoster();
      const reply = await askOps("quantos pedidos hoje?", OPS_ORDERS_TODAY, executors);

      expect(reply).toBe(ORDERS_RENDER);
      // The model's confident, confabulated number never reaches the operator.
      expect(reply).not.toContain("47");
      expect(reply).not.toBe(SAFE_UNKNOWN);
      // …and it came THROUGH the ops read roster, not a new path.
      expect(executors.ops_sales_analytics).toHaveBeenCalledTimes(1);
    });

    it("pending escalations: 'tem escalação pendente?' renders the open queues", async () => {
      const { executors } = opsRoster();
      const reply = await askOps(
        "tem escalação pendente?",
        OPS_PENDING_ESCALATIONS,
        executors,
      );

      expect(reply).toBe(ESCALATIONS_RENDER);
      expect(reply).not.toBe(SAFE_UNKNOWN);
      expect(executors.ops_snapshot).toHaveBeenCalledTimes(1);
    });

    it("today's reservations: 'quais reservas hoje?' renders the total + tally", async () => {
      const { executors } = opsRoster();
      const reply = await askOps(
        "quais reservas hoje?",
        OPS_RESERVATIONS_TODAY,
        executors,
      );

      expect(reply).toBe(RESERVATIONS_RENDER);
      expect(reply).not.toBe(SAFE_UNKNOWN);
      expect(executors.ops_snapshot).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC2: an empty read that SUCCEEDED is a FACT, not an UNKNOWN ────────────

  describe("AC2 — EMPTY data: an honest grounded 'none', never the safe abstain", () => {
    it("zero orders renders a VALIDATED 'nenhum até agora'", async () => {
      const { executors } = opsRoster({ sales: salesAnalytics({ ordersCount: 0 }) });
      const reply = await askOps("quantos pedidos hoje?", OPS_ORDERS_TODAY, executors);

      expect(reply).toBe(ORDERS_EMPTY_RENDER);
      // The distinction the ticket insists on: a proven zero is an ANSWER.
      expect(reply).not.toBe(SAFE_UNKNOWN);
    });

    it("no escalations renders a VALIDATED 'nenhuma'", async () => {
      const { executors } = opsRoster({
        snapshot: opsSnapshot({ alertsOpen: 0, incidentsOpen: 0 }),
      });
      const reply = await askOps(
        "tem escalação pendente?",
        OPS_PENDING_ESCALATIONS,
        executors,
      );

      expect(reply).toBe(ESCALATIONS_EMPTY_RENDER);
      expect(reply).not.toBe(SAFE_UNKNOWN);
    });

    it("no reservations renders a VALIDATED 'nenhuma'", async () => {
      const { executors } = opsRoster({
        snapshot: opsSnapshot({ reservationsTotal: 0 }),
      });
      const reply = await askOps(
        "quais reservas hoje?",
        OPS_RESERVATIONS_TODAY,
        executors,
      );

      expect(reply).toBe(RESERVATIONS_EMPTY_RENDER);
      expect(reply).not.toBe(SAFE_UNKNOWN);
    });
  });

  // ── AC3: an unavailable read is NOT a zero ────────────────────────────────

  describe("AC3 — ERRORED/degraded reads degrade honestly, with ZERO invented digits", () => {
    it("a THROWN sales read degrades to the safe abstain", async () => {
      const { executors } = opsRoster({
        sales: () => {
          throw new Error("medusa admin unreachable");
        },
      });
      const reply = await askOps("quantos pedidos hoje?", OPS_ORDERS_TODAY, executors);

      expect(reply).toBe(SAFE_UNKNOWN);
      expect(reply).not.toContain("Pedidos de hoje");
      expect(reply).not.toMatch(/\d/); // the digit clamp's spirit, at the claims level
    });

    it("a DEGRADED orders signal never renders its zero fallback as a real count", async () => {
      // This is the whole reason `degraded[]` exists: `ordersCount: 0` here is a
      // FALLBACK, indistinguishable from a real slow day. Asserting it would be
      // the confabulation BKL-100 closed on this plane.
      const { executors } = opsRoster({
        sales: salesAnalytics({ ordersCount: 0, degraded: ["orders"] }),
      });
      const reply = await askOps("quantos pedidos hoje?", OPS_ORDERS_TODAY, executors);

      expect(reply).toBe(SAFE_UNKNOWN);
      expect(reply).not.toBe(ORDERS_EMPTY_RENDER);
      expect(reply).not.toMatch(/\d/);
    });

    it("a DEGRADED escalations signal degrades (a partial queue would understate it)", async () => {
      const { executors } = opsRoster({
        snapshot: opsSnapshot({ alertsOpen: 0, incidentsOpen: 0, degraded: ["incidents"] }),
      });
      const reply = await askOps(
        "tem escalação pendente?",
        OPS_PENDING_ESCALATIONS,
        executors,
      );

      expect(reply).toBe(SAFE_UNKNOWN);
      expect(reply).not.toBe(ESCALATIONS_EMPTY_RENDER);
    });

    it("a DEGRADED reservations signal degrades rather than reporting 'nenhuma'", async () => {
      const { executors } = opsRoster({
        snapshot: opsSnapshot({ reservationsTotal: 0, degraded: ["reservations"] }),
      });
      const reply = await askOps(
        "quais reservas hoje?",
        OPS_RESERVATIONS_TODAY,
        executors,
      );

      expect(reply).toBe(SAFE_UNKNOWN);
      expect(reply).not.toBe(RESERVATIONS_EMPTY_RENDER);
    });

    it("a READ ROSTER GAP is 'could not check', never 'nothing to report'", async () => {
      // An empty roster (no executor registered) must fail CLOSED — Inv 7.
      const reply = await askOps("quantos pedidos hoje?", OPS_ORDERS_TODAY, {});

      expect(reply).toBe(SAFE_UNKNOWN);
      expect(reply).not.toMatch(/\d/);
    });
  });

  // ── AC5: the rest of the plane is untouched ───────────────────────────────

  describe("AC5 — the converged plane is otherwise unchanged", () => {
    it("SMALL TALK is unaffected AND costs no ops read", async () => {
      const { executors } = opsRoster();
      const model = claimsScriptedModel({
        responderText: "Bom dia! Tudo certo por aqui.",
      });
      const { deps } = buildDeps(model, executors);

      const out = await runOpsTurn(deps, {
        role: "OWNER",
        staffId: "owner1",
        text: "bom dia!",
      });

      expect(out.response).toBe("Bom dia! Tudo certo por aqui.");
      expect(out.response).not.toBe(SAFE_UNKNOWN);
      // The span net is what keeps a greeting free: no ops read ran at all.
      expect(executors.ops_snapshot).not.toHaveBeenCalled();
      expect(executors.ops_sales_analytics).not.toHaveBeenCalled();
    });

    it("STAFF-ACTOR envelope stamping survives the ops claim wiring", async () => {
      const { executors } = opsRoster();
      const model = claimsScriptedModel({
        intentCalls: [
          {
            id: "tc-1",
            name: "express_intent",
            input: {
              capability: "product.availability.set",
              payload: { productId: "prod_1", available: false },
            },
          },
        ],
      });
      const { deps, sink } = buildDeps(model, executors);

      await runOpsTurn(deps, {
        role: "OWNER",
        staffId: "owner1",
        text: "marca o brisket como esgotado",
      });

      const record = sink.byKind("product.availability.set")[0];
      expect(record).toBeDefined();
      expect(record!.envelope.actor.principal).toBe("user");
      expect(record!.envelope.actor.sessionId).toBe("admin:owner1");
      expect(record!.envelope.actor.role).toBe("OWNER");
    });

    it("an ops question the 4B tags with NO claim still degrades honestly", async () => {
      // The BKL-078 responder gate is the net when the candidate set collapses
      // BEFORE the kernel — the model's confabulated "47 pedidos" must not ship.
      const { executors } = opsRoster();
      const model = claimsScriptedModel({ responderText: MODEL_PROSE });
      const { deps } = buildDeps(model, executors);

      const out = await runOpsTurn(deps, {
        role: "OWNER",
        staffId: "owner1",
        text: "quantos pedidos hoje?",
      });

      expect(out.response).toBe(SAFE_UNKNOWN);
      expect(out.response).not.toContain("47");
    });

    it("FLAG OFF: the ops plane keeps its prior raw-prose behaviour exactly", async () => {
      delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
      const { executors } = opsRoster();
      // A DIGIT-FREE draft, so this arm isolates the claims seams: the pre-existing
      // BKL-100 digit clamp is unconditional (it fires flag-on and flag-off alike —
      // the very next arm pins that), and using a numeric draft here would test the
      // clamp instead of the seams.
      const PRIOR_PROSE = "Vou dar uma olhada no painel e te confirmo já já.";
      const model = claimsScriptedModel({
        claim: { type: OPS_ORDERS_TODAY, subject: "loja" },
        responderText: PRIOR_PROSE,
      });
      const { deps } = buildDeps(model, executors);

      const out = await runOpsTurn(deps, {
        role: "OWNER",
        staffId: "owner1",
        text: "quantos pedidos hoje?",
      });

      // No seams → the pre-LE2 fall-through: the model's prose IS the reply, and
      // no ops read ever ran (the resolvers live behind the investigator seam).
      expect(out.response).toBe(PRIOR_PROSE);
      expect(executors.ops_sales_analytics).not.toHaveBeenCalled();
      const claimCalls = model.complete.mock.calls.filter(
        (call: unknown[]) =>
          ((call[0] as CompletionRequest).tools ?? []).some(
            (t) => t.name === PROPOSE_CLAIM_TOOL,
          ),
      );
      expect(claimCalls).toHaveLength(0);
    });

    it("FLAG OFF: the BKL-100 digit clamp still demotes an ungrounded ops number", async () => {
      // Defense in depth, unchanged by this ticket: with the claims seams absent
      // the ops responder's demote-only clamp is what keeps a model-authored
      // "47 pedidos" off the operator's screen. Pinned here so the flag-off arm
      // above can use a digit-free draft without losing this coverage.
      delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
      const { executors } = opsRoster();
      const model = claimsScriptedModel({ responderText: MODEL_PROSE });
      const { deps } = buildDeps(model, executors);

      const out = await runOpsTurn(deps, {
        role: "OWNER",
        staffId: "owner1",
        text: "quantos pedidos hoje?",
      });

      expect(out.response).not.toContain("47");
      expect(out.response).not.toBe(MODEL_PROSE);
    });
  });
});
