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
import { carriesSafetyMarker } from "../../claustrum/required-claim-decomposer.js";
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
    dailySpecialSvc: {
      list: vi.fn(async () => []) as never,
      create: vi.fn(async () => ({ id: "special_1" })) as never,
      update: vi.fn(async () => ({ id: "special_1" })) as never,
    },
    publishOrderStatusChanged: vi.fn(),
    paymentCmdSvc: { writeAdjudicatedRefund: opts.writeAdjudicatedRefund },
    publishPaymentStatusChanged: vi.fn(),
    appendRefundEventLog: vi.fn(),
    opsAlertSvc: { writeAdjudicatedAlertResolve: vi.fn(async () => ({ status: "RESOLVED" })) },
    incidentSvc: { writeAdjudicatedIncidentClose: vi.fn(async () => ({ status: "RESOLVED" })) },
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
    dailySpecialSvc: {
      list: vi.fn(async () => []) as never,
      create: vi.fn(async () => ({ id: "special_1" })) as never,
      update: vi.fn(async () => ({ id: "special_1" })) as never,
    },
    publishOrderStatusChanged: vi.fn(),
    paymentCmdSvc: { writeAdjudicatedRefund },
    publishPaymentStatusChanged: vi.fn(),
    appendRefundEventLog: vi.fn(),
    opsAlertSvc: { writeAdjudicatedAlertResolve: vi.fn(async () => ({ status: "RESOLVED" })) },
    incidentSvc: { writeAdjudicatedIncidentClose: vi.fn(async () => ({ status: "RESOLVED" })) },
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

// ── Part C: FE-D13 honest stale-resume over the WhatsApp ingress ──────────────
// The WhatsApp ingress builds inbound.receivedAt from the real clock, so a park
// stamped an hour ago is comfortably past the 15-min confirm-TTL. The ingress must
// restate the expiry (honest, deterministic pt-BR) instead of running the fresh
// loop — but NEVER for an out-of-scope money park (BKL-086 parity: WhatsApp can
// only restate what it could resume in the first place).

/** A directly-seeded park carrying a `kind` + kernel prompt (turn is skipped, so a
 *  fully-valid envelope is unnecessary — the ingress reads only kind + userPrompt). */
function seededParkedEnvelope(
  kind: string,
  intentHash: string,
  userPrompt: string,
  parkedAt: string,
): ParkedEnvelope {
  return {
    envelope: { kind, intentHash } as ParkedEnvelope["envelope"],
    confirmationToken: `tok-${intentHash}`,
    userPrompt,
    parkedAt,
  };
}

/** A SessionPort pre-seeded with fixed parks (load returns them; unpark filters). */
function seededSession(
  parks: ParkedEnvelope[],
): SessionPort & { parksFor: (id: string) => ParkedEnvelope[] } {
  const store = new Map<string, ParkedEnvelope[]>();
  const sid = (customerId: string) => `system:${customerId}`;
  return {
    load: async (customerId) => ({
      id: sid(customerId),
      customerId,
      channel: "system",
      startedAt: "2026-07-04T00:00:00.000Z",
      lastActivityAt: "2026-07-04T00:00:00.000Z",
      pendingConfirmations: store.get(sid(customerId)) ?? parks,
      deferredEnvelopes: [],
      activeGoals: [],
      workingMemory: { summary: "", facts: [], updatedAt: "2026-07-04T00:00:00.000Z" },
    }),
    save: async () => {},
    parkPendingConfirmation: async () => {},
    parkDeferred: async () => {},
    unpark: async (sessionId, intentHash) => {
      store.set(
        sessionId,
        (store.get(sessionId) ?? parks).filter((p) => p.envelope.intentHash !== intentHash),
      );
    },
    parksFor: (sessionId) => store.get(sessionId) ?? parks,
  };
}

