// reservation-modify-resume-dedup — BKL-232's regression gate.
//
// A single customer confirm ("sim") on a parked `reservation.modify` produced
// TWO `reservation.modify` EXECUTE audit rows ~5s apart (live: intent_audit
// 6942/6944 @ 2026-07-19 19:58:41+19:58:46, and 6980/6982 @ 20:23:26+20:23:31 —
// 4/4 confirms, every one a pair). The first row is the Conductor's
// receipt-bound, ledger-claimed re-adjudication of the PARKED envelope; the
// second is a FRESH envelope the `modify_reservation` tool minted for itself
// during dispatch (`nonce: randomUUID()`, payload without `customerId`) and
// adjudicated a second time through `withAdjudicate` — which is wired with no
// execution ledger. Two structurally-different envelopes ⇒ two different
// `intentHash`es ⇒ the ledger's `ledger:intent:<hash>` SET-NX could never
// recognize the duplicate. The order-plane amend/cancel tools were never
// exposed: they do not re-mint an envelope of the kind the Conductor decided.
//
// This file drives the REAL turn seam — `handleTurn` → `resolveResume` →
// the REAL audited kernel (`adjudicateAndAudit`) over the REAL composed policy
// router → the REAL `dispatchDecision` → the REAL registered
// `reservation.modify` tool executor. Only the leaves are fakes: the model is
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

const CUSTOMER_ID = "cus_bkl232";
const RESERVATION_ID = "res_bkl232";
const SESSION_ID = `web:${CUSTOMER_ID}`;
const PARKED_AT = "2026-07-19T19:57:51.628Z";
const CONFIRMED_AT = "2026-07-19T19:58:41.264Z";

/** The reservation DTO `reservationService.modify` resolves with. */
const MODIFIED_DTO = {
  id: RESERVATION_ID,
  customerId: CUSTOMER_ID,
  status: "confirmed",
  partySize: 4,
  specialRequests: [],
  tableLocation: "indoor",
  timeSlot: { id: "slot_1", date: "2026-07-25", startTime: "19:30" },
  tables: [],
};

/**
 * The single spy that proves how many times the MUTATION ran, independent of
 * how many times the kernel was asked.
 */
const mockModify = vi.hoisted(() => vi.fn());
const mockPublishNatsEvent = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetAuditSink = vi.hoisted(() => vi.fn());
/**
 * The one reservation row. Read by SEC-002's `assertReservationOwnership`
 * (`select customerId`) AND by the tool's own pack-state projection
 * (`select id,status,partySize,timeSlotId`), so it returns a superset of both.
 */
const mockReservationFindUnique = vi.hoisted(() => vi.fn());

