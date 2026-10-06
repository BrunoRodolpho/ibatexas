// BKL-276 — a funnel STAMP must not silence the claims plane.
//
// THE DEFECT. `proposeClaims` skipped the whole claim plane whenever the turn
// carried ANY funnel stage record (`deps.funnel?.stageFor(turnId) !== undefined`).
// The comment above it said L0 — but L2's `stampScope` writes the SAME per-turn map
// on EVERY turn it scopes, and production wires ONE `createParseFunnel()` instance as
// both `funnel` and `scopeSeam` the moment `OLLAMA_EMBED_URL`/`OLLAMA_EMBED_MODEL`
// are configured (read at the composition root — apps/api/src/index.ts — and passed
// to bootstrapClaustrum as an injected embedder port since BKL-283; before that the
// library read them itself, so ANY process with the pair got a retriever).
// So with the ratified local embedder on —
// the funnel's PRIMARY path — every L2 turn silently skipped `proposeClaims`, the
// `propose_claim` tool never reached the wire, and a grounded read question
// ("qual o horário de funcionamento?") degraded to a REFUSE.
//
// WHY NO SUITE CAUGHT IT. Until this file, NO test in the repo composed the claims
// plane and the funnel TOGETHER: the claims suites (customer-hours-claims,
// menu-diet-guard, pairings) wire `withClaims: true` and no funnel; the funnel suites
// (l0-social-short-circuit, chat-l1-parse-memo, l2-scoped-parse) wire a funnel and no
// claims. Each plane was green in isolation while their INTERACTION was the defect —
// so this suite's whole job is to hold the two planes composed.
//
// Real customer `handleTurn` through `composeCustomerConductor`. The retriever is the
// REAL `createCapabilityRetriever` over a deterministic fake embedder (no engine, no
// network): only the vectors are synthetic, the scope decision and the L2 stamp are
// the production ones.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Completion, CompletionRequest, ModelProvider, TelemetryPort } from "@claustrum/core";
import { PROPOSE_CLAIM_TOOL } from "../claustrum/ibatexas-planner.js";
import { CLAIMS_PIPELINE_ENABLED_ENV } from "../claustrum/claims-pipeline.js";
import {
  createL0Funnel,
  createParseFunnel,
  funnelStage,
  renderL0Reply,
} from "../claustrum/funnel-tier.js";
import { createCapabilityRetriever } from "../claustrum/capability-retrieval.js";
import type {
  HolidayRead,
  ScheduleRead,
  StoreHoursRead,
} from "../claustrum/turn-reads.js";

const { scheduleBackend } = vi.hoisted(() => ({
  scheduleBackend: {
    signal: { isClosed: false, mealPeriod: "dinner" } as ScheduleRead,
    hours: { hoursText: "11h–15h / 18h–23h" } as StoreHoursRead,
    holiday: null as HolidayRead | null,
  },
}));

vi.mock("../claustrum/turn-reads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claustrum/turn-reads.js")>();
  const { buildTriadReadBackend } = await import(
    "./helpers/triad-backend-builder.js"
  );
  return {
    ...actual,
    createDomainTriadReadBackend: () =>
      buildTriadReadBackend({
        readSchedule: async () => scheduleBackend.signal,
        readScheduleOverride: async () => null,
        readStoreHours: async () => scheduleBackend.hours,
        readHoliday: async () => scheduleBackend.holiday,
        readHoursForDate: async () => ({ hoursText: "11h–15h / 18h–23h" }),
        readHolidayForDate: async () => null,
        readScheduleOverrideForDate: async () => null,
        // A guest asking about hours owns nothing; present-with-0 keeps §O#15 from
        // force-requiring an order companion.
        listActiveOrderIds: async () => [],
        listActiveReservationIds: async () => [],
        countActivePayments: async () => 0,
      }),
  };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeStatefulCustomerSession,
  runCustomerTurn,
} = await import("./customer-e2e-harness.js");

const HOURS_ASK = "qual o horário de funcionamento?";
const HOURS_RENDER = "Hoje nosso horário de funcionamento é: 11h–15h / 18h–23h.";
const OPEN_RENDER = "No momento, o período de funcionamento é: jantar.";

/** The schedule cluster BKL-234 pinned — a read that ONLY the claims plane can answer. */
const HOURS_CLAIMS = [
  { type: "STORE_HOURS", subject: "loja" },
  { type: "STORE_OPEN_NOW", subject: "loja" },
];

/**
 * Deterministic stand-in for nomic-embed-text: a stable unit-ish vector per text.
 * The retriever, its margin arithmetic and the L2 decision are all REAL — faking the
 * outermost client keeps the test off the engine and off the network while still
 * driving `stampScope`, which is the only thing this suite needs from L2.
 */
function deterministicEmbedder() {
  return {
    embed: async (text: string): Promise<readonly number[]> => {
      const vec = new Array<number>(32).fill(0.01);
      let h = 0;
      for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 997;
      vec[h % 32] = 1;
      return vec;
    },
  };
}

/** Serves the claim planner the claims under test; the intent leg proposes nothing. */
function claimsScriptedModel(
  claims: ReadonlyArray<{ readonly type: string; readonly subject: string }>,
): ModelProvider {
  return {
    complete: vi.fn(async (req: CompletionRequest): Promise<Completion> => {
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
          toolCalls: claims.map((c, i) => ({
            id: `claim-${i}`,
            name: PROPOSE_CLAIM_TOOL,
            input: { ...c },
          })),
        };
      }
      return { ...base, text: "ok (mock planner pass — nothing to propose)", toolCalls: [] };
    }),
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  } as unknown as ModelProvider;
}

