// reservation-cancel-resume-dedup — BKL-242's regression gate.
//
// A single customer confirm ("sim") on a parked `reservation.cancel` produced
// TWO `reservation.cancel` EXECUTE audit rows (live: intent_audit pair
// 6712/6714 under ONE turn_trace, 1dc9a6b8, 5.23s apart). The first row is the
// Conductor's receipt-bound, ledger-claimed re-adjudication of the PARKED
// envelope; the second is a FRESH envelope the `cancel_reservation` tool minted
// for itself during dispatch (`nonce: randomUUID()`, payload without
// `customerId`) and adjudicated a second time through `withAdjudicate` — which
// is wired with no execution ledger. Two structurally-different envelopes ⇒ two
// different `intentHash`es ⇒ the ledger's `ledger:intent:<hash>` SET-NX could
// never recognize the duplicate.
//
// This is the SAME defect class as BKL-232 (`reservation.modify`, PR #386), and
// this file is the sibling of `reservation-modify-resume-dedup.e2e.test.ts` —
// deliberately so: the two read side by side, and a future third instance of the
// class should be added the same way.
//
// This file drives the REAL turn seam — `handleTurn` → `resolveResume` →
// the REAL audited kernel (`adjudicateAndAudit`) over the REAL composed policy
// router → the REAL `dispatchDecision` → the REAL registered
// `reservation.cancel` tool executor. Only the leaves are fakes: the model is
// scripted, the reservation service is a spy, and the audit sink + execution
// ledger are in-memory so the test can COUNT what the kernel emitted and
// claimed. A renderer-or-below unit test cannot see this bug at all — the
// second EXECUTE is emitted by the tool, on the far side of dispatch.
//
// `getAuditSink` is mocked to the SAME capturing sink the Conductor's
// adjudicator writes to, so a tool-side re-adjudication would land in the very
// collection these tests count. That is what makes "exactly ONE EXECUTE" a real
// assertion rather than a tautology.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope, type Decision, type IntentEnvelope } from "@adjudicate/core";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";
import { createMemoryLedger } from "@adjudicate/audit";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
  type CognitiveState,
  type ConfirmationReceipt,
  type DraftResponse,
  type ParkedEnvelope,
  type Plan,
  type Session,
  type SessionPort,
  type TenantResolver,
} from "@claustrum/core";
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import { composePolicyRouter } from "../claustrum/capability-policy.js";
import {
  noopMemoryProvider,
  noopGroundingProvider,
} from "../claustrum/noop-memory-grounding.js";
import { WebConfirmChannel } from "../claustrum/web-confirm-channel.js";
import { registerIbatexasToolPacks } from "../tools/register-ibatexas-tool-packs.js";
import {
  makeCapturingAuditSink,
  inMemoryLock,
  noopTelemetry,
  type CapturingAuditSink,
} from "../ops/__tests__/ops-e2e-harness.js";

// ── Leaves ───────────────────────────────────────────────────────────────────

const CUSTOMER_ID = "cus_bkl242";
const RESERVATION_ID = "res_bkl242";
const SESSION_ID = `web:${CUSTOMER_ID}`;
const PARKED_AT = "2026-07-24T21:14:07.310Z";
const CONFIRMED_AT = "2026-07-24T21:14:12.540Z";

/** The reservation DTO `reservationService.getById` resolves with. */
const RESERVATION_DTO = {
  id: RESERVATION_ID,
  customerId: CUSTOMER_ID,
  status: "confirmed",
  partySize: 2,
  specialRequests: [],
  tableLocation: "indoor",
  timeSlot: { id: "slot_1", date: "2026-07-30", startTime: "20:00" },
  tables: [],
};

/**
 * The single spy that proves how many times the MUTATION ran, independent of
 * how many times the kernel was asked.
 */
const mockCancel = vi.hoisted(() => vi.fn());
const mockGetById = vi.hoisted(() => vi.fn());
const mockPromoteWaitlist = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetAuditSink = vi.hoisted(() => vi.fn());
/**
 * The one reservation row. Read by SEC-002's `assertReservationOwnership`
 * (`select customerId`).
 */
const mockReservationFindUnique = vi.hoisted(() => vi.fn());
/**
 * The kernel-only slot hydration. Post-fix the pre-adjudicated path must not
 * reach for it at all — one of the assertions below pins that.
 */
const mockTimeSlotFindUnique = vi.hoisted(() => vi.fn(async () => null));

