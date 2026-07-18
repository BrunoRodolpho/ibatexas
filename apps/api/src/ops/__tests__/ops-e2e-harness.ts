// ops-e2e-harness — the shared WS9 layer-1 harness for the ops plane.
//
// This is a TEST UTILITY (not a *.test.ts, so vitest never collects it and Sonar
// excludes __tests__/** from coverage). It factors the fake-model + REAL composed
// policy-router + REAL audited kernel machinery that the ops confirm-resume e2e
// files each hand-rolled, so every ops SCN behaviour is regression-gated
// END-TO-END through composeOpsConductor + a full handleTurn, token-free, in CI.
//
// What it composes (identical to production except the leaves are fakes/spies):
//   - OPS_ROUTER            the EXACT composed policy router the SUBMIT stage gates on.
//   - makeCapturingAuditSink  captures every AuditRecord so tests assert the KERNEL
//                             facts (envelope.kind / decision.kind / actor.role /
//                             decision_basis), not just the reply text.
//   - makeAuditedAdjudicator  a REAL audited adjudicator (adjudicateAndAudit) with a
//                             PLUGGABLE resume-state projector (refund re-projects the
//                             payment; price re-projects the pricing; availability has
//                             no resume — mirrors production buildAdjudicator.resume).
//   - makeStatefulSession   an in-memory SessionPort whose park/unpark/parkDeferred
//                             persist, so a two-turn park → confirm-resume flow works.
//   - scriptedModel         a planner/responder fake: planner call (tools present) →
//                             the express_intent (or a read) tool call, fired ONCE;
//                             responder call (no tools) → grounded text. The once-latch
//                             makes turn-2 "sim"/"não" read as a reply, not a re-command,
//                             AND lets a read tool run then the responder render.
//   - buildOpsTools         the createOpsToolRegistry wiring + typed default spies.
//   - composeOpsDeps        the invariant conductor deps (memory/grounding/telemetry/
//                             tenant/lock/systemChannel/modelId) around the scenario bits.
//   - runOpsTurn            open a Capsule with the AUTHENTICATED staff actor, run one
//                             handleTurn, close the Capsule; return decision + reply.
//
// The seam this proves is the security crux: the envelope authority the kernel
// gates on is stamped by the planner's staffEnvelopeActor (admin:<staffId> + role)
// — NEVER the model. A live-model smoke of the same behaviours (real stack + real
// model + governed DB seed) lives in scripts/ops-live-smoke.mjs (opt-in, not CI).

import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";
import {
  buildEnvelope,
  type AuditRecord,
  type AuditSink,
  type Decision,
  type DecisionBasis,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
  type Completion,
  type CompletionRequest,
  type ConfirmationReceipt,
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
  OpsSystemChannel,
  opsConfirmParkExpiresAt,
} from "../ops-system-channel.js";
import { buildLanguageEngineAuditMetadata } from "../../claustrum/language-engine/audit-metadata.js";

/** Staff roles the ops matrix knows about. */
export type StaffRole = "OWNER" | "MANAGER" | "ATTENDANT";

/**
 * The instant every harness park is stamped with (makeStatefulSession) AND the
 * default inbound `receivedAt` — so a park is FRESH (age 0) under any confirm-TTL
 * and the existing confirm-resume e2e arms are byte-identical after FE-D13. A stale
 * arm passes a LATER `receivedAt` to `runOpsTurn`/`inbound` to age a park past the
 * TTL; {@link staleReceivedAt} builds one deterministically (no fake timers).
 */
export const HARNESS_PARKED_AT = "2026-07-04T12:00:00.000Z";

/** An inbound receivedAt `seconds` after {@link HARNESS_PARKED_AT} (FE-D13 stale arms). */
export function staleReceivedAt(seconds: number): string {
  return new Date(Date.parse(HARNESS_PARKED_AT) + seconds * 1000).toISOString();
}

/** A scripted planner tool call (express_intent, or a read tool like ops_snapshot). */
export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

// ── The EXACT composed router the conductor SUBMIT stage adjudicates against ──
export const OPS_ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

export const noopTelemetry: TelemetryPort = {
  emitTurn: async () => {},
  emitLLMTrace: async () => {},
  emitMemoryAccess: async () => {},
};

export const inMemoryLock: SessionLock = {
  acquire: async (key) => ({ key, release: async () => {} }),
};

