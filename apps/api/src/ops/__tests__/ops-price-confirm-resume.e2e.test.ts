// ops-price-confirm-resume — the NEW-004 crown-jewel proof: price-change-by-
// message driven END-TO-END through composeOpsConductor + a full handleTurn
// against the REAL composed policy router + REAL audited kernel
// (adjudicateAndAudit) with a STATEFUL session store + the REAL OpsSystemChannel
// matchToParked driver. No DB/network — the model, the pricing reads, and the
// Medusa price egress are fakes/spies.
//
// Proves the whole confirm-gated flow:
//   - OWNER "muda o preço da picanha pra 95": NAME resolved → pricing projected
//     → UNTRUSTED taint CONFIRM overlay → REQUEST_CONFIRMATION → PARKED (asserted
//     in the session store) → the reply carries the product name + old→new BRL.
//   - "sim, confirma" → matchToParked confirm → resume (re-project the pricing
//     state via buildOpsPriceResumeState, re-adjudicate the parked envelope, the
//     receipt flips CONFIRM→EXECUTE) → medusaAdjudicated called ONCE with the
//     EXACT price egress (every BRL variant → 95 reais); the park is cleared.
//   - "não" → deny → unparked, the egress NEVER runs.
//   - ATTENDANT → REFUSE staff_role_violation; nothing parks.
//   - an absurd price → REFUSE (out_of_range); nothing parks.

import { describe, expect, it, vi } from "vitest";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";
import {
  buildEnvelope,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
  type Completion,
  type CompletionRequest,
  type DeferredEnvelope,
  type ModelProvider,
  type ParkedEnvelope,
  type Session,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
} from "@claustrum/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../../claustrum/compose-policy-packs.js";
import { composePolicyRouter } from "../../claustrum/capability-policy.js";
import {
  noopMemoryProvider,
  noopGroundingProvider,
} from "../../claustrum/noop-memory-grounding.js";
import { composeOpsConductor } from "../ops-conductor.js";
import { createOpsToolRegistry } from "../ops-tool-registry.js";
import {
  createOpsResolver,
  buildOpsPriceResumeState,
  type OpsResolverPriceProduct,
} from "../ops-resolver.js";
import { OpsSystemChannel } from "../ops-system-channel.js";

const ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

const noopSink = { emit: async () => {} } as unknown as AuditSink;

/** A single-variant, uniform-price product (the pricing snapshot the resolver +
 *  resume project, and whose variant the executor re-prices). Current R$89,00. */
const PICANHA: OpsResolverPriceProduct = {
  id: "prod_picanha",
  status: "published",
  name: "Picanha",
  currentPriceCentavos: 8900,
  divergentVariantPrices: false,
};

/** pricing-by-id used by BOTH the plan-stage lookup and the resume re-projection. */
const pricingById = (id: string): OpsResolverPriceProduct | null =>
  id === "prod_picanha" ? PICANHA : null;

