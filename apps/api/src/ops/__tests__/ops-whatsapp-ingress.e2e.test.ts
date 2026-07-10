// ops-whatsapp-ingress.e2e — the BKL-086 crown-jewel proof: a staff WhatsApp
// message driven END-TO-END through handleOpsWhatsAppMessage → the REAL
// composeOpsConductor (WhatsApp verb scope) → a full handleTurn against the REAL
// composed policy router + REAL kernel. No DB/network — the model, medusa, and the
// refund/note writers are fakes/spies.
//
// Proves:
//   - OWNER "acabou a picanha" → product.availability.set EXECUTE → the SAME
//     medusaAdjudicated egress the products route uses → the reply is sent.
//   - ATTENDANT on a MANAGER verb → role REFUSE reply (role-opaque); no egress.
//   - a model-emitted payment.refund.issue on the WhatsApp plane is DROPPED by the
//     scope allowlist (the refund write NEVER runs) — refunds are dashboard-only.
//   - DEFENSE IN DEPTH: a refund PARKED from the dashboard is NOT resumable by
//     "sim" over WhatsApp (the ingress' scoped resume gate), while the dashboard
//     itself resumes the very same park (the gate is scope-specific, not a block).

import { describe, expect, it, vi } from "vitest";
import { adjudicate, adjudicateAndAudit, type PolicyBundle } from "@adjudicate/core/kernel";
import {
  buildEnvelope,
  decisionRefuse,
  refuse,
  type AuditSink,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
  type Completion,
  type CompletionRequest,
  type Conductor,
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
import { composeOpsConductor, type OpsConductorContext } from "../ops-conductor.js";
import { createOpsToolRegistry } from "../ops-tool-registry.js";
import { createOpsResolver, buildOpsRefundResumeState } from "../ops-resolver.js";
import { OpsSystemChannel } from "../ops-system-channel.js";
import type { StaffEnvelopeActor } from "../../claustrum/ibatexas-planner.js";
import {
  handleOpsWhatsAppMessage,
  type OpsWhatsAppIngressDeps,
  type StaffAllowlistRow,
} from "../ops-whatsapp-ingress.js";

const ROUTER: PolicyBundle<string, unknown, unknown> = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);
const noopSink = { emit: async () => {} } as unknown as AuditSink;

const noopTelemetry: TelemetryPort = {
  emitTurn: async () => {},
  emitLLMTrace: async () => {},
  emitMemoryAccess: async () => {},
};
const inMemoryLock: SessionLock = { acquire: async (key) => ({ key, release: async () => {} }) };

const tenantResolver: TenantResolver = {
  resolve: async ({ channel, customerId }) => ({
    tenant: { tenantId: "ibatexas", displayName: "IbateXas", locale: "pt-BR", environment: "dev" },
    state: { channel, customerId },
    policy: ROUTER,
  }),
};

/** Scripted model: fire the planner tool call ONCE (the first planner completion);
 *  responder completions + follow-up turns return grounded text with no tool call. */
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
      text: isPlanner ? "" : "Feito.",
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

// ── Part A: the WhatsApp ingress end-to-end (non-parking verbs) ──────────────

const realKernelAdjudicator: Adjudicator = {
  adjudicate: async (envelope, state, policy) =>
    adjudicate(envelope as IntentEnvelope, state as never, policy as never),
  adjudicatePlan: async (envelopes, state, policy, perStates) => {
    if (envelopes.length === 0) {
      return decisionRefuse(
        refuse("BUSINESS_RULE", "empty_plan", "Nada a autorizar.", "empty plan"),
        [],
      );
    }
    return adjudicate(
      envelopes[0] as IntentEnvelope,
      (perStates?.[0] ?? state) as never,
      policy as never,
    );
  },
  replayEnvelopesByCustomerId: async () => [],
  streamAuditByIntentHashPrefix: async function* () {},
  getOutcomes: async () => [],
  verifyAuditRecord: () => ({ ok: true }),
};