describe("FE-D13 — honest stale-resume over the WhatsApp ingress", () => {
  const OLD = new Date(Date.now() - 3_600_000).toISOString(); // 1h ago → past the 15-min TTL

  it("a stale IN-SCOPE park + 'sim' → the expiry notice is sent, the turn is SKIPPED, history appended, zombie pruned", async () => {
    const expiredPark = seededParkedEnvelope(
      "product.price.set",
      "abc123abc123",
      "Confirmar novo preço da costela para R$ 89,00?",
      OLD,
    );
    const session = seededSession([expiredPark]);
    const model = scriptedModel([]); // if the turn ran, the planner would be invoked
    const { deps: conductorDeps } = buildPartBDeps(model, session);

    const appended: Array<{ role: string; content: string }> = [];
    const replies: string[] = [];
    const waDeps: OpsWhatsAppIngressDeps = {
      findStaffByPhone: async () => ({ id: "owner1", role: "OWNER", active: true }),
      composeConductor: (actor, context) => composeOpsConductor(conductorDeps as never, actor, context),
      acquireLock: async () => "lock",
      releaseLock: async () => {},
      loadHistoryBlock: async () => undefined,
      appendHistory: async (_s, msgs) => {
        for (const m of msgs) appended.push({ role: m.role, content: m.content });
      },
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
    // The honest expiry restatement was sent (deterministic pt-BR, names the park).
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("expirou");
    expect(replies[0]).toContain("Confirmar novo preço da costela para R$ 89,00?");
    // The turn was SKIPPED — the planner model was never invoked.
    expect(model.complete as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // The notice was appended to the shared ops thread (assistant role).
    expect(appended).toContainEqual({ role: "assistant", content: replies[0]! });
    // FE-D33 — the now-inert expired in-scope park is PRUNED from the session.
    expect(session.parksFor("system:staff:owner1")).toHaveLength(0);
  });

  it("BKL-086 parity: a stale DASHBOARD-scoped money park is NOT restated over WhatsApp", async () => {
    const expiredRefund = seededParkedEnvelope(
      "payment.refund.issue",
      "ref0ref0ref0",
      "Confirmar reembolso de R$ 50,00?",
      OLD,
    );
    const session = seededSession([expiredRefund]);
    const model = scriptedModel([]);
    const { deps: conductorDeps, writeAdjudicatedRefund } = buildPartBDeps(model, session);

    const replies: string[] = [];
    const errors: string[] = [];
    const waDeps: OpsWhatsAppIngressDeps = {
      findStaffByPhone: async () => ({ id: "owner1", role: "OWNER", active: true }),
      composeConductor: (actor, context) => composeOpsConductor(conductorDeps as never, actor, context),
      acquireLock: async () => "lock",
      releaseLock: async () => {},
      loadHistoryBlock: async () => undefined,
      appendHistory: async () => {},
      sendReply: async (t) => {
        replies.push(t);
      },
      sendError: async (t) => {
        errors.push(t);
      },
    };

    const out = await handleOpsWhatsAppMessage(waDeps, {
      phone: "+5511999999999",
      hash: "h",
      text: "sim, confirma",
      log,
    });

    expect(out).toEqual({ consumed: true });
    // WhatsApp NEVER restates a dashboard-only money park (out-of-scope) — no expiry
    // notice appears on any surface…
    const allText = [...replies, ...errors].join("\n");
    expect(allText).not.toContain("expirou");
    // …and the refund never executes (excluded AND expired); the park is untouched.
    expect(writeAdjudicatedRefund).not.toHaveBeenCalled();
    // FE-D33 parity: an out-of-scope money park is NOT pruned from the WhatsApp
    // plane either (only the dashboard, which can resume it, may prune it).
    expect(session.parksFor("system:staff:owner1")).toHaveLength(1);
    // The owner still gets an honest (non-notice) reply from the normal loop.
    expect(replies.length + errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Part D: F-4 — the FRESH-park triage branches over the WhatsApp ingress ────
//
// F-4 (R4-S1 ledger finding). All four ingresses consume the SAME decision
// (`triageParkReply`, ../../claustrum/park-reply-triage.ts), and ops-WhatsApp was
// the LAST unguarded consumer of its two FRESH-park branches: probe A during R4-S1
// neutered the ingress' triage consumption and landed red everywhere EXCEPT here.
// Part C above guards the third branch (stale-resume) plus its exclusion parity, so
// this part adds exactly what was missing — soft-affirmative RESTATE (FE-D32) and
// pure-negative DECLINE (BKL-191) — at the ops-WA seam, in the shape the sibling
// surfaces already use (src/__tests__/whatsapp-webhook-async.test.ts's "park-reply
// triage" block, and routes/admin/__tests__/ops-chat.test.ts's ops-plane mirror).
//
// WHY THIS FILE AND NOT THE UNIT SUITE. These branches read `capsule.loadedSession
// .pendingConfirmations` and write through `capsule.session.unpark` — the capsule's
// PRODUCTION shape. The unit suite's `fakeConductor()` returns `{id, turnId}` with
// neither field, which is precisely why the branches were invisible to it; guarding
// them there would mean hand-authoring the very double whose shape is the contract
// (and the decline ACK is load-bearing — it asserts a cancellation, so the unpark
// must be a real SessionPort write, not an assertion about a stub). Here the
// capsule comes from the REAL composeOpsConductor over a real SessionPort, and the
// branches' sibling (stale-resume) already lives here with a working harness — one
// place to read what ops-WA does with a park-bearing reply.
//
// THE OPS PLANE'S POLICY DIFFERS FROM THE CUSTOMER PLANE'S BY DESIGN, and these
// cases pin the ops knobs rather than copying the customer expectations:
//   · `softAffirmativeAdmission: "soft-shaped"` — a staff "ok muda o preço" that
//     restates the park IS admitted here (the customer plane admits soft-ONLY).
//   · a FRESHNESS clock (the confirm TTL) — hence the stale branch, Part C.
//   · `excludedKindsForScope("whatsapp")` — the knob UNIQUE to this surface: a
//     dashboard-only money park is never restated, declined, or pruned here.
//   · NO `safetyMarkerDefersDecline` — deliberately not given to this plane (three
//     measured grounds recorded at `opsParkTriagePolicy`). Pinned below as the
//     declared difference it is, not as a defect.
describe("F-4 — the ops-WhatsApp ingress' FRESH-park triage branches", () => {
  const SESSION_ID = "system:staff:owner1";
  /** An IN-SCOPE ops park: a reversible verb the WhatsApp plane may itself propose. */
  const IN_SCOPE_KIND = "product.price.set";
  const IN_SCOPE_HASH = "fresh1fresh1";
  const IN_SCOPE_PROMPT = "Confirmar novo preço da costela para R$ 89,00?";
  /** The DASHBOARD-ONLY money kind — the single member of WA_EXCLUDED_OPS_KINDS
   *  (ops-verb-scope.ts). Spelled by hand, never imported, so this suite is an
   *  independent statement of the exclusion rather than a projection of it. */
  const EXCLUDED_KIND = "payment.refund.issue";
  const EXCLUDED_HASH = "ref0ref0ref0";
  const EXCLUDED_PROMPT = "Confirmar reembolso de R$ 50,00?";
  /** The ops-register decline acknowledgment, spelled by hand (the ops-chat sibling
   *  pins the same literal). A wording change must be a deliberate edit here. */
  const OPS_DECLINE_ACK = "Ok, cancelei a ação pendente — nada foi executado.";

  /** `secondsAgo` before now — the ingress stamps `inbound.receivedAt` off the real
   *  clock, so a few seconds is comfortably inside the 900s confirm TTL. */
  const ago = (secondsAgo: number): string =>
    new Date(Date.now() - secondsAgo * 1000).toISOString();
  const freshInScope = (parkedAtSecondsAgo = 10): ParkedEnvelope =>
    seededParkedEnvelope(IN_SCOPE_KIND, IN_SCOPE_HASH, IN_SCOPE_PROMPT, ago(parkedAtSecondsAgo));
  const freshExcluded = (parkedAtSecondsAgo = 1): ParkedEnvelope =>
    seededParkedEnvelope(EXCLUDED_KIND, EXCLUDED_HASH, EXCLUDED_PROMPT, ago(parkedAtSecondsAgo));

  /** Drive ONE staff WhatsApp message over the REAL scope-composed ops conductor,
   *  capturing every surface the ingress can speak on. `model.complete` is the
   *  load-bearing turn witness: a triage branch SKIPS handleTurn, so "the planner
   *  was never invoked" is what separates an answered reply from a fallthrough. */
  async function driveOpsWa(
    session: SessionPort,
    text: string,
  ): Promise<{
    replies: string[];
    errors: string[];
    appended: Array<{ role: string; content: string }>;
    modelCalled: () => boolean;
  }> {
    const model = scriptedModel([]);
    const { deps: conductorDeps } = buildPartBDeps(model, session);
    const replies: string[] = [];
    const errors: string[] = [];
    const appended: Array<{ role: string; content: string }> = [];
    const waDeps: OpsWhatsAppIngressDeps = {
      findStaffByPhone: async () => ({ id: "owner1", role: "OWNER", active: true }),
      composeConductor: (actor, context) =>
        composeOpsConductor(conductorDeps as never, actor, context),
      acquireLock: async () => "lock",
      releaseLock: async () => {},
      loadHistoryBlock: async () => undefined,
      appendHistory: async (_s, msgs) => {
        for (const m of msgs) appended.push({ role: m.role, content: m.content });
      },
      sendReply: async (t) => {
        replies.push(t);
      },
      sendError: async (t) => {
        errors.push(t);
      },
    };
    const out = await handleOpsWhatsAppMessage(waDeps, {
      phone: "+5511999999999",
      hash: "h",
      text,
      log,
    });
    expect(out).toEqual({ consumed: true });
    return {
      replies,
      errors,
      appended,
      modelCalled: () =>
        (model.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    };
  }

  // ── (a) SOFT-AFFIRMATIVE RESTATE (FE-D32) — the park SURVIVES ───────────────

  it("(a) a bare soft 'pode' on a FRESH in-scope park RESTATES it, SKIPS the turn, and the park SURVIVES", async () => {
    const session = seededSession([freshInScope()]);
    // DURING-arm: the park is present and in scope BEFORE the reply, so the
    // "survives / not unparked" assertions below cannot pass on an empty store.
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    const { replies, errors, appended, modelCalled } = await driveOpsWa(session, "pode");

    // The deterministic ops restatement, naming the park's own stored prompt.
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Só confirmando");
    expect(replies[0]).toContain(IN_SCOPE_PROMPT);
    expect(replies[0]).toContain('"sim"');
    expect(errors).toHaveLength(0);
    // The turn was SKIPPED — the planner model was never invoked.
    expect(modelCalled()).toBe(false);
    // Money-safety: a soft affirmative NEVER executes and NEVER unparks. The park
    // is still there (asserted present above), so a follow-up "sim" resumes it.
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);
    expect(session.parksFor(SESSION_ID)[0]!.envelope.intentHash).toBe(IN_SCOPE_HASH);
    // A deterministic notice IS a delivered reply: persisted to the shared thread.
    expect(appended).toContainEqual({ role: "assistant", content: replies[0]! });
  });

  it.each(["ok", "beleza", "OK!", "claro", "manda", "isso"])(
    "(a′) soft variant %j also restates instead of reaching the loop",
    async (word) => {
      const session = seededSession([freshInScope()]);
      expect(session.parksFor(SESSION_ID)).toHaveLength(1);
      const { replies, modelCalled } = await driveOpsWa(session, word);
      expect(replies[0]).toContain("Só confirmando");
      expect(modelCalled()).toBe(false);
      expect(session.parksFor(SESSION_ID)).toHaveLength(1);
    },
  );

  // (a″) THE OPS-vs-CUSTOMER KNOB, pinned as a positive assertion. The ops policy
  // declares `softAffirmativeAdmission: "soft-shaped"` — a soft yes that ALSO
  // carries content is admitted here, because a staff "ok muda o preço" restating
  // the park is an acceptable prompt for an explicit confirm. The CUSTOMER plane
  // declares "soft-only" and lets this exact shape through to the loop (pinned at
  // whatsapp-webhook-async.test.ts (d′) "a soft yes carrying NEW content"), so
  // copying the customer expectation here would assert the OPPOSITE of the policy.
  it("(a″) OPS KNOB: a soft yes carrying NEW content ('ok muda o preço') RESTATES here — the customer plane's soft-ONLY rule does NOT apply", async () => {
    const session = seededSession([freshInScope()]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    const { replies, modelCalled } = await driveOpsWa(session, "ok muda o preço");

    expect(replies[0]).toContain("Só confirmando");
    expect(replies[0]).toContain(IN_SCOPE_PROMPT);
    expect(modelCalled()).toBe(false);
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);
  });

  // (a‴) THE ORDERING INVARIANT at this surface: a FRESH in-scope park the reply
  // resumes takes precedence over an EXPIRED one — a legitimate fresh soft
  // affirmative is never shadowed by an expiry notice. Both parks are in the SAME
  // list, so this cannot pass with either one absent.
  it("(a‴) with BOTH an expired and a fresh in-scope park, a soft 'pode' restates the FRESH one — no expiry notice", async () => {
    const expired = seededParkedEnvelope(
      IN_SCOPE_KIND,
      "old0old0old0",
      "Confirmar remoção da picanha do cardápio?",
      ago(3600), // 1h ago → past the 15-min TTL
    );
    const session = seededSession([expired, freshInScope()]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(2);

    const { replies, modelCalled } = await driveOpsWa(session, "pode");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Só confirmando");
    expect(replies[0]).toContain(IN_SCOPE_PROMPT);
    // The expiry notice is SUPPRESSED — neither its copy nor the expired park's
    // own prompt appears (the fresh park won the ordering).
    expect(replies[0]).not.toContain("expirou");
    expect(replies[0]).not.toContain("Confirmar remoção da picanha do cardápio?");
    expect(modelCalled()).toBe(false);
    // The restate branch names NO prune, so BOTH parks survive this turn.
    expect(session.parksFor(SESSION_ID)).toHaveLength(2);
  });

  // ── (b) PURE-NEGATIVE DECLINE (BKL-191) — unpark + acknowledge ──────────────

  it("(b) a pure negative 'não' on a FRESH in-scope park DECLINES it: unparked, ACK sent, turn SKIPPED", async () => {
    const session = seededSession([freshInScope()]);
    // DURING-arm: the park exists before the reply, so "unparked" below is a
    // measured removal and not an assertion about an empty store.
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    const { replies, errors, appended, modelCalled } = await driveOpsWa(session, "não");

    // The acknowledgment asserts a cancellation, so the unpark must have STUCK.
    expect(session.parksFor(SESSION_ID)).toHaveLength(0);
    expect(replies).toEqual([OPS_DECLINE_ACK]);
    expect(errors).toHaveLength(0);
    // The negative text never reached the planner (the BKL-191 re-prompt this closes).
    expect(modelCalled()).toBe(false);
    expect(appended).toContainEqual({ role: "assistant", content: OPS_DECLINE_ACK });
  });

  it.each(["não", "nao", "cancela", "cancelar", "negativo", "não, cancela essa ação"])(
    "(b′) negative variant %j also declines and unparks",
    async (word) => {
      const session = seededSession([freshInScope()]);
      expect(session.parksFor(SESSION_ID)).toHaveLength(1);
      const { replies, modelCalled } = await driveOpsWa(session, word);
      expect(replies).toEqual([OPS_DECLINE_ACK]);
      expect(session.parksFor(SESSION_ID)).toHaveLength(0);
      expect(modelCalled()).toBe(false);
    },
  );

  // (b″) FAIL-HONEST — the ACK asserts the pending action was cancelled, so it may
  // only be sent once the unpark STUCK. A failure falls through to the normal loop
  // (claustrum's own deny path still unparks there) rather than claiming a
  // cancellation that did not happen.
  it("(b″) an unpark FAILURE falls through to the loop instead of claiming a cancellation", async () => {
    const base = seededSession([freshInScope()]);
    const unparkAttempts: Array<[string, string]> = [];
    const session: SessionPort = {
      ...base,
      unpark: async (sessionId, intentHash) => {
        unparkAttempts.push([sessionId, intentHash]);
        throw new Error("redis down");
      },
    };
    expect(base.parksFor(SESSION_ID)).toHaveLength(1);

    const { replies, errors } = await driveOpsWa(session, "não");

    // The triage DID decide to decline and DID attempt the unpark on the parked
    // envelope's own hash — this is what separates the fail-honest fallthrough from
    // an ingress with no triage at all (which never touches the store), so the
    // assertion is not satisfied by the unwired baseline.
    expect(unparkAttempts[0]).toEqual([SESSION_ID, IN_SCOPE_HASH]);
    // MEASURED, and the substantive half of the contract: the fallthrough really
    // reaches claustrum's OWN deny path, which unparks the SAME target again. The
    // promise "the loop still unparks there" is therefore a real recovery, not just
    // a suppressed acknowledgment. Every attempt names the same park — the failure
    // never widens the blast radius.
    expect(unparkAttempts.length).toBeGreaterThanOrEqual(2);
    expect(
      unparkAttempts.every(([s, h]) => s === SESSION_ID && h === IN_SCOPE_HASH),
    ).toBe(true);
    // The park did NOT clear → no acknowledgment on ANY surface; the loop ran.
    const allText = [...replies, ...errors].join("\n");
    expect(allText).not.toContain(OPS_DECLINE_ACK);
    expect(replies.length + errors.length).toBeGreaterThanOrEqual(1);
    expect(base.parksFor(SESSION_ID)).toHaveLength(1);
  });

  // ── (c) THE KNOB UNIQUE TO OPS-WHATSAPP: excludedKindsForScope("whatsapp") ───
  //
  // Both cases seed the money park as the MOST RECENT one. `pickMostRecentlyParked`
  // would therefore select IT if the exclusion were dropped from the policy, so each
  // case reds on TWO independent mutations: neutering the triage consumption (no
  // notice / no unpark at all), and removing `excludedKinds` from
  // `opsParkTriagePolicy({...})` at the ingress (the notice would name the refund,
  // the unpark would clear the refund hash). Both parks are in the SAME list, so
  // neither "not restated" nor "not unparked" can pass with the money park absent.

  it("(c) a fresh DASHBOARD-ONLY money park is NOT restated — a soft 'pode' restates the in-scope park beside it", async () => {
    // The refund park is the MOST RECENT: without the WhatsApp exclusion it would
    // be the restate target.
    const session = seededSession([freshInScope(10), freshExcluded(1)]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(2);

    const { replies, modelCalled } = await driveOpsWa(session, "pode");

    expect(replies).toHaveLength(1);
    // The IN-SCOPE park is restated…
    expect(replies[0]).toContain("Só confirmando");
    expect(replies[0]).toContain(IN_SCOPE_PROMPT);
    // …and the dashboard-only money park — present in the very same list — is not
    // named on any surface (BKL-086 parity: WhatsApp never restates what it could
    // not resume in the first place).
    expect(replies[0]).not.toContain(EXCLUDED_PROMPT);
    expect(modelCalled()).toBe(false);
    // Neither park is touched by the restate branch.
    expect(session.parksFor(SESSION_ID)).toHaveLength(2);
  });

  it("(c′) a fresh DASHBOARD-ONLY money park is NOT declined — 'não' unparks ONLY the in-scope park beside it", async () => {
    const session = seededSession([freshInScope(10), freshExcluded(1)]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(2);

    const { replies } = await driveOpsWa(session, "não");

    expect(replies).toEqual([OPS_DECLINE_ACK]);
    // EXACTLY the in-scope park was cancelled; the dashboard-only money park
    // survives untouched, resumable from the dashboard that CAN propose it.
    const remaining = session.parksFor(SESSION_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.envelope.intentHash).toBe(EXCLUDED_HASH);
    expect(String(remaining[0]!.envelope.kind)).toBe(EXCLUDED_KIND);
  });

  it("(c″) a LONE fresh dashboard-only money park is invisible to BOTH branches — no notice, the normal loop runs", async () => {
    const session = seededSession([freshExcluded()]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    // Both fresh branches are exercised against the SAME out-of-scope park.
    for (const text of ["pode", "não"]) {
      const { replies, errors, modelCalled } = await driveOpsWa(session, text);
      const allText = [...replies, ...errors].join("\n");
      expect(allText).not.toContain("Só confirmando");
      expect(allText).not.toContain(OPS_DECLINE_ACK);
      // The turn RAN — the reply came from the loop, not from the triage.
      expect(modelCalled()).toBe(true);
      // The money park is untouched on every pass (present throughout, so the
      // "not declined" claim above is about a park that was really there).
      expect(session.parksFor(SESSION_ID)).toHaveLength(1);
    }
  });

  // ── (d) CONTROLS — the shapes the triage must let through ───────────────────

  // Control + treatment in ONE test, against the SAME park: the "pode" arm MUST
  // restate (so the harness is proven live), and the explicit "sim" arm must NOT be
  // intercepted. Assertions are scoped to what this seam decides — an explicit
  // confirm belongs to the conductor's own adjudicated resume path.
  it("(d) CONTROL: an explicit 'sim, confirma' is NOT intercepted, while 'pode' on the SAME park IS", async () => {
    const session = seededSession([freshInScope()]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    // TREATMENT — the control's validator: the branch is live on this park.
    const soft = await driveOpsWa(session, "pode");
    expect(soft.replies[0]).toContain("Só confirmando");
    expect(session.parksFor(SESSION_ID)).toHaveLength(1); // restate keeps the park

    // CONTROL — same session, same park, explicit confirm: no triage notice on any
    // surface. The turn is handed to the conductor, which owns the resume.
    const explicit = await driveOpsWa(session, "sim, confirma");
    const allText = [...explicit.replies, ...explicit.errors].join("\n");
    expect(allText).not.toContain("Só confirmando");
    expect(allText).not.toContain(OPS_DECLINE_ACK);
    expect(allText).not.toContain("expirou");
  });

  it.each([
    ["an ordinary ops command", "muda o preço da costela para R$ 89"],
    ["a MIXED affirmative + negative (ambiguous, money-safe)", "não, pode deixar"],
  ])(
    "(d′) CONTROL: %s runs the normal turn with the park untouched",
    async (_label, text) => {
      const session = seededSession([freshInScope()]);
      expect(session.parksFor(SESSION_ID)).toHaveLength(1);

      const { replies, errors, modelCalled } = await driveOpsWa(session, text);

      const allText = [...replies, ...errors].join("\n");
      expect(allText).not.toContain("Só confirmando");
      expect(allText).not.toContain(OPS_DECLINE_ACK);
      // The loop ran, and the triage removed nothing.
      expect(modelCalled()).toBe(true);
      expect(session.parksFor(SESSION_ID)).toHaveLength(1);
    },
  );

  // A DEFER phrase is a control too, but its park outcome belongs to a different
  // owner and is named rather than assumed. The triage has NO defer branch — a
  // defer reply is deferred to the normal loop — and the loop's own `defer`
  // resolution then unparks. Asserting "the park is untouched" here would be
  // asserting the wrong owner; what this seam decides is that it did NOT intercept.
  it("(d‴) CONTROL: a defer phrase ('amanhã') is NOT intercepted — the loop resolves it and owns the park", async () => {
    const session = seededSession([freshInScope()]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    const { replies, errors, modelCalled } = await driveOpsWa(session, "amanhã");

    const allText = [...replies, ...errors].join("\n");
    expect(allText).not.toContain("Só confirmando");
    expect(allText).not.toContain(OPS_DECLINE_ACK);
    expect(allText).not.toContain("expirou");
    expect(modelCalled()).toBe(true);
    // MEASURED: the park is gone — cleared by the CONDUCTOR's defer resolution
    // (matchOpsReplyToParked resolves "amanhã" to `defer`), never by the triage.
    expect(session.parksFor(SESSION_ID)).toHaveLength(0);
  });

  it.each(["pode", "não", "sim", "muda o preço da costela para R$ 89"])(
    "(d″) CONTROL: with NO park at all, %j takes the normal path",
    async (text) => {
      const session = seededSession([]);
      expect(session.parksFor(SESSION_ID)).toHaveLength(0);

      const { replies, errors, modelCalled } = await driveOpsWa(session, text);

      const allText = [...replies, ...errors].join("\n");
      expect(allText).not.toContain("Só confirmando");
      expect(allText).not.toContain(OPS_DECLINE_ACK);
      expect(allText).not.toContain("expirou");
      expect(modelCalled()).toBe(true);
    },
  );

  // ── (e) THE DECLARED PLANE DIFFERENCE: ops has NO safetyMarkerDefersDecline ──
  //
  // PR #526 gave `safetyMarkerDefersDecline` to the CUSTOMER plane only, and the
  // omission here is a recorded decision with three MEASURED grounds (see
  // `opsParkTriagePolicy`'s docblock): the emergency template's staff-handoff
  // promise is unbacked on ops (`onSafetyEmergency` is omitted from the ops seams),
  // the BKL-184 abstain is frequently discarded by the ops read-render precedence,
  // and both templates are customer-register pt-BR addressed to a staff member. So
  // on this plane a marker-bearing negative is still an ordinary decline, and
  // trading the honest "cancelei a ação pendente" for an unbacked promise would be
  // the regression. This pins the DECLARED behaviour: the day ops grows its own
  // safety surface, declaring the knob is a one-line change that flips this test —
  // which is exactly what a change-detector on an owner-reversible decision is for.
  it("(e) OPS KNOB: a negative carrying a SAFETY MARKER still DECLINES here (the customer plane's stand-down is not declared on ops)", async () => {
    // Non-vacuity: the text really IS a marker by the same net the customer policy
    // declares — without this the case would pass on any string.
    expect(carriesSafetyMarker("não, sou celíaco")).toBe(true);

    const session = seededSession([freshInScope()]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);

    const { replies, modelCalled } = await driveOpsWa(session, "não, sou celíaco");

    expect(replies).toEqual([OPS_DECLINE_ACK]);
    expect(session.parksFor(SESSION_ID)).toHaveLength(0);
    expect(modelCalled()).toBe(false);
  });
});