// ── A REAL audited adjudicator over the composed router ──────────────────────
function makeAdjudicator(): Adjudicator {
  const adj: Adjudicator = {
    adjudicate: async (envelope, state, policy) =>
      (
        await adjudicateAndAudit(
          envelope as IntentEnvelope,
          state as never,
          policy as never,
          { sink: noopSink },
        )
      ).decision,
    adjudicatePlan: async (envelopes, state, policy, perStates) => {
      const env = envelopes[0] as IntentEnvelope | undefined;
      if (env === undefined) {
        return (
          await adjudicateAndAudit(
            buildEnvelope({
              kind: "noop",
              payload: {},
              actor: { principal: "system", sessionId: "system:x" },
              taint: "SYSTEM",
              nonce: "n",
            }) as IntentEnvelope,
            state as never,
            policy as never,
            { sink: noopSink },
          )
        ).decision;
      }
      return (
        await adjudicateAndAudit(
          env,
          (perStates?.[0] ?? state) as never,
          policy as never,
          { sink: noopSink },
        )
      ).decision;
    },
    // The production resume path (buildAdjudicator.resume → enrichResumeState)
    // for an admin: price change re-projects via buildOpsPriceResumeState. Mirror
    // it here: FRESH pricing read by the parked (rewritten) productId + receipt.
    resume: async (envelope, _state, policy, receipt) => {
      const env = envelope as IntentEnvelope;
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const productId =
        typeof payload.productId === "string" ? payload.productId : "";
      const staffId = env.actor.sessionId.slice("admin:".length);
      const opsState = buildOpsPriceResumeState(
        productId === "" ? null : pricingById(productId),
        { staffId, tenantId: "ibatexas" },
      );
      return (
        await adjudicateAndAudit(env, opsState as never, policy as never, {
          sink: noopSink,
          ...(receipt ? { confirmationReceipt: receipt } : {}),
        })
      ).decision;
    },
    replayEnvelopesByCustomerId: async () => [],
    streamAuditByIntentHashPrefix: async function* () {},
    getOutcomes: async () => [],
    verifyAuditRecord: () => ({ ok: true }),
  };
  return adj;
}

// ── A STATEFUL in-memory session store (park/load/unpark/parkDeferred persist) ─
function makeStatefulSession(): SessionPort & {
  parksFor: (sessionId: string) => ParkedEnvelope[];
  deferredFor: (sessionId: string) => DeferredEnvelope[];
} {
  const parks = new Map<string, ParkedEnvelope[]>();
  const deferred = new Map<string, DeferredEnvelope[]>();
  const sid = (customerId: string) => `system:${customerId}`;
  return {
    load: async (customerId) => {
      const id = sid(customerId);
      return {
        id,
        customerId,
        channel: "system",
        startedAt: "2026-07-04T00:00:00.000Z",
        lastActivityAt: "2026-07-04T00:00:00.000Z",
        pendingConfirmations: parks.get(id) ?? [],
        deferredEnvelopes: deferred.get(id) ?? [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
      } satisfies Session;
    },
    save: async () => {},
    parkPendingConfirmation: async (sessionId, envelope, confirmationToken, userPrompt) => {
      const list = parks.get(sessionId) ?? [];
      list.push({
        envelope: envelope as IntentEnvelope,
        confirmationToken,
        userPrompt,
        parkedAt: "2026-07-04T12:00:00.000Z",
      });
      parks.set(sessionId, list);
    },
    parkDeferred: async (sessionId, envelope, signal, deferUntil, timeoutMs) => {
      const list = deferred.get(sessionId) ?? [];
      list.push({
        envelope: envelope as IntentEnvelope,
        signal,
        deferUntil,
        timeoutMs,
        parkedAt: "2026-07-04T12:00:00.000Z",
      });
      deferred.set(sessionId, list);
    },
    unpark: async (sessionId, intentHash) => {
      parks.set(
        sessionId,
        (parks.get(sessionId) ?? []).filter((p) => p.envelope.intentHash !== intentHash),
      );
      deferred.set(
        sessionId,
        (deferred.get(sessionId) ?? []).filter((d) => d.envelope.intentHash !== intentHash),
      );
    },
    parksFor: (sessionId) => parks.get(sessionId) ?? [],
    deferredFor: (sessionId) => deferred.get(sessionId) ?? [],
  };
}

const noopTelemetry: TelemetryPort = {
  emitTurn: async () => {},
  emitLLMTrace: async () => {},
  emitMemoryAccess: async () => {},
};
const inMemoryLock: SessionLock = {
  acquire: async (key) => ({ key, release: async () => {} }),
};

/** Scripted model: planner call (tools present) → the express_intent tool call;
 *  responder call (no tools) → grounded text. Fires the tool call ONCE. */
function scriptedModel(
  plannerToolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): ModelProvider {
  let planned = false;
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    const isPlanner = (req.tools?.length ?? 0) > 0;
    const emit = isPlanner && !planned;
    if (emit) planned = true;
    return {
      model: "mock",
      stopReason: "end_turn",
      text: isPlanner ? "" : "Ok.",
      toolCalls: emit ? [...plannerToolCalls] : [],
      inputTokens: 5,
      outputTokens: 4,
    };
  });
  return {
    complete,
    stream: () => {
      throw new Error("stream unused");
    },
    embed: async () => {
      throw new Error("embed unused");
    },
  };
}