// Narrow overrides only — a flat factory would stub the other 10
// `@ibatexas/domain` exports the tools package imports as `undefined` (the
// PR #248 vi.mock saga). `index.ts` has no top-level side effects, so
// `importOriginal` is safe.
//
// CRITICAL: `modifyFromEnvelope` is left REAL. It is the second-adjudication
// path this ticket is about — real `withAdjudicate`, real
// `reservationsPolicyBundle`, real audit emit into `getAuditSink()`. Stubbing it
// (or hand-authoring a mirror of it) would make the pre-fix double EXECUTE
// invisible and the assertions below vacuous. Only the leaves move: the write
// (`modify`) is a spy and prisma is stubbed. Spreading the real service and
// overriding `modify` is what lets the real `modifyFromEnvelope` run while its
// `this.modify(...)` executor resolves to the spy.
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  return {
    ...actual,
    createReservationService: (opts?: unknown) => ({
      ...actual.createReservationService(
        opts as Parameters<typeof actual.createReservationService>[0],
      ),
      modify: mockModify,
    }),
    // Only the two tables this turn touches. Anything else reaching for prisma
    // in this graph should fail loudly rather than silently hit a real DB.
    prisma: {
      reservation: { findUnique: mockReservationFindUnique },
      timeSlot: { findUnique: vi.fn(async () => null) },
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
 * envelopes: the customer said "muda pra 4 pessoas" without naming a
 * reservation, the resolver auto-resolved it to their one active reservation,
 * and the composed router's `confirmOnAutoResolveGuard` REQUEST_CONFIRMATIONs
 * ("confirma que é a sua reserva mais recente?").
 */
const PLAN_STATE = {
  ctx: {
    channel: "web",
    customerId: CUSTOMER_ID,
    staffId: null,
    now: new Date(PARKED_AT),
    reservation: RESERVATION_CTX,
    newSlot: null,
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

/** The parked intent: "muda a minha reserva pra 4 pessoas". */
function modifyEnvelope(): IntentEnvelope {
  return buildEnvelope({
    kind: "reservation.modify",
    payload: {
      customerId: CUSTOMER_ID,
      reservationId: RESERVATION_ID,
      newPartySize: 4,
    },
    actor: { principal: "llm", sessionId: `web:${CUSTOMER_ID}` },
    taint: "UNTRUSTED",
    nonce: "n-bkl232-parked",
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

  // Turn 1 proposes the modify; every later turn proposes nothing. The resume
  // path never consults the planner (handleTurn skips PLAN when a park matched),
  // so this only has to set the park up.
  let proposed = false;
  const planner = {
    propose: async (_state: CognitiveState): Promise<Plan> => {
      if (proposed) return { envelopes: [] };
      proposed = true;
      return { envelopes: [modifyEnvelope()] };
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

/** EXECUTE audit records for `reservation.modify`, across BOTH adjudication paths. */
const modifyExecutes = (sink: CapturingAuditSink) =>
  sink.byKind("reservation.modify").filter((r) => r.decision.kind === "EXECUTE");

beforeEach(() => {
  vi.clearAllMocks();
  mockModify.mockResolvedValue(MODIFIED_DTO);
  mockPublishNatsEvent.mockResolvedValue(undefined);
  mockReservationFindUnique.mockResolvedValue({
    id: RESERVATION_ID,
    customerId: CUSTOMER_ID,
    status: "confirmed",
    partySize: 2,
    timeSlotId: "slot_1",
  });
});

describe("BKL-232 — one confirm on a parked reservation.modify ⇒ exactly ONE EXECUTE", () => {
  it("parks on the auto-resolve confirm gate, then 'sim' EXECUTEs the modify exactly ONCE", async () => {
    const { conductor, session, sink } = buildHarness();

    // Turn 1 — the auto-resolved modify parks for confirmation. No write.
    const parked = await runTurn(conductor, "muda pra 4 pessoas", PARKED_AT);
    expect(parked.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(SESSION_ID)).toHaveLength(1);
    expect(mockModify).not.toHaveBeenCalled();
    expect(modifyExecutes(sink)).toHaveLength(0);

    // Turn 2 — "sim" resumes the PARKED envelope. The re-projected state no
    // longer carries the auto-resolve flag, so the confirm gate is satisfied and
    // the kernel EXECUTEs (matching live row 6942's basis exactly).
    const resumed = await runTurn(conductor, "sim", CONFIRMED_AT);
    expect(resumed.decision.kind).toBe("EXECUTE");
    // The tool actually ran — a swallowed `tool_threw` must not pass as success.
    expect(resumed.acted.kind).toBe("executed");

    // THE REGRESSION: exactly ONE reservation.modify EXECUTE for the whole
    // confirm. Pre-fix this was 2 — the Conductor's, plus the one the tool
    // minted for itself during dispatch.
    expect(modifyExecutes(sink)).toHaveLength(1);

    // ...and it is the CONDUCTOR's record: the parked envelope's own hash and
    // nonce, with `customerId` in the payload. The tool-minted duplicate had a
    // fresh nonce and NO customerId (live rows 6944 / 6982 / 7000).
    const [record] = modifyExecutes(sink);
    expect(record!.envelope.intentHash).toBe(modifyEnvelope().intentHash);
    expect(record!.envelope.nonce).toBe("n-bkl232-parked");
    expect(
      (record!.envelope.payload as { customerId?: string }).customerId,
    ).toBe(CUSTOMER_ID);
    // The same five-basis shape live row 6942 carried (intent_audit stores them
    // joined as `category:code`; the record keeps them split).
    expect(
      record!.decision_basis.map((b) => `${b.category}:${b.code}`),
    ).toEqual([
      "schema:version_supported",
      "state:transition_valid",
      "taint:level_permitted",
      "auth:scope_sufficient",
      "business:rule_satisfied",
    ]);

    // The mutation ran once, under that one decision, with the confirmed change.
    expect(mockModify).toHaveBeenCalledTimes(1);
    expect(mockModify).toHaveBeenCalledWith(RESERVATION_ID, CUSTOMER_ID, {
      newPartySize: 4,
    });

    // The park was cleared so a later reply cannot match it again.
    expect(session.parksFor(SESSION_ID)).toHaveLength(0);
  });

  it("the tool does NOT mint a second reservation.modify envelope (no fresh-nonce sibling in the trail)", async () => {
    const { conductor, sink } = buildHarness();
    await runTurn(conductor, "muda pra 4 pessoas", PARKED_AT);
    await runTurn(conductor, "sim", CONFIRMED_AT);

    // Every reservation.modify record in the trail — CONFIRM and EXECUTE alike —
    // belongs to the ONE parked envelope. A tool-side re-adjudication would show
    // up here as a record with a different hash (that is precisely what the live
    // 6942/6944 pair looked like), because getAuditSink() is this same sink.
    const hashes = new Set(
      sink.byKind("reservation.modify").map((r) => r.envelope.intentHash),
    );
    expect([...hashes]).toEqual([modifyEnvelope().intentHash]);
  });
});

describe("BKL-232 — the execution-ledger dedup fires on a duplicated resume trigger", () => {
  it("a re-delivered 'sim' on the SAME parked envelope is REPLAY_SUPPRESSED and does NOT write again", async () => {
    const { conductor, session, sink, ledger } = buildHarness();

    await runTurn(conductor, "muda pra 4 pessoas", PARKED_AT);
    const park = session.parksFor(SESSION_ID)[0]!;

    // First confirm — EXECUTEs and CLAIMS the ledger key for this intentHash.
    const first = await runTurn(conductor, "sim", CONFIRMED_AT);
    expect(first.decision.kind).toBe("EXECUTE");
    expect(first.acted.kind).toBe("executed");
    expect(mockModify).toHaveBeenCalledTimes(1);
    await expect(ledger.checkLedger(park.envelope.intentHash)).resolves.toEqual(
      expect.objectContaining({ kind: "reservation.modify" }),
    );

    // Re-park the identical envelope and confirm again — the duplicate delivery
    // that produced the observed double-fire window.
    session.repark(SESSION_ID, park);
    const second = await runTurn(conductor, "sim", "2026-07-19T19:58:46.417Z");

    // The dedup is what stops it: the kernel's ledger consult HITS on the
    // already-claimed intentHash and refuses instead of executing. This holds
    // for a future NON-idempotent modify field — the second EXECUTE never
    // happens, rather than being harmless.
    expect(second.decision.kind).toBe("REFUSE");
    if (second.decision.kind === "REFUSE") {
      expect(second.decision.refusal.code).toBe("ledger_replay_suppressed");
    }
    expect(mockModify).toHaveBeenCalledTimes(1);
    expect(modifyExecutes(sink)).toHaveLength(1);

    // The suppressed attempt is still audited (auditors see both attempts).
    const suppressed = sink
      .byKind("reservation.modify")
      .filter((r) => r.decision.kind === "REFUSE");
    expect(suppressed).toHaveLength(1);
  });
});