function freshSession(customerId: string): Session {
  return {
    id: `ops:${customerId}`,
    customerId,
    channel: "system",
    startedAt: "2026-07-04T00:00:00.000Z",
    lastActivityAt: "2026-07-04T00:00:00.000Z",
    pendingConfirmations: [],
    deferredEnvelopes: [],
    activeGoals: [],
    workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
  };
}
const inMemorySession: SessionPort = {
  load: async (customerId) => freshSession(customerId),
  save: async () => {},
  parkPendingConfirmation: async () => {},
  parkDeferred: async () => {},
  unpark: async () => {},
};

function buildPartADeps(opts: {
  model: ModelProvider;
  medusaAdjudicated: ReturnType<typeof vi.fn>;
  writeAdjudicatedRefund: ReturnType<typeof vi.fn>;
  product: { id: string; status: string } | null;
}) {
  const tools = createOpsToolRegistry({
    medusaAdjudicated: opts.medusaAdjudicated as never,
    auditSink: noopSink as never,
    readProductBrlVariantIds: (async () => ["variant_1"]) as never,
    orderCmdSvc: {
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition: vi.fn(),
    },
    publishOrderStatusChanged: vi.fn(),
    paymentCmdSvc: { writeAdjudicatedRefund: opts.writeAdjudicatedRefund },
    publishPaymentStatusChanged: vi.fn(),
    appendRefundEventLog: vi.fn(),
    opsAlertSvc: { resolveAlertFromEnvelope: vi.fn(async () => ({ result: { status: "RESOLVED" } })) },
    incidentSvc: { closeIncidentFromEnvelope: vi.fn(async () => ({ result: { status: "RESOLVED" } })) },
    scheduleSvc: { upsertOverride: vi.fn(async () => ({ date: "2026-07-10", isOpen: false })) },
    invalidateScheduleCache: vi.fn(async () => ({ ok: true })),
  });
  return {
    adjudicator: realKernelAdjudicator,
    memory: noopMemoryProvider(),
    grounding: noopGroundingProvider("mock"),
    explainer: { render: (r: { userFacing: string }) => r.userFacing },
    handoff: { queue: async () => {} },
    telemetry: noopTelemetry,
    session: inMemorySession,
    tenantResolver,
    sessionLock: inMemoryLock,
    systemChannel: new OpsSystemChannel({
      gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
      gateway: "ibatexas-ops-test",
    }),
    tools,
    model: opts.model,
    modelId: "mock",
    opsReadToolExecutors: {},
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => opts.product,
        lookupOrder: async () => null,
        lookupActivePayment: async () => null,
        lookupAlert: async () => null,
        lookupIncident: async () => null,
      }),
  };
}