/** Did the `propose_claim` tool ever reach the wire? The direct claim-plane probe:
 *  a short-circuited `proposeClaims` returns before ever building this surface. */
function claimToolOffered(model: ModelProvider): boolean {
  const complete = model.complete as unknown as { mock: { calls: Array<[CompletionRequest]> } };
  return complete.mock.calls.some((c) =>
    (c[0].tools ?? []).some((t) => t.name === PROPOSE_CLAIM_TOOL),
  );
}

let seq = 0;

interface TurnOutcome {
  readonly response: string;
  readonly tier: string | undefined;
  readonly reason: string | undefined;
  readonly claimToolOffered: boolean;
}

/**
 * ONE composition knob: `wireRetriever`. Everything else is held byte-identical, so a
 * difference between the two runs can only be the L2 stamp.
 */
async function runTurn(opts: {
  readonly text: string;
  readonly wireRetriever: boolean;
  readonly social?: boolean;
}): Promise<TurnOutcome> {
  seq += 1;
  const model = claimsScriptedModel(HOURS_CLAIMS);
  let tier: string | undefined;
  let reason: string | undefined;
  const telemetry: TelemetryPort = {
    emitTurn: async (record) => {
      const stage = funnelStage(record.turnId);
      tier = stage?.tier;
      reason = stage?.reason;
    },
    emitLLMTrace: async () => {},
    emitMemoryAccess: async () => {},
  };

  // L0 needs the social decision seam (`createL0Funnel`); L2 needs the scope seam
  // (`createParseFunnel`, which is what production composes). Kept as two distinctly
  // typed locals because only the latter carries `stampScope`.
  const socialFunnel = opts.social ? createL0Funnel() : undefined;
  const parseFunnel = opts.wireRetriever ? createParseFunnel() : undefined;

  const harness = composeCustomerConductor({
    model,
    session: makeStatefulCustomerSession(),
    adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
    withClaims: true,
    telemetry,
    ...(socialFunnel ? { funnel: socialFunnel, realResponder: true } : {}),
    ...(parseFunnel
      ? {
          // Exactly production's shape: ONE instance is both the planner's funnel
          // seam and its scope seam (claustrum-bootstrap.ts).
          funnel: parseFunnel,
          retriever: createCapabilityRetriever({ embedder: deterministicEmbedder() }),
          scopeSeam: parseFunnel,
        }
      : {}),
  });

  const out = await runCustomerTurn(harness, {
    customerId: `cust-276-${seq}`,
    conversationId: `conv-276-${seq}`,
    text: opts.text,
  });

  return { response: out.response, tier, reason, claimToolOffered: claimToolOffered(model) };
}

beforeEach(() => {
  process.env[CLAIMS_PIPELINE_ENABLED_ENV] = "true";
  scheduleBackend.signal = { isClosed: false, mealPeriod: "dinner" };
  scheduleBackend.hours = { hoursText: "11h–15h / 18h–23h" };
  scheduleBackend.holiday = null;
});

describe("BKL-276 — an L2 stamp must not silence the claims plane", () => {
  // THE REGRESSION. Before the fix this rendered "decision=REFUSE acted=refused"
  // with `propose_claim` never offered.
  it("a READ turn stamped L2 still resolves and renders its claims", async () => {
    const out = await runTurn({ text: HOURS_ASK, wireRetriever: true });

    // The turn really was stamped by L2 — otherwise this asserts nothing.
    expect(out.tier).toBe("L2");
    // The claim plane genuinely ran: the tool reached the wire…
    expect(out.claimToolOffered).toBe(true);
    // …and the customer got the VALIDATED render, not a refusal.
    expect(out.response).toContain(HOURS_RENDER);
    expect(out.response).toContain(OPEN_RENDER);
  });

  // The differential the defect was found by: the ONLY difference is the retriever.
  it("the retriever-wired reply is BYTE-IDENTICAL to the retriever-less one", async () => {
    const retrieverLess = await runTurn({ text: HOURS_ASK, wireRetriever: false });
    const retrieverWired = await runTurn({ text: HOURS_ASK, wireRetriever: true });

    // Control: no retriever ⇒ no stamp at all (the composition every claims suite
    // and the BKL-270 audit used — which is why they never saw the suppression).
    expect(retrieverLess.tier).toBeUndefined();
    expect(retrieverWired.tier).toBe("L2");

    // Configuring an embedder must not change what the customer is told.
    expect(retrieverWired.response).toBe(retrieverLess.response);
    expect(retrieverLess.claimToolOffered).toBe(true);
    expect(retrieverWired.claimToolOffered).toBe(true);
  });

  // CONTROL — the tier the short-circuit genuinely exists for. L0 answers from its
  // own template with zero model calls, so the claim plane must still be skipped
  // (BKL-110: an over-proposed claim used to clobber the greeting). Note this is
  // ALSO the first test to drive L0 with the claims plane actually wired — the
  // pre-existing l0-social-short-circuit suite wires no claims, so its
  // "the claim path stays off the wire" clause was vacuous.
  it("CONTROL: an L0 social turn still short-circuits the claim plane", async () => {
    const out = await runTurn({ text: "Oi", wireRetriever: false, social: true });

    expect(out.tier).toBe("L0");
    expect(out.reason).toBe("social_only");
    // The whole point of the tier: no claim completion for a turn already answered.
    expect(out.claimToolOffered).toBe(false);
    expect(out.response).toBe(renderL0Reply("greeting"));
  });
});
