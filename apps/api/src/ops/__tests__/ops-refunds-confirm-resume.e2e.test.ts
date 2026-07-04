// ops-refunds-confirm-resume — the BKL-085 crown-jewel proof: refunds-by-message
// driven END-TO-END through composeOpsConductor + a full handleTurn against the
// REAL composed policy router + REAL audited kernel (adjudicateAndAudit) with a
// STATEFUL session store + the REAL OpsSystemChannel matchToParked driver. No
// DB/network — the model, the payment reads, and the refund WRITE are fakes/spies.
//
// Proves the whole money-safe flow:
//   - OWNER "reembolsa 50 do pedido 4242": order-ref → payment located → DB-stamped
//     balance payload → UNTRUSTED taint overlay → REQUEST_CONFIRMATION → PARKED
//     (asserted in the session store) → reply carries the amount prompt.
//   - "sim, confirma" → matchToParked confirm → resume (re-adjudicate the parked
//     envelope through the composed router, receipt flips CONFIRM→EXECUTE) →
//     writeAdjudicatedRefund called ONCE with the STAMPED payload + the
//     payment.status_changed publisher fired; the park is cleared.
//   - "não" → deny → unparked, the write NEVER runs.
//   - a defer phrase → deferred, the write NEVER runs.
//   - ATTENDANT → REFUSE staff_role_violation; nothing parks.
//   - >R$1000 → ESCALATE (the taint overlay does NOT pre-empt); nothing parks.
//   - forged payload balances → stamped from the DB; an over-balance refund REFUSEs.
//   - a DIFFERENT staff session cannot see another's park (staff-session-scoped).

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
  buildOpsRefundResumeState,
} from "../ops-resolver.js";
import { OpsSystemChannel } from "../ops-system-channel.js";

const ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

const noopSink = { emit: async () => {} } as unknown as AuditSink;

/** A refundable active payment (the fake DB row the resolver + resume read). */
const ACTIVE_PAID = {
  paymentId: "pay_db_1",
  status: "paid",
  amountInCentavos: 10_000, // R$100 balance
  refundedAmountCentavos: 0,
  method: "pix",
  version: 3,
  orderId: "order_4242",
};

