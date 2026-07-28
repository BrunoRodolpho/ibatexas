// ops-prose-retirement — LE2-013: THE TURN-SEAM PROOF THAT THE HOLE IS CLOSED.
//
// This is the ticket that heals the original incident. The spec's Testing
// Decisions name the TURN SEAM as the primary seam ("drive an utterance in and
// assert on what comes out"), so this suite drives a REAL ops `handleTurn` through
// the REAL `composeOpsConductor` (shared ops e2e harness — real composed router,
// real kernel, real ops tool registry, real system channel) and asserts the
// DELIVERED REPLY, never a pipeline internal.
//
// What is faked: the ModelProvider (scripted), the claims pipeline's ONE external
// IO boundary (`createDomainTriadReadBackend`), and the delivery-coverage
// RESOLVER seam (`resolveDeliveryCoverage` — the same single mock point
// `delivery-coverage-claim.test.ts` uses, which keeps the real pt-BR composers so
// the asserted scalar is the real one). The investigator, claim planner, claims
// kernel, render-from-claims renderer, precedence lattice, safe-unknown gate,
// digit clamp, responder and conductor are all PRODUCTION code.
//
// COVERAGE (ticket 13's acceptance criteria):
//   1. THE HOLE — an information-bearing empty-plan turn with NO question marker
//      (the exact class LE2-011's positive net MISSED) renders safe-unknown. Model
//      prose cannot ship from the empty-plan factual path at all.
//   2. THE DEMO — "vocês entregam em Ibaté?" on the OPS thread renders the
//      GROUNDED coverage answer in staff voice, and degrades honestly when the
//      zone read is unreadable.
//   3. SMALL TALK stays natural (decision 6's deliberate carve-out).
//   4. THE CLAMP still fires BENEATH the gate on the surviving small-talk branch
//      (belt-and-suspenders, retained — explicitly no longer the primary defense).
//   5. STAFF-ACTOR envelope stamping survives the retirement.
//   6. FLAG DISCIPLINE — ENABLE_CLAIMS_PIPELINE off ⇒ prior behaviour, byte for
//      byte. The retirement is part of the claims convergence, exactly matching
//      LE2-011's flag posture (the gate dep is composed only when the flag is on).
//
// NOT COVERED HERE, and deliberately so: the ops REFUSE-with-a-plan conversational
// recovery branch (`conversationalRefusal`) still authors prose for a kernel-refused
// COMMAND. That is a refusal explanation on a NON-empty plan, not the empty-plan
// factual path this ticket scopes, and it stays digit-clamped. Left visible.
//
// UPDATE — that residual became BKL-262, and it was worse than "left visible": on a
// MIS-PARSED question the branch shipped fabricated FACTS (live-measured twice). Its
// RANKING half is now closed by lattice rule 2a and pinned by
// `ops-write-twin-rescue.e2e.test.ts` — a refused WRITE that is the declared twin of
// the read actually asked no longer suppresses the validated answer. The branch itself
// still authors prose for a GENUINE refused command; making that synthesis grounded is
// BKL-262 Stage 2 and remains open.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../../claustrum/claims-pipeline.js";
import { OPS_UNGROUNDED_CLAMP_PTBR } from "../ops-read-render.js";
import type { DeliveryCoverageResolution } from "../../claustrum/delivery-coverage-resolver.js";

// ── Mock 1: the claims pipeline's read backend (no DB/network) ─────────────────
const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: { signal: { isClosed: false, mealPeriod: "dinner" } as unknown },
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
      readSchedule: async () => scheduleBackend.signal,
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
      // A staff principal owns no customer orders/payments/reservations —
      // provable-empty is the honest answer and keeps §O#15 from forcing a
      // customer companion onto a staff turn.
      listActiveOrderIds: async () => [],
      listActiveReservationIds: async () => [],
      countActivePayments: async () => 0,
    }),
  };
});

// ── Mock 2: the delivery-coverage RESOLVER seam ────────────────────────────────
// Only `resolveDeliveryCoverage` is replaced; `composeDeliveryCoverageText` and the
// rest stay REAL, so the scalar this suite asserts is the production one.
vi.mock("../../claustrum/delivery-coverage-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../claustrum/delivery-coverage-resolver.js")>();
  return { ...actual, resolveDeliveryCoverage: vi.fn() };
});

const { resolveDeliveryCoverage, composeDeliveryCoverageText } = await import(
  "../../claustrum/delivery-coverage-resolver.js"
);

const {
  buildOpsTools,
  composeOpsDeps,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulSession,
  runOpsTurn,
} = await import("./ops-e2e-harness.js");