interface HarnessSpies {
  medusaAdjudicated: ReturnType<typeof vi.fn>;
  readProductBrlVariantIds: ReturnType<typeof vi.fn>;
}

function buildHarness(opts: {
  toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>;
}) {
  const session = makeStatefulSession();
  const spies: HarnessSpies = {
    medusaAdjudicated: vi.fn(async () => ({ product: { id: "prod_picanha" } })),
    readProductBrlVariantIds: vi.fn(async (id: string) =>
      id === "prod_picanha" ? ["var_picanha"] : null,
    ),
  };
  const tools = createOpsToolRegistry({
    medusaAdjudicated: spies.medusaAdjudicated as never,
    auditSink: noopSink as never,
    readProductBrlVariantIds: spies.readProductBrlVariantIds as never,
    orderCmdSvc: {
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition: vi.fn(),
    },
    publishOrderStatusChanged: vi.fn(),
    paymentCmdSvc: { writeAdjudicatedRefund: vi.fn() },
    publishPaymentStatusChanged: vi.fn(),
    appendRefundEventLog: vi.fn(),
    opsAlertSvc: { resolveAlertFromEnvelope: vi.fn(async () => ({ result: { status: "RESOLVED" } })) },
    incidentSvc: { closeIncidentFromEnvelope: vi.fn(async () => ({ result: { status: "RESOLVED" } })) },
  });
  const tenantResolver: TenantResolver = {
    resolve: async ({ channel, customerId }) => ({
      tenant: {
        tenantId: "ibatexas",
        displayName: "IbateXas",
        locale: "pt-BR",
        environment: "dev",
      },
      state: { channel, customerId },
      policy: ROUTER,
    }),
  };
  const deps = {
    adjudicator: makeAdjudicator(),
    memory: noopMemoryProvider(),
    grounding: noopGroundingProvider("mock"),
    explainer: { render: (r: { userFacing: string }) => r.userFacing },
    handoff: { queue: async () => {} },
    telemetry: noopTelemetry,
    session,
    tenantResolver,
    sessionLock: inMemoryLock,
    systemChannel: new OpsSystemChannel({
      gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
      gateway: "ibatexas-ops-test",
    }),
    tools,
    model: scriptedModel(opts.toolCalls),
    modelId: "mock",
    opsReadToolExecutors: {},
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async () => null,
        // Direct id pricing lookup by the resolved id hits; the raw name misses.
        lookupProductPricing: async (id) => pricingById(id),
        // The persona fills productId with the NAME; resolve it to prod_picanha.
        listProductsByName: async () => [
          { id: "prod_picanha", title: "Picanha", status: "published" },
        ],
      }),
  };
  return { deps, session, spies };
}

function inbound(staffId: string, text: string): ChannelMessage {
  return {
    channel: "system",
    customerId: `staff:${staffId}`,
    conversationId: `admin:${staffId}`,
    externalId: `ops-${staffId}-${Math.random()}`,
    text,
    receivedAt: "2026-07-04T12:00:00.000Z",
    locale: "pt-BR",
  };
}