/** Wire handleOpsWhatsAppMessage over a REAL composeOpsConductor + capture the reply. */
function ingressDepsFor(
  conductorDeps: ReturnType<typeof buildPartADeps>,
  staff: StaffAllowlistRow | null,
): { deps: OpsWhatsAppIngressDeps; replies: string[]; errors: string[] } {
  const replies: string[] = [];
  const errors: string[] = [];
  const deps: OpsWhatsAppIngressDeps = {
    findStaffByPhone: async () => staff,
    composeConductor: (actor: StaffEnvelopeActor, context: OpsConductorContext): Conductor =>
      composeOpsConductor(conductorDeps as never, actor, context),
    acquireLock: async () => "lock-uuid",
    releaseLock: async () => {},
    loadHistoryBlock: async () => undefined,
    appendHistory: async () => {},
    sendReply: async (text) => {
      replies.push(text);
    },
    sendError: async (text) => {
      errors.push(text);
    },
  };
  return { deps, replies, errors };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const AVAIL_CALL = {
  id: "tc-1",
  name: "express_intent",
  input: { capability: "product.availability.set", payload: { productId: "prod_1", available: false } },
};
const REFUND_CALL = {
  id: "tc-r",
  name: "express_intent",
  input: {
    capability: "payment.refund.issue",
    payload: { orderId: "4242", refundAmountCentavos: 5_000, reason: "cliente pediu" },
  },
};

describe("BKL-086 WhatsApp ingress — end-to-end through the REAL conductor", () => {
  it("OWNER 'acabou a picanha' → EXECUTE → medusa egress runs ONCE → reply sent", async () => {
    const medusaAdjudicated = vi.fn(async (_args: unknown) => ({ product: { id: "prod_1" } }));
    const writeAdjudicatedRefund = vi.fn();
    const conductorDeps = buildPartADeps({
      model: scriptedModel([AVAIL_CALL]),
      medusaAdjudicated,
      writeAdjudicatedRefund,
      product: { id: "prod_1", status: "published" },
    });
    const { deps, replies, errors } = ingressDepsFor(conductorDeps, {
      id: "staff_1",
      role: "OWNER",
      active: true,
    });

    const out = await handleOpsWhatsAppMessage(deps, {
      phone: "+5511999999999",
      hash: "h",
      text: "acabou a picanha",
      log,
    });

    expect(out).toEqual({ consumed: true });
    expect(medusaAdjudicated).toHaveBeenCalledTimes(1);
    const args = medusaAdjudicated.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.payload).toEqual({ metadata: { inStock: false } });
    expect(replies).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("ATTENDANT on product.availability.set (a MANAGER verb) → role REFUSE reply; no egress", async () => {
    const medusaAdjudicated = vi.fn(async () => ({ product: {} }));
    const conductorDeps = buildPartADeps({
      model: scriptedModel([AVAIL_CALL]),
      medusaAdjudicated,
      writeAdjudicatedRefund: vi.fn(),
      product: { id: "prod_1", status: "published" },
    });
    const { deps, replies } = ingressDepsFor(conductorDeps, {
      id: "staff_9",
      role: "ATTENDANT",
      active: true,
    });

    const out = await handleOpsWhatsAppMessage(deps, {
      phone: "+5511888888888",
      hash: "h2",
      text: "tira a picanha do cardápio",
      log,
    });

    expect(out).toEqual({ consumed: true });
    expect(medusaAdjudicated).not.toHaveBeenCalled();
    // The role-opaque refusal is delivered as the reply (never a fabricated success).
    expect(replies).toHaveLength(1);
    expect(replies[0]!.toLowerCase()).not.toContain("attendant");
  });

  it("a model-emitted refund on the WhatsApp plane is DROPPED (allowlist) — the refund write NEVER runs", async () => {
    const writeAdjudicatedRefund = vi.fn();
    const medusaAdjudicated = vi.fn(async () => ({ product: {} }));
    const conductorDeps = buildPartADeps({
      model: scriptedModel([REFUND_CALL]),
      medusaAdjudicated,
      writeAdjudicatedRefund,
      product: null,
    });
    const { deps, replies } = ingressDepsFor(conductorDeps, {
      id: "staff_1",
      role: "OWNER",
      active: true,
    });

    const out = await handleOpsWhatsAppMessage(deps, {
      phone: "+5511999999999",
      hash: "h",
      text: "reembolsa 50 do pedido 4242",
      log,
    });

    expect(out).toEqual({ consumed: true });
    // The refund was never adjudicated/executed — the scope dropped it at the planner.
    expect(writeAdjudicatedRefund).not.toHaveBeenCalled();
    // The owner still gets an honest reply (no ghost).
    expect(replies).toHaveLength(1);
  });
});

// ── Part B: defense-in-depth resume gating (dashboard park, WhatsApp "sim") ───

const ACTIVE_PAID = {
  paymentId: "pay_db_1",
  status: "paid",
  amountInCentavos: 10_000,
  refundedAmountCentavos: 0,
  method: "pix",
  version: 3,
  orderId: "order_4242",
};

function auditedResumeAdjudicator(): Adjudicator {
  return {
    adjudicate: async (envelope, state, policy) =>
      (await adjudicateAndAudit(envelope as IntentEnvelope, state as never, policy as never, { sink: noopSink })).decision,
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
        await adjudicateAndAudit(env, (perStates?.[0] ?? state) as never, policy as never, { sink: noopSink })
      ).decision;
    },
    resume: async (envelope, _state, policy, receipt) => {
      const env = envelope as IntentEnvelope;
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const paymentId = typeof payload.paymentId === "string" ? payload.paymentId : "";
      const opsState = buildOpsRefundResumeState(paymentId === "" ? null : ACTIVE_PAID, "ibatexas");
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
}

function makeStatefulSession(): SessionPort & { parksFor: (id: string) => ParkedEnvelope[] } {
  const parks = new Map<string, ParkedEnvelope[]>();
  const deferred = new Map<string, DeferredEnvelope[]>();
  const sid = (customerId: string) => `system:${customerId}`;
  return {
    load: async (customerId) => ({
      id: sid(customerId),
      customerId,
      channel: "system",
      startedAt: "2026-07-04T00:00:00.000Z",
      lastActivityAt: "2026-07-04T00:00:00.000Z",
      pendingConfirmations: parks.get(sid(customerId)) ?? [],
      deferredEnvelopes: deferred.get(sid(customerId)) ?? [],
      activeGoals: [],
      workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
    }),
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
      list.push({ envelope: envelope as IntentEnvelope, signal, deferUntil, timeoutMs, parkedAt: "2026-07-04T12:00:00.000Z" });
      deferred.set(sessionId, list);
    },
    unpark: async (sessionId, intentHash) => {
      parks.set(sessionId, (parks.get(sessionId) ?? []).filter((p) => p.envelope.intentHash !== intentHash));
      deferred.set(sessionId, (deferred.get(sessionId) ?? []).filter((d) => d.envelope.intentHash !== intentHash));
    },
    parksFor: (sessionId) => parks.get(sessionId) ?? [],
  };
}

function buildPartBDeps(model: ModelProvider, session: SessionPort) {
  const writeAdjudicatedRefund = vi.fn(async () => ({
    version: 4,
    previousStatus: "paid",
    newStatus: "refunded",
    totalRefundedCentavos: 5_000,
    refundAmountCentavos: 5_000,
    orderId: "order_4242",
    method: "pix",
  }));
  const tools = createOpsToolRegistry({
    medusaAdjudicated: (async () => ({})) as never,
    auditSink: noopSink as never,
    readProductBrlVariantIds: (async () => ["variant_1"]) as never,
    orderCmdSvc: { writeAdjudicatedNote: vi.fn(), writeAdjudicatedStatusTransition: vi.fn() },
    publishOrderStatusChanged: vi.fn(),
    paymentCmdSvc: { writeAdjudicatedRefund },
    publishPaymentStatusChanged: vi.fn(),
    appendRefundEventLog: vi.fn(),
    opsAlertSvc: { resolveAlertFromEnvelope: vi.fn(async () => ({ result: { status: "RESOLVED" } })) },
    incidentSvc: { closeIncidentFromEnvelope: vi.fn(async () => ({ result: { status: "RESOLVED" } })) },
    scheduleSvc: { upsertOverride: vi.fn(async () => ({ date: "2026-07-10", isOpen: false })) },
    invalidateScheduleCache: vi.fn(async () => ({ ok: true })),
  });
  const deps = {
    adjudicator: auditedResumeAdjudicator(),
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
    model,
    modelId: "mock",
    opsReadToolExecutors: {},
    buildResolver: (staffId: string) =>
      createOpsResolver({
        staffId,
        tenantId: "ibatexas",
        lookupProduct: async () => null,
        lookupOrder: async (orderId) =>
          orderId === "order_4242"
            ? { customerId: "cust_1", paymentMethod: "pix", paymentStatus: "paid", totalInCentavos: 10_000, fulfillmentStatus: "confirmed" }
            : null,
        orderReferenceReads: {
          findByDisplayId: async (d) =>
            d === 4242
              ? [{ id: "order_4242", displayId: 4242, customerName: "Maria", fulfillmentStatus: "confirmed", customerId: "cust_1", paymentMethod: "pix", paymentStatus: "paid", totalInCentavos: 10_000 }]
              : [],
          listRecentActive: async () => [],
        },
        lookupActivePayment: async () => ACTIVE_PAID,
      }),
  };
  return { deps, writeAdjudicatedRefund };
}

/** Drive one turn DIRECTLY against a scope-composed conductor (the dashboard path). */
async function runDirect(
  deps: ReturnType<typeof buildPartBDeps>["deps"],
  staffId: string,
  text: string,
  scope: "dashboard" | "whatsapp",
): Promise<void> {
  const conductor = composeOpsConductor(deps as never, { staffId, role: "OWNER" }, { opsVerbScope: scope });
  const message: ChannelMessage = {
    channel: "system",
    customerId: `staff:${staffId}`,
    conversationId: `admin:${staffId}`,
    externalId: `ops-${staffId}-${Math.random()}`,
    text,
    receivedAt: "2026-07-04T12:00:00.000Z",
    locale: "pt-BR",
  };
  const capsule = await conductor.openCapsule({
    channel: "system",
    customerId: `staff:${staffId}`,
    sessionKey: `ops:${staffId}`,
    actor: { principal: "user", role: "staff", sessionId: `admin:${staffId}`, staffId },
    inbound: message,
  });
  try {
    await handleTurn(capsule, message);
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

describe("BKL-086 defense in depth — a dashboard-parked refund is NOT resumable over WhatsApp", () => {
  it("dashboard parks a refund → WhatsApp 'sim' does NOT resume it → the dashboard itself does", async () => {
    const session = makeStatefulSession();
    const model = scriptedModel([REFUND_CALL]);
    const { deps, writeAdjudicatedRefund } = buildPartBDeps(model, session);
    const sessionId = "system:staff:owner1";

    // Turn 1 (DASHBOARD scope): the refund parks for confirmation.
    await runDirect(deps, "owner1", "reembolsa 50 do pedido 4242", "dashboard");
    expect(session.parksFor(sessionId)).toHaveLength(1);
    expect(writeAdjudicatedRefund).not.toHaveBeenCalled();

    // Turn 2 (WHATSAPP ingress): "sim, confirma" — the WhatsApp scope hides the
    // refund park from matchToParked, so NOTHING resumes and the park is untouched.
    const replies: string[] = [];
    const waDeps: OpsWhatsAppIngressDeps = {
      findStaffByPhone: async () => ({ id: "owner1", role: "OWNER", active: true }),
      composeConductor: (actor, context) => composeOpsConductor(deps as never, actor, context),
      acquireLock: async () => "lock",
      releaseLock: async () => {},
      loadHistoryBlock: async () => undefined,
      appendHistory: async () => {},
      sendReply: async (t) => {
        replies.push(t);
      },
      sendError: async (t) => {
        replies.push(t);
      },
    };
    const out = await handleOpsWhatsAppMessage(waDeps, {
      phone: "+5511999999999",
      hash: "h",
      text: "sim, confirma",
      log,
    });
    expect(out).toEqual({ consumed: true });
    expect(writeAdjudicatedRefund).not.toHaveBeenCalled();
    expect(session.parksFor(sessionId)).toHaveLength(1); // still parked
    expect(replies).toHaveLength(1); // the owner got an honest (non-resuming) reply

    // Turn 3 (DASHBOARD scope, control): "sim, confirma" resumes the SAME park →
    // EXECUTE → the refund write runs ONCE → the park clears. Proves the WhatsApp
    // block is scope-specific, not a blanket disable of the parked refund.
    await runDirect(deps, "owner1", "sim, confirma", "dashboard");
    expect(writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });
});
