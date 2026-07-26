// LE2 decision 6 — the OPS TURN-SEAM proof of claims convergence.
//
// The spec's Testing Decisions name the TURN SEAM as the primary seam: "drive an
// utterance in and assert on what comes out … ops-plane grounded renders after
// convergence". So this suite drives a REAL ops `handleTurn` through the REAL
// `composeOpsConductor` (via the shared ops e2e harness — real composed router, real
// kernel, real ops tool registry, real system channel) and asserts the DELIVERED
// REPLY, never a pipeline internal.
//
// What is faked: the ModelProvider (scripted) and the claims pipeline's ONE external
// IO boundary, `createDomainTriadReadBackend` (schedule/order/payment reads). The
// investigator, claim planner, claims kernel, render-from-claims renderer, precedence
// lattice, responder and conductor are all PRODUCTION code.
//
// Coverage (ticket 11 acceptance):
//   1. store-open-now, OPEN     → the VALIDATED claims render, never model prose
//   2. store-open-now, CLOSED   → the VALIDATED claims render of the closed period
//   3. store-open-now, UNKNOWN  → honest proposition-free degrade (read errored)
//   4. ops small talk           → UNAFFECTED (natural prose survives convergence)
//   5. staff-actor envelope     → still stamped `admin:<staffId>` + role
//   6. flag OFF                 → prior behaviour (raw prose), byte-for-byte

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../../claustrum/claims-pipeline.js";

// ── The ONE mocked external: the claims pipeline's read backend ────────────────
// `buildClaimsSeams` constructs `createIbatexasInvestigator()`, whose default
// gatherer builds `createDomainTriadReadBackend()` — Prisma + Redis + Medusa. Mock
// exactly that factory (importOriginal keeps `extractTurnResourceIds` and the types
// real) so the turn runs with no DB/network while every claims stage stays genuine.
const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: {
    signal: { isClosed: false, mealPeriod: "dinner" } as unknown,
    scheduleThrows: false,
  },
}));

vi.mock("../../claustrum/turn-reads.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/turn-reads.js")>();
  const notUsed = (name: string) => async (): Promise<never> => {
    throw new Error(`turn-reads.${name} must not run in this suite`);
  };
  return {
    ...actual,
    createDomainTriadReadBackend: () => ({
      readSchedule: async () => {
        if (scheduleBackend.scheduleThrows) {
          throw new Error("schedule store unavailable");
        }
        return scheduleBackend.signal;
      },
      // No per-date override today ⇒ null ⇒ the investigator records ABSENT_READ ⇒
      // the STORE_OPEN_NOW cross-key falsifier does NOT fire.
      readScheduleOverride: async () => null,
      readStoreHours: async () => ({ hoursText: "18h às 23h" }),
      readHoliday: async () => null,
      readHoursForDate: async () => ({ hoursText: "18h às 23h" }),
      readHolidayForDate: async () => null,
      readScheduleOverrideForDate: async () => null,
      readOrderFulfillment: notUsed("readOrderFulfillment"),
      readPaymentStatus: notUsed("readPaymentStatus"),
      readReservation: notUsed("readReservation"),
      readPaymentRefund: notUsed("readPaymentRefund"),
      readPaymentChargeback: notUsed("readPaymentChargeback"),
      readCartContents: notUsed("readCartContents"),
      readOrderHistory: notUsed("readOrderHistory"),
      readPaymentHistory: notUsed("readPaymentHistory"),
      // The provable-empty enumerations: a staff principal owns no customer orders,
      // payments or reservations. Present-with-count-0 is the honest answer and keeps
      // the §O#15 completeness gate from force-requiring an order companion.
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

/** The VALIDATED STORE_OPEN_NOW render (slot-grammar template × the pt-BR enum label). */
const OPEN_RENDER = "No momento, o período de funcionamento é: jantar.";
const CLOSED_RENDER = "No momento, o período de funcionamento é: fechado.";
/** The proposition-free abstain every degraded claims turn renders. */
const SAFE_UNKNOWN = "Não localizei essa informação confirmada agora. Quer que eu verifique?";
/** The prose a converged turn must NEVER deliver. */
const MODEL_PROSE = "Sim, estamos abertos e funcionando normalmente!";

/**
 * A three-role scripted model. A converged ops turn makes up to THREE completions —
 * the INTENT planner (ops verb tools), the CLAIM planner (`propose_claim`), and the
 * responder (no tools) — so the harness's once-latch `scriptedModel` cannot serve it.
 * Dispatch is by tool surface, never by call order.
 */
function claimsScriptedModel(opts: {
  /** Tool calls the INTENT planner emits (default: none → an empty plan). */
  readonly intentCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  /** The claim `type`/`subject` the CLAIM planner tags (omit → tags nothing). */
  readonly claim?: { readonly type: string; readonly subject: string };
  /** The responder's prose draft. */
  readonly responderText?: string;
}): ModelProvider & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    const toolNames = (req.tools ?? []).map((t) => t.name);
    const base = { model: "mock", stopReason: "end_turn", inputTokens: 5, outputTokens: 4 } as const;
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

function buildDeps(model: ModelProvider): {
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
      // A pass-through resolver: each envelope keeps its payload, with an empty
      // per-envelope SystemState. The resolution logic is not what this suite
      // proves (ops-resolver.test.ts owns it) — the envelope ACTOR is.
      buildResolver: () => ({
        resolve: async ({ plan }: { plan: { envelopes: readonly unknown[] } }) =>
          plan.envelopes.map((envelope) => ({ envelope, state: {} })),
      }),
    }),
  };
}