async function runTurn(
  deps: ReturnType<typeof buildHarness>["deps"],
  role: "OWNER" | "MANAGER" | "ATTENDANT",
  staffId: string,
  text: string,
): Promise<{ decision: Decision; response: string; acted: unknown }> {
  const conductor = composeOpsConductor(deps as never, { staffId, role });
  const message = inbound(staffId, text);
  const capsule = await conductor.openCapsule({
    channel: "system",
    customerId: `staff:${staffId}`,
    sessionKey: `ops:${staffId}`,
    actor: { principal: "user", role: "staff", sessionId: `admin:${staffId}`, staffId },
    inbound: message,
  });
  try {
    const turn = await handleTurn(capsule, message);
    return {
      decision: turn.decision as Decision,
      response: turn.response.text,
      acted: turn.acted,
    };
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

const PRICE_CALL = (productRef: string, priceCentavos: number) => ({
  id: "tc-price",
  name: "express_intent",
  input: {
    capability: "product.price.set",
    payload: { productId: productRef, priceCentavos, reason: "reajuste" },
  },
});

describe("NEW-004 price-change-by-message — end-to-end park → confirm-resume → EXECUTE", () => {
  it("OWNER: name resolved → CONFIRM (name + old→new), then 'sim' EXECUTEs the egress ONCE", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 9500)],
    });
    const sessionId = "system:staff:owner1";

    // Turn 1 — the price change parks for confirmation.
    const t1 = await runTurn(deps, "OWNER", "owner1", "muda o preço da picanha pra 95");
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    // The reply states the product name + old→new BRL (the staff confirms numbers).
    expect(t1.response).toContain("Picanha");
    expect(t1.response).toContain("R$ 89,00");
    expect(t1.response).toContain("R$ 95,00");
    // The parked envelope carries the RESOLVED productId (name → id rewrite).
    expect(
      (parks[0]!.envelope.payload as { productId: string }).productId,
    ).toBe("prod_picanha");
    // No egress yet.
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();

    // Turn 2 — "sim, confirma" resumes → EXECUTE → the egress runs ONCE.
    const t2 = await runTurn(deps, "OWNER", "owner1", "sim, confirma");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.medusaAdjudicated).toHaveBeenCalledTimes(1);
    const [egressArgs] = spies.medusaAdjudicated.mock.calls[0]!;
    // The EXACT price egress: the resolved product, every BRL variant → 95 reais.
    expect(egressArgs.scope).toBe("admin");
    expect(egressArgs.method).toBe("POST");
    expect(egressArgs.path).toBe("/admin/products/prod_picanha");
    expect(egressArgs.intentKind).toBe("medusa.admin.product.update");
    expect(egressArgs.payload).toEqual({
      variants: [
        { id: "var_picanha", prices: [{ currency_code: "brl", amount: 95 }] },
      ],
    });
    // The park was cleared.
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("'não' after a park → deny → unparked, the egress NEVER runs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 9500)],
    });
    const sessionId = "system:staff:owner2";
    await runTurn(deps, "OWNER", "owner2", "muda o preço da picanha pra 95");
    expect(session.parksFor(sessionId)).toHaveLength(1);
    const t2 = await runTurn(deps, "OWNER", "owner2", "não, deixa como está");
    expect(t2.decision.kind).not.toBe("EXECUTE");
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("ATTENDANT → REFUSE staff_role_violation; nothing parks; no egress", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 9500)],
    });
    const t = await runTurn(deps, "ATTENDANT", "att1", "muda o preço da picanha pra 95");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("staff_role_violation");
    }
    expect(session.parksFor("system:staff:att1")).toHaveLength(0);
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
  });

  it("absurd price (> R$100.000,00) → REFUSE out_of_range; nothing parks; no egress", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [PRICE_CALL("picanha", 10_000_001)],
    });
    const t = await runTurn(deps, "OWNER", "owner3", "muda o preço da picanha pra 100 mil e um centavos");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("ops.price.out_of_range");
    }
    expect(session.parksFor("system:staff:owner3")).toHaveLength(0);
    expect(spies.medusaAdjudicated).not.toHaveBeenCalled();
  });
});