// ── A REAL audited adjudicator over the composed router ──────────────────────
// adjudicate/adjudicatePlan run the audited kernel; resume RE-PROJECTS the ops
// PaymentState (mirroring production's enrichResumeState → buildOpsRefundResumeState)
// then re-adjudicates WITH the confirmation receipt (CONFIRM→EXECUTE).
function makeAdjudicator(
  paymentById: (id: string) => typeof ACTIVE_PAID | null,
): Adjudicator {
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
    // The production resume path (buildAdjudicator.resume → enrichResumeState) for
    // an admin: refund re-projects via buildOpsRefundResumeState. Mirror it here.
    resume: async (envelope, _state, policy, receipt) => {
      const env = envelope as IntentEnvelope;
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      const paymentId =
        typeof payload.paymentId === "string" ? payload.paymentId : "";
      const opsState = buildOpsRefundResumeState(
        paymentId === "" ? null : paymentById(paymentId),
        "ibatexas",
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
 *  responder call (no tools) → grounded text. */
function scriptedModel(
  plannerToolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
): ModelProvider {
  // Fire the tool call ONCE — the staff's first message triggers the refund plan.
  // A follow-up "sim"/"não"/"amanhã" turn does NOT re-propose a refund (the model
  // reads it as a reply, not a fresh command), so the planner returns no tool call.
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
  writeAdjudicatedRefund: ReturnType<typeof vi.fn>;
  publishPaymentStatusChanged: ReturnType<typeof vi.fn>;
  appendRefundEventLog: ReturnType<typeof vi.fn>;
}

function buildHarness(opts: {
  toolCalls: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  activePayment?: typeof ACTIVE_PAID | null;
  paymentById?: (id: string) => typeof ACTIVE_PAID | null;
}) {
  const session = makeStatefulSession();
  const spies: HarnessSpies = {
    writeAdjudicatedRefund: vi.fn(async () => ({
      version: 4,
      previousStatus: "paid",
      newStatus: "refunded",
      totalRefundedCentavos: 5_000,
      refundAmountCentavos: 5_000,
      orderId: "order_4242",
      method: "pix",
    })),
    publishPaymentStatusChanged: vi.fn(async () => {}),
    appendRefundEventLog: vi.fn(async () => {}),
  };
  const tools = createOpsToolRegistry({
    medusaAdjudicated: (async () => ({})) as never,
    auditSink: noopSink as never,
    orderCmdSvc: {
      writeAdjudicatedNote: vi.fn(),
      writeAdjudicatedStatusTransition: vi.fn(),
    },
    publishOrderStatusChanged: vi.fn(),
    paymentCmdSvc: { writeAdjudicatedRefund: spies.writeAdjudicatedRefund },
    publishPaymentStatusChanged: spies.publishPaymentStatusChanged,
    appendRefundEventLog: spies.appendRefundEventLog,
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
  const activePayment =
    opts.activePayment === undefined ? ACTIVE_PAID : opts.activePayment;
  const paymentById = opts.paymentById ?? (() => ACTIVE_PAID);
  const deps = {
    adjudicator: makeAdjudicator(paymentById),
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
        lookupOrder: async (orderId) =>
          orderId === "order_4242"
            ? {
                customerId: "cust_1",
                paymentMethod: "pix",
                paymentStatus: "paid",
                totalInCentavos: 10_000,
                fulfillmentStatus: "confirmed",
              }
            : null,
        orderReferenceReads: {
          findByDisplayId: async (d) =>
            d === 4242
              ? [
                  {
                    id: "order_4242",
                    displayId: 4242,
                    customerName: "Maria",
                    fulfillmentStatus: "confirmed",
                    customerId: "cust_1",
                    paymentMethod: "pix",
                    paymentStatus: "paid",
                    totalInCentavos: 10_000,
                  },
                ]
              : [],
          listRecentActive: async () => [],
        },
        lookupActivePayment: async () => activePayment,
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

const REFUND_CALL = (orderRef: string, amount?: number) => ({
  id: "tc-refund",
  name: "express_intent",
  input: {
    capability: "payment.refund.issue",
    payload: {
      orderId: orderRef,
      ...(amount === undefined ? {} : { refundAmountCentavos: amount }),
      reason: "cliente pediu",
    },
  },
});

describe("BKL-085 refunds-by-message — end-to-end park → confirm-resume → EXECUTE", () => {
  it("OWNER: parks a CONFIRM with the amount prompt, then 'sim' EXECUTEs the refund ONCE", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const sessionId = "system:staff:owner1";

    // Turn 1 — the refund parks for confirmation.
    const t1 = await runTurn(deps, "OWNER", "owner1", "reembolsa 50 reais do pedido 4242");
    expect(t1.decision.kind).toBe("REQUEST_CONFIRMATION");
    // The park landed in the session store, keyed to THIS staff session.
    const parks = session.parksFor(sessionId);
    expect(parks).toHaveLength(1);
    // The reply carries the parsed amount + payment ref (the staff confirms the numbers).
    expect(t1.response).toContain("R$ 50,00");
    expect(t1.response).toContain("pay_db_1");
    // No write yet.
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();

    // Turn 2 — "sim, confirma" resumes → EXECUTE → the write runs ONCE.
    const t2 = await runTurn(deps, "OWNER", "owner1", "sim, confirma");
    expect(t2.decision.kind).toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).toHaveBeenCalledTimes(1);
    const [writePayload] = spies.writeAdjudicatedRefund.mock.calls[0]!;
    // The write got the STAMPED payload (DB balance + Capsule identity).
    expect(writePayload.paymentId).toBe("pay_db_1");
    expect(writePayload.refundAmountCentavos).toBe(5_000);
    expect(writePayload.refundableBalanceCentavos).toBe(10_000);
    expect(writePayload.actor).toBe("admin");
    expect(writePayload.actorId).toBe("owner1");
    // The full side-effect chain fired (payment.status_changed publisher).
    expect(spies.publishPaymentStatusChanged).toHaveBeenCalledTimes(1);
    // The park was cleared.
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("'não' after a park → deny → unparked, the write NEVER runs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const sessionId = "system:staff:owner2";
    await runTurn(deps, "OWNER", "owner2", "reembolsa 50 do pedido 4242");
    expect(session.parksFor(sessionId)).toHaveLength(1);
    const t2 = await runTurn(deps, "OWNER", "owner2", "não, cancela");
    expect(t2.decision.kind).not.toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // Denied → unparked.
    expect(session.parksFor(sessionId)).toHaveLength(0);
  });

  it("a defer phrase after a park → deferred, the write NEVER runs", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const sessionId = "system:staff:owner3";
    await runTurn(deps, "OWNER", "owner3", "reembolsa 50 do pedido 4242");
    await runTurn(deps, "OWNER", "owner3", "deixa pra amanhã");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // The confirm park moved to the deferred set (no auto-EXECUTE on the ops plane).
    expect(session.parksFor(sessionId)).toHaveLength(0);
    expect(session.deferredFor(sessionId)).toHaveLength(1);
  });

  it("ATTENDANT → REFUSE staff_role_violation; nothing parks; no write", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    const t = await runTurn(deps, "ATTENDANT", "att1", "reembolsa 50 do pedido 4242");
    expect(t.decision.kind).toBe("REFUSE");
    if (t.decision.kind === "REFUSE") {
      expect(t.decision.refusal.code).toBe("staff_role_violation");
    }
    expect(session.parksFor("system:staff:att1")).toHaveLength(0);
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
  });

  it(">R$1000 → ESCALATE (the taint overlay does NOT pre-empt); nothing parks", async () => {
    const { deps, session } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 150_000)], // R$1500, but balance is only R$100…
      // …so give a big-balance payment so ESCALATE (not over-balance) is exercised.
      activePayment: {
        ...ACTIVE_PAID,
        amountInCentavos: 500_000,
        refundedAmountCentavos: 0,
      },
      paymentById: () => ({
        ...ACTIVE_PAID,
        amountInCentavos: 500_000,
        refundedAmountCentavos: 0,
      }),
    });
    const t = await runTurn(deps, "OWNER", "owner4", "reembolsa 1500 reais do pedido 4242");
    expect(t.decision.kind).toBe("ESCALATE");
    expect(session.parksFor("system:staff:owner4")).toHaveLength(0);
  });

  it("forged payload balances are stamped from the DB; an over-balance refund REFUSEs", async () => {
    const { deps, spies } = buildHarness({
      // Model forges a huge balance AND asks R$90 on a payment whose DB balance is R$100…
      // wait — R$90 < R$100 would pass; ask R$150 to exceed the true R$100 balance.
      toolCalls: [
        {
          id: "tc-forge",
          name: "express_intent",
          input: {
            capability: "payment.refund.issue",
            payload: {
              orderId: "4242",
              refundAmountCentavos: 15_000, // R$150 > true R$100 balance
              refundableBalanceCentavos: 999_999_999, // forged
              amountInCentavos: 999_999_999, // forged
              currentRefundedCentavos: 0,
              actor: "system",
              actorId: "forged",
            },
          },
        },
      ],
    });
    const t = await runTurn(deps, "OWNER", "owner5", "reembolsa 150 do pedido 4242");
    // The kernel decided on the TRUE (stamped) R$100 balance → over-balance REFUSE.
    expect(t.decision.kind).toBe("REFUSE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
  });

  it("a park is staff-session-scoped: a DIFFERENT staff's 'sim' does not resume it", async () => {
    const { deps, session, spies } = buildHarness({
      toolCalls: [REFUND_CALL("4242", 5_000)],
    });
    // owner6 parks a refund.
    await runTurn(deps, "OWNER", "owner6", "reembolsa 50 do pedido 4242");
    expect(session.parksFor("system:staff:owner6")).toHaveLength(1);
    // A DIFFERENT staff session (owner7) says "sim" — its session has NO park, so
    // matchToParked returns null and NOTHING resumes (structural staff-scoping).
    const other = await runTurn(deps, "OWNER", "owner7", "sim, confirma");
    expect(other.decision.kind).not.toBe("EXECUTE");
    expect(spies.writeAdjudicatedRefund).not.toHaveBeenCalled();
    // owner6's park is untouched.
    expect(session.parksFor("system:staff:owner6")).toHaveLength(1);
  });
});