describe("ops plane — store-open-now renders from claims (LE2 decision 6)", () => {
  beforeEach(() => {
    process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
    scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
    scheduleBackend.scheduleThrows = false;
  });

  it("OPEN: 'estamos abertos?' is answered from the VALIDATED claim, never model prose", async () => {
    const model = claimsScriptedModel({
      claim: { type: "STORE_OPEN_NOW", subject: "loja" },
    });
    const { deps } = buildDeps(model);

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "estamos abertos?",
    });

    expect(out.response).toBe(OPEN_RENDER);
    // The whole point: the model's confident prose never reaches the operator.
    expect(out.response).not.toContain(MODEL_PROSE);
    expect(out.response).not.toBe(SAFE_UNKNOWN);
  });

  it("CLOSED: the same seam renders the CLOSED period — the render tracks the read", async () => {
    scheduleBackend.signal = { isClosed: true, mealPeriod: "closed" };
    const model = claimsScriptedModel({
      claim: { type: "STORE_OPEN_NOW", subject: "loja" },
      // The model would still cheerfully assert the store is open.
      responderText: MODEL_PROSE,
    });
    const { deps } = buildDeps(model);

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "estamos abertos agora?",
    });

    expect(out.response).toBe(CLOSED_RENDER);
    expect(out.response).not.toContain("abertos");
  });

  it("UNKNOWN: an ERRORED schedule read degrades honestly — no store-state assertion", async () => {
    scheduleBackend.scheduleThrows = true;
    const model = claimsScriptedModel({
      claim: { type: "STORE_OPEN_NOW", subject: "loja" },
      responderText: MODEL_PROSE,
    });
    const { deps } = buildDeps(model);

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "estamos abertos?",
    });

    expect(out.response).toBe(SAFE_UNKNOWN);
    // Inv 6 / registry §5: a safe terminal asserts NOTHING about the world.
    expect(out.response).not.toContain("período de funcionamento");
    expect(out.response).not.toContain(MODEL_PROSE);
  });

  it("UNKNOWN (empty data): a claims-less factual turn still degrades via safeUnknown", async () => {
    // The 4B tags NO claim → the empty candidate set collapses BEFORE the kernel
    // (`claims` undefined ⇒ no render), so the responder's own BKL-078 gate is the
    // net. This is the ops responder gate the ticket requires to be ACTIVE.
    const model = claimsScriptedModel({ responderText: MODEL_PROSE });
    const { deps } = buildDeps(model);

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "estamos abertos?",
    });

    expect(out.response).toBe(SAFE_UNKNOWN);
    expect(out.response).not.toContain(MODEL_PROSE);
  });

  it("SMALL TALK is unaffected: the natural prose path survives convergence", async () => {
    const model = claimsScriptedModel({ responderText: "Bom dia! Tudo certo por aqui." });
    const { deps } = buildDeps(model);

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "bom dia!",
    });

    expect(out.response).toBe("Bom dia! Tudo certo por aqui.");
    expect(out.response).not.toBe(SAFE_UNKNOWN);
  });

  it("STAFF-ACTOR envelope stamping is preserved exactly under the converged wiring", async () => {
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
    const { deps, sink } = buildDeps(model);

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

  it("FLAG OFF: the ops plane keeps its prior raw-prose behaviour exactly", async () => {
    delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    const model = claimsScriptedModel({
      claim: { type: "STORE_OPEN_NOW", subject: "loja" },
      responderText: MODEL_PROSE,
    });
    const { deps } = buildDeps(model);

    const out = await runOpsTurn(deps, {
      role: "OWNER",
      staffId: "owner1",
      text: "estamos abertos?",
    });

    // No seams, no gate → the pre-LE2 fall-through: the model's prose IS the reply.
    expect(out.response).toBe(MODEL_PROSE);
    // …and the claim planner was never consulted (only intent + responder ran).
    const claimCalls = model.complete.mock.calls.filter(
      (call: unknown[]) =>
        ((call[0] as CompletionRequest).tools ?? []).some(
          (t) => t.name === PROPOSE_CLAIM_TOOL,
        ),
    );
    expect(claimCalls).toHaveLength(0);
  });
});