/** The proposition-free abstain every degraded ops turn renders. */
const SAFE_UNKNOWN = "Não localizei essa informação confirmada agora. Quer que eu verifique?";

/** The live zone row behind the Ibaté demo (integer centavos — Hard Rule 2). */
const IBATE_ZONE = { zoneName: "Ibaté", feeInCentavos: 1500, estimatedMinutes: 50 };

/** The GROUNDED coverage resolution the resolver returns for the Ibaté turn. */
const IBATE_COVERED: DeliveryCoverageResolution = {
  kind: "covered",
  coverageText: composeDeliveryCoverageText(IBATE_ZONE),
  ...IBATE_ZONE,
};

/**
 * THE OPS RENDER, verbatim: the grounded scalar in a STAFF frame. The customer
 * template appends "Confirmo certinho pelo endereço no checkout." — what the system
 * does at THE CUSTOMER'S checkout, a non-sequitur voiced at the operator who runs
 * it (the `closedHoursOffer: false` precedent, see OPS_PLANE_TEMPLATE_OVERRIDES).
 */
const OPS_IBATE_RENDER =
  "Sim, entregamos em Ibaté — taxa de R$ 15,00 e prazo estimado de cerca de 50 minutos.";

/** The customer-voiced frame that must NEVER reach a staff member. */
const CUSTOMER_CHECKOUT_CAVEAT = "Confirmo certinho pelo endereço no checkout.";

/** The prose a converged ops turn must NEVER deliver. */
const MODEL_PROSE = "Sim, entregamos em Ibaté sem problema nenhum!";

/**
 * A three-role scripted model (the ops-store-open-claims idiom, extended to tag a
 * SET of claims — the delivery pair is complementary, so both members are proposed
 * and the kernel validates whichever the zone read licenses). Dispatch is by tool
 * surface, never by call order.
 */
function claimsScriptedModel(opts: {
  readonly intentCalls?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  readonly claims?: ReadonlyArray<{ readonly type: string; readonly subject: string }>;
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
        toolCalls: (opts.claims ?? []).map((claim, i) => ({
          id: `claim-${i}`,
          name: PROPOSE_CLAIM_TOOL,
          input: { ...claim },
        })),
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
      buildResolver: () => ({
        resolve: async ({ plan }: { plan: { envelopes: readonly unknown[] } }) =>
          plan.envelopes.map((envelope) => ({ envelope, state: {} })),
      }),
    }),
  };
}

/** Drive one ops turn as the OWNER. */
async function drive(model: ModelProvider, text: string) {
  const { deps, sink } = buildDeps(model);
  const out = await runOpsTurn(deps, { role: "OWNER", staffId: "owner1", text });
  return { out, sink };
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  vi.mocked(resolveDeliveryCoverage).mockReset();
  vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
});

// ── 1. THE HOLE CLOSES ───────────────────────────────────────────────────────

describe("LE2-013 — the empty-plan FACTUAL path can never ship model prose", () => {
  /**
   * THE RESIDUAL HOLE, NAMED. Each of these is information-bearing and carries NO
   * '?', no WH word, no polar/modal opener — so LE2-011's POSITIVE net
   * (`hasInfoQuestion`) did not recognise it, the gate stayed shut, and the
   * conversational completion shipped. The digit clamp beneath it only demotes
   * ungrounded NUMBERS, so a digit-free invention delivered clean to the operator.
   */
  const UNRECOGNISED_INFO_TURNS: readonly string[] = [
    "me passa o resumo do fornecedor",
    "preciso saber do combinado com o fornecedor de ontem",
    "o pessoal da cozinha comentou sobre a entrega de amanhã",
    "confirma a situação da geladeira nova",
  ];

  for (const text of UNRECOGNISED_INFO_TURNS) {
    it(`renders SAFE-UNKNOWN for an unmarked info turn: "${text}"`, async () => {
      const model = claimsScriptedModel({
        // A confident, DIGIT-FREE invention — invisible to clampUngroundedOpsFact.
        responderText: "O fornecedor confirmou tudo e a entrega chega amanhã cedo.",
      });
      const { out } = await drive(model, text);

      expect(out.response).toBe(SAFE_UNKNOWN);
      expect(out.response).not.toContain("fornecedor");
      expect(out.response).not.toContain("amanhã");
    });
  }

  it("the model was never even asked to author a reply on the retired path", async () => {
    // The gate returns BEFORE any responder completion — so on a retired turn the
    // model makes the planner calls only. This is what makes "no prose can ship"
    // structural rather than a post-hoc filter.
    const model = claimsScriptedModel({ responderText: "prosa inventada" });
    await drive(model, "me passa o resumo do fornecedor");

    const responderCalls = model.complete.mock.calls.filter(
      (call: unknown[]) => ((call[0] as CompletionRequest).tools ?? []).length === 0,
    );
    expect(responderCalls).toHaveLength(0);
  });

  it("a recognised question still degrades (LE2-011's behaviour is preserved, not replaced)", async () => {
    const model = claimsScriptedModel({ responderText: MODEL_PROSE });
    const { out } = await drive(model, "qual foi o combinado com o fornecedor?");
    expect(out.response).toBe(SAFE_UNKNOWN);
  });
});