// Narrow overrides only — a flat factory would stub the other 10
// `@ibatexas/domain` exports the tools package imports as `undefined` (the
// PR #248 vi.mock saga). `index.ts` has no top-level side effects, so
// `importOriginal` is safe.
//
// CRITICAL: `cancelFromEnvelope` is left REAL. It is the second-adjudication
// path this ticket is about — real `withAdjudicate`, real
// `reservationsPolicyBundle`, real audit emit into `getAuditSink()`. Stubbing it
// (or hand-authoring a mirror of it) would make the pre-fix double EXECUTE
// invisible and the assertions below vacuous. Only the leaves move: the write
// (`cancel`) is a spy and prisma is stubbed. Spreading the real service and
// overriding `cancel` is what lets the real `cancelFromEnvelope` run while its
// `this.cancel(...)` executor resolves to the spy.
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return {
    ...actual,
    createReservationService: (opts?: unknown) => ({
      ...actual.createReservationService(
        opts as Parameters<typeof actual.createReservationService>[0],
      ),
      getById: mockGetById,
      cancel: mockCancel,
      promoteWaitlist: mockPromoteWaitlist,
    }),
    // Only the two tables this turn touches. Anything else reaching for prisma
    // in this graph should fail loudly rather than silently hit a real DB.
    prisma: {
      reservation: { findUnique: mockReservationFindUnique },
      timeSlot: { findUnique: mockTimeSlotFindUnique },
    },
  };
});

// The tool calls `getAuditSink()` unconditionally (it threads a sink into the
// reservation service). Point it at the capturing sink so ANY tool-side
// adjudication is observable by the assertions below.
vi.mock("@ibatexas/audit-sink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/audit-sink")>();
  return { ...actual, getAuditSink: mockGetAuditSink };
});

vi.mock("@ibatexas/nats-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/nats-client")>();
  return { ...actual, publishNatsEvent: mockPublishNatsEvent };
});

// ── The REAL composed policy router the SUBMIT stage gates on ────────────────

const ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

// ── Customer-plane session store (web:<customerId>, park/unpark persist) ──────

interface WebSession extends SessionPort {
  parksFor(sessionId: string): ParkedEnvelope[];
  /** Re-park an envelope verbatim — the redelivery/retry reproduction. */
  repark(sessionId: string, park: ParkedEnvelope): void;
}

function makeWebSession(): WebSession {
  const parks = new Map<string, ParkedEnvelope[]>();
  return {
    load: async (customerId) =>
      ({
        id: `web:${customerId}`,
        customerId,
        channel: "web",
        startedAt: PARKED_AT,
        lastActivityAt: PARKED_AT,
        pendingConfirmations: parks.get(`web:${customerId}`) ?? [],
        deferredEnvelopes: [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: PARKED_AT },
      }) satisfies Session,
    save: async () => {},
    parkPendingConfirmation: async (
      sessionId,
      envelope,
      confirmationToken,
      userPrompt,
    ) => {
      const list = parks.get(sessionId) ?? [];
      // Customer web parks carry NO expiresAt (web-confirm-channel.ts header).
      list.push({
        envelope: envelope as IntentEnvelope,
        confirmationToken,
        userPrompt,
        parkedAt: PARKED_AT,
      });
      parks.set(sessionId, list);
    },
    parkDeferred: async () => {},
    unpark: async (sessionId, intentHash) => {
      parks.set(
        sessionId,
        (parks.get(sessionId) ?? []).filter(
          (p) => p.envelope.intentHash !== intentHash,
        ),
      );
    },
    parksFor: (sessionId) => parks.get(sessionId) ?? [],
    repark: (sessionId, park) => {
      parks.set(sessionId, [...(parks.get(sessionId) ?? []), park]);
    },
  };
}

// ── The REAL audited adjudicator, WITH an execution ledger ───────────────────

/**
 * Mirrors production's `safeAuditedAdjudicate` (claustrum-bootstrap.ts): every
 * verb — including `resume` — runs through `adjudicateAndAudit` with the SAME
 * sink AND the SAME ledger, so the `intentHash` dedup is live exactly as it is
 * in production (Hard Rule #9: always-on, fail-closed).
 */