// ── A capturing audit sink — the primitive that makes KERNEL facts assertable ──
export interface CapturingAuditSink extends AuditSink {
  /** Every record the kernel emitted, in order. */
  readonly records: AuditRecord[];
  /** Records whose envelope.kind matches. */
  byKind(kind: string): AuditRecord[];
  /** The last record whose decision.kind matches (or undefined). */
  lastDecision(kind: Decision["kind"]): AuditRecord | undefined;
  /** True if any record for `kind` carries a decision_basis with `code`. */
  hasBasis(kind: string, code: string): boolean;
  /** The decision_basis entries (across all records for `kind`) with `code`. */
  basesFor(kind: string, code: string): DecisionBasis[];
}

/** A sink that records every emit so a test can assert the governance trail. */
export function makeCapturingAuditSink(): CapturingAuditSink {
  const records: AuditRecord[] = [];
  return {
    emit: async (record: AuditRecord) => {
      records.push(record);
    },
    records,
    byKind: (kind) => records.filter((r) => String(r.envelope.kind) === kind),
    lastDecision: (kind) =>
      [...records].reverse().find((r) => r.decision.kind === kind),
    hasBasis: (kind, code) =>
      records
        .filter((r) => String(r.envelope.kind) === kind)
        .some((r) => r.decision_basis.some((b) => b.code === code)),
    basesFor: (kind, code) =>
      records
        .filter((r) => String(r.envelope.kind) === kind)
        .flatMap((r) => r.decision_basis.filter((b) => b.code === code)),
  };
}

/**
 * A REAL audited adjudicator over the composed router. `projectResumeState`
 * mirrors production's buildAdjudicator.resume → enrichResumeState: for a
 * confirm-resume it RE-PROJECTS the ops state (fresh DB read) from the parked
 * envelope before re-adjudicating with the confirmation receipt (CONFIRM→EXECUTE).
 * Availability passes no projector (it EXECUTEs on the first turn — never parks).
 *
 * FE-T05b — MAY return a `Promise<unknown>` (awaited below) so a scenario can
 * wire in the REAL, exported `enrichResumeState` from claustrum-bootstrap.ts
 * directly (a DB-backed async re-projection), rather than a hand-authored
 * synchronous mirror of it — the live-disprove root cause (intent_audit
 * 3362/3366) was a WIRING gap inside `enrichResumeState` itself that a
 * hand-rolled mirror could not have caught (it "mirrored" a wrong assumption
 * instead of exercising the real dispatch). Existing synchronous projectors
 * are unaffected — `await`ing a non-Promise value resolves immediately.
 */
export function makeAuditedAdjudicator(opts: {
  sink: AuditSink;
  projectResumeState?: (envelope: IntentEnvelope) => unknown | Promise<unknown>;
}): Adjudicator {
  const { sink, projectResumeState } = opts;
  const decideWith = async (
    envelope: IntentEnvelope,
    state: unknown,
    policy: unknown,
    receipt?: ConfirmationReceipt,
  ): Promise<Decision> =>
    (
      await adjudicateAndAudit(envelope, state as never, policy as never, {
        sink,
        // FE-T05 — mirrors production's safeAuditedAdjudicate wiring
        // (claustrum-bootstrap.ts) so the ops e2e harness observes the SAME
        // AuditRecord.metadata shape a real turn would produce.
        metadataProvider: buildLanguageEngineAuditMetadata,
        ...(receipt ? { confirmationReceipt: receipt } : {}),
      })
    ).decision;

  return {
    adjudicate: async (envelope, state, policy) =>
      decideWith(envelope as IntentEnvelope, state, policy),
    adjudicatePlan: async (envelopes, state, policy, perStates) => {
      const env = envelopes[0] as IntentEnvelope | undefined;
      if (env === undefined) {
        return decideWith(
          buildEnvelope({
            kind: "noop",
            payload: {},
            actor: { principal: "system", sessionId: "system:x" },
            taint: "SYSTEM",
            nonce: "n",
          }) as IntentEnvelope,
          state,
          policy,
        );
      }
      return decideWith(env, perStates?.[0] ?? state, policy);
    },
    resume: async (envelope, state, policy, receipt) => {
      const env = envelope as IntentEnvelope;
      const resumeState = projectResumeState
        ? await projectResumeState(env)
        : state;
      return decideWith(env, resumeState, policy, receipt as ConfirmationReceipt);
    },
    replayEnvelopesByCustomerId: async () => [],
    streamAuditByIntentHashPrefix: async function* () {},
    getOutcomes: async () => [],
    verifyAuditRecord: () => ({ ok: true }),
  };
}