// ── 2. THE DEMO — the Ibaté turn on the ops thread ───────────────────────────

describe("LE2-013 — 'vocês entregam em Ibaté?' on the OPS thread (the original incident, healed)", () => {
  it("renders the GROUNDED coverage answer from ticket 02's claim, in STAFF voice", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(IBATE_COVERED);
    const model = claimsScriptedModel({
      claims: [
        { type: "DELIVERY_COVERAGE", subject: "" },
        { type: "DELIVERY_NO_COVERAGE", subject: "" },
      ],
      responderText: MODEL_PROSE,
    });

    const { out } = await drive(model, "vocês entregam em Ibaté?");

    // The fee and the ETA come from the zones projection, through the C6
    // value-binding — the model authored neither.
    expect(out.response).toBe(OPS_IBATE_RENDER);
    expect(out.response).toContain("R$ 15,00");
    expect(out.response).toContain("50 minutos");
    // The ungrounded prose that shipped on 2026-07-20 never reaches the operator.
    expect(out.response).not.toBe(MODEL_PROSE);
    // …and neither does the CUSTOMER frame (the plane-scoped phrasing decision).
    expect(out.response).not.toContain(CUSTOMER_CHECKOUT_CAVEAT);
  });

  it("an UNREADABLE zone projection degrades to the honest unknown — never a coverage claim", async () => {
    // Inv 7: "could not check" is a DISTINCT state from "we don't deliver", and it
    // must never render as either direction.
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({ kind: "unknown" });
    const model = claimsScriptedModel({
      claims: [
        { type: "DELIVERY_COVERAGE", subject: "" },
        { type: "DELIVERY_NO_COVERAGE", subject: "" },
      ],
      responderText: MODEL_PROSE,
    });

    const { out } = await drive(model, "vocês entregam em Ibaté?");

    expect(out.response).toBe(SAFE_UNKNOWN);
    expect(out.response).not.toContain("entregamos");
    expect(out.response).not.toContain("R$");
  });

  it("a POSITIVE out-of-zone determination renders the validated NEGATIVE, staff-framed", async () => {
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue({
      kind: "not_covered",
      noCoverageText: "Ainda não entregamos no CEP 01001-000",
    });
    const model = claimsScriptedModel({
      claims: [
        { type: "DELIVERY_COVERAGE", subject: "" },
        { type: "DELIVERY_NO_COVERAGE", subject: "" },
      ],
      responderText: MODEL_PROSE,
    });

    const { out } = await drive(model, "vocês entregam no CEP 01001000?");

    expect(out.response).toBe("Ainda não entregamos no CEP 01001-000.");
    // The customer's pickup offer is a non-sequitur voiced at the restaurant's staff.
    expect(out.response).not.toContain("retirar aqui no restaurante");
  });
});

// ── 3. SMALL TALK ────────────────────────────────────────────────────────────

describe("LE2-013 — small talk is the ONLY surviving raw-prose path", () => {
  const SMALL_TALK: readonly string[] = ["bom dia!", "oi, tudo bem?", "valeu, obrigado!", "beleza"];

  for (const text of SMALL_TALK) {
    it(`stays natural: "${text}"`, async () => {
      const model = claimsScriptedModel({ responderText: "Bom dia! Tudo certo por aqui." });
      const { out } = await drive(model, text);

      expect(out.response).toBe("Bom dia! Tudo certo por aqui.");
      expect(out.response).not.toBe(SAFE_UNKNOWN);
    });
  }
});

// ── 4. THE CLAMP, BENEATH THE GATE ───────────────────────────────────────────