function makeLedgeredAdjudicator(opts: {
  sink: CapturingAuditSink;
  ledger: ReturnType<typeof createMemoryLedger>;
  projectResumeState: (envelope: IntentEnvelope) => unknown | Promise<unknown>;
}): Adjudicator {
  const { sink, ledger, projectResumeState } = opts;
  const decide = async (
    envelope: IntentEnvelope,
    state: unknown,
    policy: unknown,
    receipt?: ConfirmationReceipt,
  ): Promise<Decision> =>
    (
      await adjudicateAndAudit(envelope, state as never, policy as never, {
        sink,
        ledger,
        ...(receipt ? { confirmationReceipt: receipt } : {}),
      })
    ).decision;

  return {
    adjudicate: async (envelope, state, policy) =>
      decide(envelope as IntentEnvelope, state, policy),
    adjudicatePlan: async (envelopes, state, policy, perStates) => {
      const env = envelopes[0] as IntentEnvelope | undefined;
      if (env === undefined) throw new Error("empty plan unused in this suite");
      return decide(env, perStates?.[0] ?? state, policy);
    },
    resume: async (envelope, state, policy, receipt) => {
      const env = envelope as IntentEnvelope;
      return decide(
        env,
        await projectResumeState(env),
        policy,
        receipt as ConfirmationReceipt,
      );
    },
    replayEnvelopesByCustomerId: async () => [],
    streamAuditByIntentHashPrefix: async function* () {},
    getOutcomes: async () => [],
    verifyAuditRecord: () => ({ ok: true }),
  };
}

// ── State projections ────────────────────────────────────────────────────────

/** The live reservation the pack's state guards read. */
const RESERVATION_CTX = {
  id: RESERVATION_ID,
  status: "confirmed" as const,
  partySize: 2,
  timeSlotId: "slot_1",
};

/**
 * PLAN-stage state. `autoResolvedMoneyRef: true` is what parked the live
 * envelope: the customer said "cancela minha reserva" without naming one, the
 * resolver auto-resolved it to their single active reservation, and the composed
 * router's `confirmOnAutoResolveGuard` REQUEST_CONFIRMATIONs ("Identifiquei a
 * sua reserva mais recente… Confirma que é essa mesma?").
 *
 * `slot: null` keeps the pack's OTHER confirm gate — `confirmLastMinuteCancel`,
 * which reads `ctx.slot.startAt` + `ctx.now` — deliberately inert, so the park
 * under test is unambiguously the auto-resolve one and the resume leg is not
 * re-parked by a second gate.
 */
const PLAN_STATE = {
  ctx: {
    channel: "web",
    customerId: CUSTOMER_ID,
    staffId: null,
    now: new Date(PARKED_AT),
    reservation: RESERVATION_CTX,
    slot: null,
    autoResolvedMoneyRef: true,
  },
};

/**
 * RESUME-stage state. Mirrors production `enrichResumeState`: the parked
 * envelope carries the RESOLVED reservationId, so the ctx is re-projected from
 * a FRESH read and the auto-resolve flag is deliberately NOT re-set — which is
 * what lets the confirmation receipt flip REQUEST_CONFIRMATION → EXECUTE.
 */
const RESUME_STATE = {
  ctx: { ...PLAN_STATE.ctx, autoResolvedMoneyRef: false },
};

// ── Harness ──────────────────────────────────────────────────────────────────

/** The parked intent: "cancela a minha reserva". */
function cancelEnvelope(): IntentEnvelope {
  return buildEnvelope({
    kind: "reservation.cancel",
    payload: {
      customerId: CUSTOMER_ID,
      reservationId: RESERVATION_ID,
    },
    actor: { principal: "llm", sessionId: `web:${CUSTOMER_ID}` },
    taint: "UNTRUSTED",
    nonce: "n-bkl242-parked",
    createdAt: PARKED_AT,
  }) as IntentEnvelope;
}

function buildHarness() {
  const sink = makeCapturingAuditSink();
  const ledger = createMemoryLedger();
  const session = makeWebSession();
  mockGetAuditSink.mockReturnValue(sink);

  const tools = createToolRegistry();
  registerIbatexasToolPacks(tools);

  const adjudicator = makeLedgeredAdjudicator({
    sink,
    ledger,
    projectResumeState: () => RESUME_STATE,
  });

  // Turn 1 proposes the cancel; every later turn proposes nothing. The resume
  // path never consults the planner (handleTurn skips PLAN when a park matched),
  // so this only has to set the park up.
  let proposed = false;
  const planner = {
    propose: async (_state: CognitiveState): Promise<Plan> => {
      if (proposed) return { envelopes: [] };
      proposed = true;
      return { envelopes: [cancelEnvelope()] };
    },
  };

  const tenantResolver: TenantResolver = {
    resolve: async () => ({
      tenant: {
        tenantId: "ibatexas",
        displayName: "IbateXas",
        locale: "pt-BR",
        environment: "dev",
      },
      state: PLAN_STATE,
      policy: ROUTER,
    }),
  };

  const conductor = createConductor({
    adjudicator,
    memory: noopMemoryProvider(),
    grounding: noopGroundingProvider("mock"),
    planner,
    responder: {
      respond: async (): Promise<DraftResponse> => ({ text: "Ok." }),
    },
    explainer: { render: (r: { userFacing: string }) => r.userFacing },
    handoff: { queue: async () => {} },
    telemetry: noopTelemetry,
    session,
    tools,
    channels: [
      new WebConfirmChannel({
        gatewaySigningKey: "ibx-test-web-signing-key-0123456789abcdef",
        gateway: "ibatexas-web-test",
        sink: async () => {},
      }),
    ],
    tenantResolver,
    sessionLock: inMemoryLock,
  });

  return { conductor, session, sink, ledger };
}