/** A stateful in-memory session store: park / load / unpark / parkDeferred persist. */
export interface StatefulSession extends SessionPort {
  parksFor(sessionId: string): ParkedEnvelope[];
  deferredFor(sessionId: string): DeferredEnvelope[];
}

export function makeStatefulSession(): StatefulSession {
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
        workingMemory: {
          summary: "",
          facts: [],
          updatedAt: "2026-07-04T00:00:00.000Z",
        },
      } satisfies Session;
    },
    save: async () => {},
    parkPendingConfirmation: async (
      sessionId,
      envelope,
      confirmationToken,
      userPrompt,
    ) => {
      const list = parks.get(sessionId) ?? [];
      // Mirror the production SessionPort (claustrum-bootstrap.ts): stamp the
      // FE-D33 forward-compat expiresAt on the ops plane so a real park-flow e2e
      // observes the same entry shape a production park would produce.
      const expiresAt = opsConfirmParkExpiresAt(sessionId, HARNESS_PARKED_AT);
      list.push({
        envelope: envelope as IntentEnvelope,
        confirmationToken,
        userPrompt,
        parkedAt: HARNESS_PARKED_AT,
        ...(expiresAt ? { expiresAt } : {}),
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
        parkedAt: HARNESS_PARKED_AT,
      });
      deferred.set(sessionId, list);
    },
    unpark: async (sessionId, intentHash) => {
      parks.set(
        sessionId,
        (parks.get(sessionId) ?? []).filter(
          (p) => p.envelope.intentHash !== intentHash,
        ),
      );
      deferred.set(
        sessionId,
        (deferred.get(sessionId) ?? []).filter(
          (d) => d.envelope.intentHash !== intentHash,
        ),
      );
    },
    parksFor: (sessionId) => parks.get(sessionId) ?? [],
    deferredFor: (sessionId) => deferred.get(sessionId) ?? [],
  };
}

/**
 * A scripted planner/responder model. On a planner call (tools present) it fires
 * the scripted tool call(s) ONCE, then behaves as a plain responder (no tools →
 * grounded text). The once-latch is what lets a follow-up "sim"/"não" turn read
 * as a reply (not a re-command), and lets a read tool run then the responder
 * render on the re-plan. `.complete` is the vi mock, so tests can assert calls.
 */