describe("LE2-013 — the digit clamp is RETAINED beneath the gate (belt-and-suspenders)", () => {
  it("fires on the surviving small-talk branch when the model volunteers a figure", async () => {
    // THE CRAFTED PATH: the user says something purely phatic, so the gate lets the
    // turn through to prose — and the model volunteers an ungrounded domain number
    // anyway (its habitual trailing-engagement register). The clamp catches it.
    // This is now the clamp's JOB: it is explicitly no longer the primary defense
    // against invention (the gate is), it is the guard on what the gate lets pass.
    const model = claimsScriptedModel({
      responderText: "Beleza! Hoje tivemos 12 pedidos e o caixa fechou em R$ 4.350,00.",
    });
    const { out } = await drive(model, "beleza, valeu");

    expect(out.response).toBe(OPS_UNGROUNDED_CLAMP_PTBR);
    expect(out.response).not.toContain("12");
    expect(out.response).not.toContain("4.350");
  });

  it("does NOT clamp a smalltalk reply that states no domain figure (demote-only)", async () => {
    const model = claimsScriptedModel({ responderText: "Valeu! Qualquer coisa é só chamar." });
    const { out } = await drive(model, "valeu, obrigado!");
    expect(out.response).toBe("Valeu! Qualquer coisa é só chamar.");
  });

  it("the gate runs FIRST: on a factual turn the clamp is never reached", async () => {
    // A figure-bearing draft on a RETIRED turn does not produce the clamp nudge —
    // it produces the safe-unknown render, because the gate returned before the
    // model was ever asked. Proves the ordering, not just the outcome.
    const model = claimsScriptedModel({
      responderText: "Hoje tivemos 12 pedidos.",
    });
    const { out } = await drive(model, "me passa o total de ontem");

    expect(out.response).toBe(SAFE_UNKNOWN);
    expect(out.response).not.toBe(OPS_UNGROUNDED_CLAMP_PTBR);
  });
});

// ── 5. THE STAFF-ACTOR SEAM ──────────────────────────────────────────────────

describe("LE2-013 — the staff-actor envelope seam survives the retirement", () => {
  it("still stamps admin:<staffId> + role on a governed mutation", async () => {
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
    const { sink } = await drive(model, "marca o brisket como esgotado");

    const record = sink.byKind("product.availability.set")[0];
    expect(record).toBeDefined();
    expect(record!.envelope.actor.principal).toBe("user");
    expect(record!.envelope.actor.sessionId).toBe("admin:owner1");
    expect(record!.envelope.actor.role).toBe("OWNER");
  });
});

// ── 6. FLAG DISCIPLINE ───────────────────────────────────────────────────────

describe("LE2-013 — flag posture: the retirement rides the claims convergence", () => {
  // MATCHING LE2-011 EXACTLY: `safeUnknown` is composed onto the ops responder ONLY
  // when `claimsPipelineEnabled()`, so with the flag OFF the dep is absent and the
  // responder's gate block is skipped entirely. The retirement is therefore NOT an
  // unconditional change — it is part of the claims convergence, and flag-OFF is
  // byte-identical to the pre-LE2 ops responder.
  it("FLAG OFF: an unmarked info turn keeps the prior raw-prose behaviour", async () => {
    delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    const model = claimsScriptedModel({
      responderText: "O fornecedor confirmou tudo e a entrega chega amanhã cedo.",
    });
    const { out } = await drive(model, "me passa o resumo do fornecedor");

    expect(out.response).toBe("O fornecedor confirmou tudo e a entrega chega amanhã cedo.");
    expect(out.response).not.toBe(SAFE_UNKNOWN);
  });

  it("FLAG OFF: the Ibaté turn falls back to prose (no seams, no claim planner)", async () => {
    delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    vi.mocked(resolveDeliveryCoverage).mockResolvedValue(IBATE_COVERED);
    const model = claimsScriptedModel({
      claims: [{ type: "DELIVERY_COVERAGE", subject: "" }],
      responderText: MODEL_PROSE,
    });
    const { out } = await drive(model, "vocês entregam em Ibaté?");

    expect(out.response).toBe(MODEL_PROSE);
    const claimCalls = model.complete.mock.calls.filter(
      (call: unknown[]) =>
        ((call[0] as CompletionRequest).tools ?? []).some((t) => t.name === PROPOSE_CLAIM_TOOL),
    );
    expect(claimCalls).toHaveLength(0);
  });

  it("FLAG OFF: the digit clamp still fires (it never depended on the flag)", async () => {
    delete process.env[CLAIMS_PIPELINE_ENABLED_ENV];
    const model = claimsScriptedModel({ responderText: "Hoje tivemos 12 pedidos." });
    const { out } = await drive(model, "me passa o total de ontem");
    expect(out.response).toBe(OPS_UNGROUNDED_CLAMP_PTBR);
  });

  it("a literal non-'true' flag value is treated as OFF", async () => {
    process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "1";
    const model = claimsScriptedModel({ responderText: "prosa livre" });
    const { out } = await drive(model, "me passa o resumo do fornecedor");
    expect(out.response).toBe("prosa livre");
  });
});