function inbound(text: string, receivedAt: string): ChannelMessage {
  return {
    channel: "web",
    customerId: CUSTOMER_ID,
    conversationId: SESSION_ID,
    externalId: `web-${receivedAt}`,
    text,
    receivedAt,
    locale: "pt-BR",
  };
}

/**
 * One real turn. `acted` is returned deliberately: `dispatchDecision` swallows a
 * tool throw into `{kind:"failed", code:"tool_threw"}` and `handleTurn` still
 * reports the EXECUTE decision, so a test that asserts only the decision can
 * pass while the tool never ran (the FE-T05b / LE2-002 trap). Every EXECUTE arm
 * below asserts `acted.kind === "executed"`.
 */
async function runTurn(
  conductor: ReturnType<typeof buildHarness>["conductor"],
  text: string,
  receivedAt: string,
): Promise<{ decision: Decision; acted: { kind: string; code?: string; message?: string } }> {
  const message = inbound(text, receivedAt);
  const capsule = await conductor.openCapsule({
    channel: "web",
    customerId: CUSTOMER_ID,
    sessionKey: SESSION_ID,
    actor: { principal: "user", sessionId: `web:${CUSTOMER_ID}` },
    inbound: message,
  });
  try {
    const turn = await handleTurn(capsule, message);
    return {
      decision: turn.decision as Decision,
      acted: turn.acted as { kind: string; code?: string; message?: string },
    };
  } finally {
    await conductor.closeCapsule(capsule);
  }
}

/** EXECUTE audit records for `reservation.cancel`, across BOTH adjudication paths. */
const cancelExecutes = (sink: CapturingAuditSink) =>
  sink.byKind("reservation.cancel").filter((r) => r.decision.kind === "EXECUTE");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetById.mockResolvedValue(RESERVATION_DTO);
  mockCancel.mockResolvedValue({ timeSlotId: "slot_1", partySize: 2 });
  mockPromoteWaitlist.mockResolvedValue({ promoted: null });
  mockPublishNatsEvent.mockResolvedValue(undefined);
  mockTimeSlotFindUnique.mockResolvedValue(null);
  mockReservationFindUnique.mockResolvedValue({
    id: RESERVATION_ID,
    customerId: CUSTOMER_ID,
    status: "confirmed",
    partySize: 2,
    timeSlotId: "slot_1",
  });
});