export function scriptedModel(
  toolCalls: ReadonlyArray<ScriptedToolCall>,
  opts: { responderText?: string } = {},
): ModelProvider {
  const responderText = opts.responderText ?? "Ok.";
  let fired = false;
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    const isPlanner = (req.tools?.length ?? 0) > 0;
    const emit = isPlanner && !fired;
    if (emit) fired = true;
    const emittedCalls = emit ? toolCalls : [];
    return {
      model: "mock",
      stopReason: "end_turn",
      // FE-T01 (D4): live-verified against nemotron-3-nano:4b — a planner pass
      // that emits NO tool call still says SOMETHING in `text` (the real
      // customer/ops reply is a SEPARATE responder completion; this text is
      // never rendered). Empty text is realistic ONLY alongside an actual
      // tool call. Mirroring that here keeps every "no additional intent"
      // planner pass out of the genuinely-empty-completion repair-or-refuse
      // path (`isGenuinelyEmptyCompletion` in ibatexas-planner.ts).
      text: isPlanner
        ? emittedCalls.length > 0
          ? ""
          : "ok (mock planner pass — nothing to propose)"
        : responderText,
      toolCalls: [...emittedCalls],
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

/** The full set of ops mutation-executor spies (defaults are inert no-ops). */
export interface OpsToolSpies {
  medusaAdjudicated: ReturnType<typeof vi.fn>;
  readProductBrlVariantIds: ReturnType<typeof vi.fn>;
  writeAdjudicatedNote: ReturnType<typeof vi.fn>;
  writeAdjudicatedStatusTransition: ReturnType<typeof vi.fn>;
  publishOrderStatusChanged: ReturnType<typeof vi.fn>;
  // SCN-114 — the daily-special upsert service spies (list/create/update).
  dailySpecialList: ReturnType<typeof vi.fn>;
  dailySpecialCreate: ReturnType<typeof vi.fn>;
  dailySpecialUpdate: ReturnType<typeof vi.fn>;
  writeAdjudicatedRefund: ReturnType<typeof vi.fn>;
  publishPaymentStatusChanged: ReturnType<typeof vi.fn>;
  appendRefundEventLog: ReturnType<typeof vi.fn>;
  resolveAlertFromEnvelope: ReturnType<typeof vi.fn>;
  closeIncidentFromEnvelope: ReturnType<typeof vi.fn>;
  upsertOverride: ReturnType<typeof vi.fn>;
  invalidateScheduleCache: ReturnType<typeof vi.fn>;
}

/**
 * Build the ops tool registry with typed default spies; pass overrides for the
 * one or two executors a scenario asserts. Returns the registry + the spies so a
 * test can assert exact egress args / call counts.
 */
export function buildOpsTools(
  overrides: Partial<OpsToolSpies> = {},
  auditSink: AuditSink = { emit: async () => {} } as AuditSink,
): { tools: ReturnType<typeof createOpsToolRegistry>; spies: OpsToolSpies } {
  const spies: OpsToolSpies = {
    medusaAdjudicated:
      overrides.medusaAdjudicated ??
      vi.fn(async () => ({ product: { id: "prod_1" } })),
    readProductBrlVariantIds:
      overrides.readProductBrlVariantIds ?? vi.fn(async () => ["variant_1"]),
    writeAdjudicatedNote: overrides.writeAdjudicatedNote ?? vi.fn(),
    writeAdjudicatedStatusTransition:
      overrides.writeAdjudicatedStatusTransition ?? vi.fn(),
    publishOrderStatusChanged: overrides.publishOrderStatusChanged ?? vi.fn(),
    // SCN-114 — default: no existing special for the day (list empty), so the
    // upsert CREATEs; a dedicated e2e overrides these to assert the upsert path.
    dailySpecialList: overrides.dailySpecialList ?? vi.fn(async () => []),
    dailySpecialCreate:
      overrides.dailySpecialCreate ?? vi.fn(async () => ({ id: "special_1" })),
    dailySpecialUpdate:
      overrides.dailySpecialUpdate ?? vi.fn(async () => ({ id: "special_1" })),
    writeAdjudicatedRefund:
      overrides.writeAdjudicatedRefund ??
      vi.fn(async () => ({
        version: 4,
        previousStatus: "paid",
        newStatus: "refunded",
        totalRefundedCentavos: 5_000,
        refundAmountCentavos: 5_000,
        orderId: "order_4242",
        method: "pix",
      })),
    publishPaymentStatusChanged:
      overrides.publishPaymentStatusChanged ?? vi.fn(),
    appendRefundEventLog: overrides.appendRefundEventLog ?? vi.fn(),
    resolveAlertFromEnvelope:
      overrides.resolveAlertFromEnvelope ??
      vi.fn(async () => ({ result: { status: "RESOLVED" } })),
    closeIncidentFromEnvelope:
      overrides.closeIncidentFromEnvelope ??
      vi.fn(async () => ({ result: { status: "RESOLVED" } })),
    upsertOverride:
      overrides.upsertOverride ??
      vi.fn(async (date: string, data: { isOpen: boolean }) => ({
        date,
        isOpen: data.isOpen,
      })),
    invalidateScheduleCache:
      overrides.invalidateScheduleCache ?? vi.fn(async () => ({ ok: true })),
  };
  const tools = createOpsToolRegistry({
    medusaAdjudicated: spies.medusaAdjudicated as never,
    auditSink: auditSink as never,
    readProductBrlVariantIds: spies.readProductBrlVariantIds as never,
    orderCmdSvc: {
      writeAdjudicatedNote: spies.writeAdjudicatedNote,
      writeAdjudicatedStatusTransition: spies.writeAdjudicatedStatusTransition,
    },
    dailySpecialSvc: {
      list: spies.dailySpecialList as never,
      create: spies.dailySpecialCreate as never,
      update: spies.dailySpecialUpdate as never,
    },
    publishOrderStatusChanged: spies.publishOrderStatusChanged,
    paymentCmdSvc: { writeAdjudicatedRefund: spies.writeAdjudicatedRefund },
    publishPaymentStatusChanged: spies.publishPaymentStatusChanged,
    appendRefundEventLog: spies.appendRefundEventLog,
    opsAlertSvc: { resolveAlertFromEnvelope: spies.resolveAlertFromEnvelope },
    incidentSvc: { closeIncidentFromEnvelope: spies.closeIncidentFromEnvelope },
    scheduleSvc: { upsertOverride: spies.upsertOverride as never },
    invalidateScheduleCache: spies.invalidateScheduleCache as never,
  });
  return { tools, spies };
}

/** The invariant TenantResolver — always the ops tenant + composed router. */
export const opsTenantResolver: TenantResolver = {
  resolve: async ({ channel, customerId }) => ({
    tenant: {
      tenantId: "ibatexas",
      displayName: "IbateXas",
      locale: "pt-BR",
      environment: "dev",
    },
    state: { channel, customerId },
    policy: OPS_ROUTER,
  }),
};

/** The scenario-specific conductor bits; the invariant rest is filled in. */
export interface OpsDepsScenario {
  adjudicator: Adjudicator;
  session: SessionPort;
  tools: ReturnType<typeof createOpsToolRegistry>;
  model: ModelProvider;
  /** The per-turn resolver (name/order-ref/pricing/payment reads). */
  buildResolver: (staffId: string) => unknown;
  /** Read-tool executors (e.g. { ops_snapshot }); default none. */
  opsReadToolExecutors?: Record<string, unknown>;
  /**
   * AUT-017 — the HandoffPort. Default is the inert no-op. The escalate-approve
   * e2e injects a PARKING handoff so an ESCALATE parks the resumable money intent
   * (the seam the real `natsHandoff(publish, parkDeps)` drives in production).
   */
  handoff?: { queue: (envelope: IntentEnvelope, reason: string) => Promise<void> };
}

/** Assemble the full conductor deps around the scenario-specific pieces. */
export function composeOpsDeps(scenario: OpsDepsScenario) {
  return {
    adjudicator: scenario.adjudicator,
    memory: noopMemoryProvider(),
    grounding: noopGroundingProvider("mock"),
    explainer: { render: (r: { userFacing: string }) => r.userFacing },
    handoff: scenario.handoff ?? { queue: async () => {} },
    telemetry: noopTelemetry,
    session: scenario.session,
    tenantResolver: opsTenantResolver,
    sessionLock: inMemoryLock,
    systemChannel: new OpsSystemChannel({
      gatewaySigningKey: "test-ops-signing-key-abcdefghijklmnop",
      gateway: "ibatexas-ops-test",
    }),
    tools: scenario.tools,
    model: scenario.model,
    modelId: "mock",
    opsReadToolExecutors: scenario.opsReadToolExecutors ?? {},
    buildResolver: scenario.buildResolver,
  };
}

/**
 * The inbound "system"-channel staff message the ops conductor turns on. `receivedAt`
 * defaults to {@link HARNESS_PARKED_AT} (age-0 vs a harness park — FRESH); a stale arm
 * passes a later instant (see {@link staleReceivedAt}) to drive the FE-D13 TTL filter.
 */
export function inbound(
  staffId: string,
  text: string,
  receivedAt: string = HARNESS_PARKED_AT,
): ChannelMessage {
  return {
    channel: "system",
    customerId: `staff:${staffId}`,
    conversationId: `admin:${staffId}`,
    externalId: `ops-${staffId}-${randomUUID()}`,
    text,
    receivedAt,
    locale: "pt-BR",
  };
}

/** The outcome of one ops turn — decision + rendered reply + dispatch record. */
export interface OpsTurnResult {
  decision: Decision;
  response: string;
  acted: unknown;
  plan: unknown;
}

/**
 * Open a Capsule with the AUTHENTICATED staff actor (admin:<staffId> + role —
 * never model-derived), run one handleTurn, close the Capsule. This is the exact
 * envelope-authority path the /api/admin/ops/chat route drives in production.
 */
export async function runOpsTurn(
  deps: unknown,
  args: { role: StaffRole; staffId: string; text: string; receivedAt?: string },
): Promise<OpsTurnResult> {
  const { role, staffId, text, receivedAt } = args;
  const conductor = composeOpsConductor(deps as never, { staffId, role });
  const message = inbound(staffId, text, receivedAt);
  const capsule = await conductor.openCapsule({
    channel: "system",
    customerId: `staff:${staffId}`,
    sessionKey: `ops:${staffId}`,
    actor: {
      principal: "user",
      role: "staff",
      sessionId: `admin:${staffId}`,
      staffId,
    },
    inbound: message,
  });
  try {
    const turn = await handleTurn(capsule, message);
    return {
      decision: turn.decision as Decision,
      response: turn.response.text,
      acted: turn.acted,
      plan: turn.plan,
    };
  } finally {
    await conductor.closeCapsule(capsule);
  }
}