describe("BKL-242 — one confirm on a parked reservation.cancel ⇒ exactly ONE EXECUTE", () => {
  it("parks on the auto-resolve confirm gate, then 'sim' EXECUTEs the cancel exactly ONCE", async () => {
    const { conductor, session, sink } = buildHarness();

    // Turn 1 — the auto-resolved cancel parks for confirmation. No write.
    const parked = await runTurn(conductor, "cancela a minha reserva", PARKED_AT);
    expect(parked.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(cancelExecutes(sink)).toHaveLength(0);

    // Turn 2 — "sim" resumes the PARKED envelope. The re-projected state no
    // longer carries the auto-resolve flag, so the confirm gate is satisfied and
    // the kernel EXECUTEs (matching live row 6712's basis exactly).
    const resumed = await runTurn(conductor, "sim", CONFIRMED_AT);
    expect(resumed.decision.kind).toBe("EXECUTE");
    // The tool actually ran — a swallowed `tool_threw` must not pass as success.
    expect(resumed.acted.kind).toBe("executed");

    // THE REGRESSION: exactly ONE reservation.cancel EXECUTE for the whole
    // confirm. Pre-fix this was 2 — the Conductor's, plus the one the tool
    // minted for itself during dispatch (live rows 6712 + 6714).
    expect(cancelExecutes(sink)).toHaveLength(1);

    // ...and it is the CONDUCTOR's record: the parked envelope's own hash and
    // nonce, with `customerId` in the payload. The tool-minted duplicate had a
    // fresh nonce and NO customerId (live row 6714).
    const [record] = cancelExecutes(sink);
    expect(record!.envelope.intentHash).toBe(cancelEnvelope().intentHash);
    expect(record!.envelope.nonce).toBe("n-bkl242-parked");
    expect(
      (record!.envelope.payload as { customerId?: string }).customerId,
    ).toBe(CUSTOMER_ID);

    // The mutation ran once, under that one decision.
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledWith(RESERVATION_ID, CUSTOMER_ID);

    // The park was cleared so a later reply cannot match it again.
    expect(session.parksFor(SESSION_ID)).toHaveLength(0);
  });

  it("the tool does NOT mint a second reservation.cancel envelope (no fresh-nonce sibling in the trail)", async () => {
    const { conductor, sink } = buildHarness();
    await runTurn(conductor, "cancela a minha reserva", PARKED_AT);
    await runTurn(conductor, "sim", CONFIRMED_AT);

    // Every reservation.cancel record in the trail — CONFIRM and EXECUTE alike —
    // belongs to the ONE parked envelope. A tool-side re-adjudication would show
    // up here as a record with a different hash (that is precisely what the live
    // 6712/6714 pair looked like), because getAuditSink() is this same sink.
    const hashes = new Set(
      sink.byKind("reservation.cancel").map((r) => r.envelope.intentHash),
    );
    expect([...hashes]).toEqual([cancelEnvelope().intentHash]);
  });

  // The scouted gotcha, pinned end-to-end: `svc.getById` is NOT state projection
  // on the pre-adjudicated path — it feeds `sendReservationCancelled` AFTER the
  // write. Only the `timeSlot.findUnique` hydration (which exists solely to feed
  // the kernel's `confirmLastMinuteCancel` guard) is skippable.
  it("still reads the reservation for the post-write notification, but skips the kernel-only slot read", async () => {
    const { conductor } = buildHarness();
    await runTurn(conductor, "cancela a minha reserva", PARKED_AT);
    await runTurn(conductor, "sim", CONFIRMED_AT);

    expect(mockGetById).toHaveBeenCalledWith(RESERVATION_ID, CUSTOMER_ID);
    expect(mockTimeSlotFindUnique).not.toHaveBeenCalled();
    // The waitlist promotion is part of the cancel's post-write contract and
    // must survive the rewiring.
    expect(mockPromoteWaitlist).toHaveBeenCalledWith("slot_1");
  });
});

describe("BKL-242 — the execution-ledger dedup fires on a duplicated resume trigger", () => {
  it("a re-delivered 'sim' on the SAME parked envelope is REPLAY_SUPPRESSED and does NOT cancel again", async () => {
    const { conductor, session, sink, ledger } = buildHarness();

    await runTurn(conductor, "cancela a minha reserva", PARKED_AT);
    const park = session.parksFor(SESSION_ID)[0]!;

    // First confirm — EXECUTEs and CLAIMS the ledger key for this intentHash.
    const first = await runTurn(conductor, "sim", CONFIRMED_AT);
    expect(first.decision.kind).toBe("EXECUTE");
    expect(first.acted.kind).toBe("executed");
    expect(mockCancel).toHaveBeenCalledTimes(1);
    await expect(ledger.checkLedger(park.envelope.intentHash)).resolves.toEqual(
      expect.objectContaining({ kind: "reservation.cancel" }),
    );

    // Re-park the identical envelope and confirm again — the duplicate delivery
    // that produced the observed double-fire window.
    session.repark(SESSION_ID, park);
    const second = await runTurn(conductor, "sim", "2026-07-24T21:14:18.100Z");

    // The dedup is what stops it: the kernel's ledger consult HITS on the
    // already-claimed intentHash and refuses instead of executing. A cancel is
    // not idempotent at the waitlist-promotion layer, so the second EXECUTE
    // never happening is the property that matters, not that it would be
    // harmless.
    expect(second.decision.kind).toBe("REFUSE");
    if (second.decision.kind === "REFUSE") {
      expect(second.decision.refusal.code).toBe("ledger_replay_suppressed");
    }
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(cancelExecutes(sink)).toHaveLength(1);

    // The suppressed attempt is still audited (auditors see both attempts).
    const suppressed = sink
      .byKind("reservation.cancel")
      .filter((r) => r.decision.kind === "REFUSE");
    expect(suppressed).toHaveLength(1);
  });
});
