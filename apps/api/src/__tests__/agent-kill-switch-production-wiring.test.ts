// F-51 — the kernel-side kill-switch leg, proven through the PRODUCTION wiring.
//
// WHY THIS FILE EXISTS SEPARATELY FROM agent-kill-switch.test.ts
//
// `agent-kill-switch.test.ts` already drives the real kernel over the real
// composition and asserts trip → REFUSE. It cannot see this defect, because IT
// calls the kill-state holder's setter itself. That one call is the entire
// production wiring; a test that supplies it is testing the guard body, not the
// system. For ~the whole life of T3-5 the holder had ZERO production callers, so
// `agentKillSwitchGuard` — authGuards[0] of every composed pack — read
// constant-false in every running process while that test stayed green.
//
// So the rule for this file: it must never name that setter. The seam has to be
// wired by the code under test (`startManagedAgentPlane`) or not at all. That is
// asserted mechanically below (`does not wire the seam itself`) so a future edit
// cannot quietly reintroduce the vacuity.
//
// WHAT IS REAL HERE
//
// Real: startManagedAgentPlane (the production plane boot), the real
// AgentKillSwitchManager over `startDistributedKillSwitchPubSub`, the real
// `buildIbatexasPolicyPacks` + `composePolicyRouter` composition over the real
// `IBATEXAS_COMPOSED_PACKS`, the real kernel (`adjudicate` /
// `adjudicateAndAudit`), and the real agent-approvals resume.
//
// Doubled: only process-external I/O the plane opens on start() — the BullMQ
// queue/worker and the NATS subscription — plus in-memory Redis/pub-sub, which
// is what the pre-existing kill-switch test already uses. Nothing between the
// kill switch and the kernel decision is doubled.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryRedis } from "@ibatexas/tools/testing";
import { buildEnvelope, type Decision } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { IBATEXAS_COMPOSED_PACKS, composedIntentKinds } from "@ibatexas/packs-composed";
import { PIX_REMEDIATION_AGENT, agentSessionId } from "@ibatexas/agents";
import type { RedisLedgerClient, RedisPubSubClient } from "@adjudicate/audit";
import { AGENT_KILL_SWITCH_REFUSAL_CODE } from "../claustrum/agent-guards.js";
import {
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  composePolicyRouter,
  type CapabilityPolicyPack,
} from "../claustrum/capability-policy.js";
import {
  createAgentApprovalEngine,
  deriveAgentApprovalOutcome,
  type ApprovalAuditSink,
} from "../claustrum/agent-approvals.js";
import {
  startManagedAgentPlane,
  type ManagedAgentPlaneDeps,
} from "../claustrum/managed-agent-plane.js";
import type { AgentPlane } from "../claustrum/agent-plane.js";
import type { AgentRunJournal } from "../claustrum/agent-run-journal.js";
import type { LiveAgentConductorDeps } from "../claustrum/live-agent-conductor.js";
import type { TriggerDedupRedis } from "../claustrum/agent-trigger-bridge.js";

// ── Process-external I/O the plane opens on start() ──────────────────────────
// `bridge.start()` creates a BullMQ queue + worker (needs a live Redis) and
// subscribes NATS subjects. Neither is on the path from the kill switch to a
// kernel decision; both are doubled so the plane can really boot in-process.
// `importOriginal` is spread so every OTHER export of these modules stays real
// for anything else in the graph that imports them.
vi.mock("../jobs/queue.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createQueue: vi.fn(() => ({ close: vi.fn(async () => {}) })),
  createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn(async () => {}) })),
}));

vi.mock("@ibatexas/nats-client", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  subscribeNatsEvent: vi.fn(async () => ({ unsubscribe: vi.fn() })),
}));

const ORDER = "ord_f51";
const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, ORDER);
const CUSTOMER_SESSION = "cust_f51";
const NOW = "2026-08-05T12:00:00.000Z";

const tick = () => new Promise((r) => setImmediate(r));

// ── The EXACT production router shape ────────────────────────────────────────
// `claustrum-bootstrap.ts` builds this at MODULE IMPORT (its
// `IBATEXAS_POLICY_PACKS` / `IBATEXAS_POLICY_ROUTER` consts), long before
// `bootstrapClaustrum()` ever calls `startManagedAgentPlane`. Composing it here
// at module scope reproduces that ordering: the packs below are frozen before
// any plane exists, so if the guard captured a VALUE rather than the late-bound
// holder, every assertion in this file would be unreachable.
const productionRouter: PolicyBundle<string, unknown, unknown> = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as unknown as ReadonlyArray<CapabilityPolicyPack>,
);

// ── Fakes for the kill switch's own stores (as in agent-kill-switch.test.ts) ──

function fakeRedis() {
  const mem = createInMemoryRedis();
  return { ...mem, client: mem.client as unknown as RedisLedgerClient };
}

function fakePubSub(): RedisPubSubClient {
  const handlers = new Map<string, Set<(m: string) => void>>();
  return {
    async publish(channel, message) {
      const hs = handlers.get(channel);
      if (hs) for (const h of [...hs]) h(message);
      return hs?.size ?? 0;
    },
    async subscribe(channel, handler) {
      let set = handlers.get(channel);
      if (set === undefined) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return async () => {
        set!.delete(handler);
      };
    },
  };
}

/**
 * The plane's non-kill-switch collaborators. `createLiveTriggerRunner` reads
 * `deps.conductor` only inside the closure it returns, and that closure is only
 * ever called by the (doubled) BullMQ worker — so a structural stub is honest
 * here: nothing in this file exercises a turn.
 */
function planeDeps(): ManagedAgentPlaneDeps {
  const redis = fakeRedis();
  return {
    registry: [PIX_REMEDIATION_AGENT],
    liveConductor: {
      conductor: {},
      systemChannel: {},
    } as unknown as LiveAgentConductorDeps,
    journal: {} as unknown as AgentRunJournal,
    redis: redis.client,
    dedupRedis: {} as unknown as TriggerDedupRedis,
    pubsub: fakePubSub(),
    approvals: createAgentApprovalEngine({ notify: async () => {}, now: () => NOW }),
    // Mirrors claustrum-bootstrap's AGENT_CONFIRM_GATED_KINDS — the fail-closed
    // real-money assertion runs for real before anything else composes.
    realMoneyConfirmKinds: new Set(["pix.charge.refund"]),
    resolveCustomer: async () => "cust_001",
    now: () => NOW,
  };
}

// ── Envelopes + state ────────────────────────────────────────────────────────

function envelopeFor(kind: string, sessionId: string) {
  return buildEnvelope({
    kind,
    payload: { orderId: ORDER },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: `f51:${kind}:${sessionId}`,
  });
}

const regenerateEnvelope = () => envelopeFor("payment.pix.regenerate", AGENT_SESSION);

function driveState(extraCtx: Record<string, unknown> = {}) {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      isAuthenticated: true,
      orderId: ORDER,
      exists: true,
      currentStatus: "payment_failed",
      currentMethod: "pix",
      isTerminal: false,
      refundedAmountCentavos: 0,
      amountInCentavos: 5_000,
      regenerationCount: 0,
      sessionTokensConsumed: 0,
      ...extraCtx,
    },
  };
}

/**
 * Adjudicate every composed intent kind under BOTH an agent-namespaced and a
 * customer sessionId through the production router, and serialize the results.
 * This is the blast-radius instrument: the wiring flips the kill guard from a
 * constant-false reader to a live one, so with zero agents killed the whole
 * surface must serialize identically.
 */
function sweep(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of composedIntentKinds()) {
    for (const [label, session] of [
      ["agent", AGENT_SESSION],
      ["customer", CUSTOMER_SESSION],
    ] as const) {
      const decision = adjudicate(
        envelopeFor(kind, session),
        driveState(),
        productionRouter,
      );
      out[`${label}:${kind}`] = JSON.stringify(decision);
    }
  }
  return out;
}

/**
 * The pre-fix production reality, captured at MODULE EVALUATION — before any
 * hook has run and therefore before any plane has ever wired the holder in this
 * process. This is the only point at which the guard's reader is provably the
 * untouched module default, so the blast-radius comparison below has to be
 * anchored here rather than inside a test (by then `beforeEach` has started a
 * plane, and an arm taken there would be comparing wired-to-wired).
 */
const SWEEP_BEFORE_ANY_PLANE = sweep();

let plane: AgentPlane | null = null;

beforeEach(async () => {
  plane = await startManagedAgentPlane(planeDeps(), { IBX_AGENTS_ENABLED: "true" });
});

afterEach(async () => {
  // Clear before stop: the module-level reader this file deliberately never
  // touches keeps pointing at THIS manager, so a still-tripped state would leak
  // into the next test in the file. `clear()` runs through the real pub/sub.
  if (plane !== null) {
    await plane.killSwitch.clear(PIX_REMEDIATION_AGENT.id);
    await tick();
    await plane.stop();
    plane = null;
  }
});

// ── The vacuity guard on this file itself ────────────────────────────────────

describe("F-51 production-wiring test — the anti-vacuity precondition", () => {
  it("does not wire the seam itself (never names the late-bound setter)", () => {
    // Built by concatenation so the assertion's own source does not contain the
    // token it forbids.
    const setter = ["setAgent", "KillStateReader"].join("");
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");

    expect(source).not.toContain(setter);
    // The sibling unit test DOES wire it — that asymmetry is the whole point,
    // and pinning it here keeps the two files' roles from drifting.
    const sibling = readFileSync(
      fileURLToPath(new URL("./agent-kill-switch.test.ts", import.meta.url)),
      "utf8",
    );
    expect(sibling).toContain(setter);
  });

  it("the plane builds exactly ONE kill-switch manager (structural — behaviour cannot see a same-store duplicate)", () => {
    // The behavioural tests below prove the reader answers from a store the
    // operator's trip REACHES: pointing it at a manager over a DIFFERENT
    // redis/pub-sub pair reds them. They cannot prove single-instance, though —
    // a second manager over the SAME stores converges through the same pub/sub
    // channel, so every decision is identical and no drive can distinguish it.
    // That duplicate is still a defect (two poller sets, two subscriptions, and
    // a divergence window whenever pub/sub is degraded and the two are mid-poll),
    // so it is pinned where it IS visible: the construction count.
    const plane = readFileSync(
      fileURLToPath(new URL("../claustrum/managed-agent-plane.ts", import.meta.url)),
      "utf8",
    );
    const constructions = plane.match(/createAgentKillSwitchManager\(/g) ?? [];
    expect(constructions).toHaveLength(1);
    // …and both legs must read THAT binding, not a rebuilt one.
    expect(plane).toContain("killSwitch.isKilled(ns)");
  });
});

// ── Blast radius: zero kills changes nothing ─────────────────────────────────

describe("F-51 blast radius — wiring the reader with zero kills is decision-neutral", () => {
  it("every composed kind × {agent, customer} serializes identically before and after the plane wires the reader", () => {
    // ARM A — module scope, holder at its never-killed default (the pre-fix
    // production reality). ARM B — now, with `beforeEach`'s plane having wired
    // the reader at its live manager and no agent killed.
    const before = SWEEP_BEFORE_ANY_PLANE;
    const after = sweep();

    expect(after).toEqual(before);

    // Non-vacuity: a sweep that REFUSEd everything for unrelated reasons would
    // make the equality above meaningless. Pin that the surface is live and that
    // the specific agent envelope this file kills later really does EXECUTE.
    const kinds = composedIntentKinds();
    expect(kinds.length).toBeGreaterThan(10);
    expect(Object.keys(before)).toHaveLength(kinds.length * 2);
    expect(
      Object.values(before).filter((d) => (JSON.parse(d) as Decision).kind === "EXECUTE").length,
    ).toBeGreaterThan(0);
    expect(before["agent:payment.pix.regenerate"]).toContain('"EXECUTE"');
    expect(after["agent:payment.pix.regenerate"]).toContain('"EXECUTE"');
  });
});

// ── The kill drive, through the production wiring only ───────────────────────

describe("F-51 — a kill tripped on the real plane REFUSEs at the kernel", () => {
  it("trip via plane.killSwitch → the composed router REFUSEs the agent envelope with kill.ACTIVE", async () => {
    // Live agent first: the in-scope regenerate EXECUTEs.
    expect(adjudicate(regenerateEnvelope(), driveState(), productionRouter).kind).toBe(
      "EXECUTE",
    );

    await plane!.killSwitch.trip(PIX_REMEDIATION_AGENT.id, "ops: F-51 drive");
    await tick();

    const decision = adjudicate(regenerateEnvelope(), driveState(), productionRouter);
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") throw new Error("unreachable");
    expect(decision.refusal.code).toBe(AGENT_KILL_SWITCH_REFUSAL_CODE);
    expect(decision.basis.some((b) => b.category === "kill" && b.code === "active")).toBe(
      true,
    );

    // Clearing through the same production surface restores execution.
    await plane!.killSwitch.clear(PIX_REMEDIATION_AGENT.id);
    await tick();
    expect(adjudicate(regenerateEnvelope(), driveState(), productionRouter).kind).toBe(
      "EXECUTE",
    );
  });

  it("the bundle claustrum-bootstrap itself hands the agent capsule REFUSEs too (in-flight coverage)", async () => {
    // The composition above is rebuilt locally from the same inputs. This arm
    // instead pulls the bundle out of `claustrum-bootstrap`'s OWN module-level
    // `IBATEXAS_POLICY_PACKS` — the exact object graph `IBATEXAS_POLICY_ROUTER`
    // dispatches over, which `resolveIbatexasTenantPolicy` hands every capsule
    // (agent plane included, via `tenantResolver`). That is what makes the
    // kernel leg reach a turn ALREADY past openCapsule: the capsule captured
    // this policy object at open time, but the kill guard's closure reads the
    // holder at DECISION time, so a mid-turn flip still refuses the mutation.
    const { policyForKind } = await import("../claustrum-bootstrap.js");
    const productionBundle = policyForKind("payment.pix.regenerate");
    expect(productionBundle).not.toBeNull();

    expect(
      adjudicate(regenerateEnvelope(), driveState(), productionBundle!).kind,
    ).toBe("EXECUTE");

    await plane!.killSwitch.trip(PIX_REMEDIATION_AGENT.id, "ops: F-51 in-flight");
    await tick();

    const decision = adjudicate(regenerateEnvelope(), driveState(), productionBundle!);
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind !== "REFUSE") throw new Error("unreachable");
    expect(decision.refusal.code).toBe(AGENT_KILL_SWITCH_REFUSAL_CODE);
  });

  it("kills only the tripped agent's namespace — customer traffic on the same kind is untouched", async () => {
    await plane!.killSwitch.trip(PIX_REMEDIATION_AGENT.id, "ops: F-51 scope");
    await tick();

    const customer = adjudicate(
      envelopeFor("payment.pix.regenerate", CUSTOMER_SESSION),
      driveState(),
      productionRouter,
    );
    expect(customer.kind).not.toBe("REFUSE");
  });
});

// ── The residual hole the audit named: the agent-approvals RESUME path ───────

describe("F-51 residual — a killed agent's parked money envelope on resume", () => {
  const capturingSink = (): ApprovalAuditSink => ({ async emit() {} });

  // The parked envelope's state: `autoResolvedMoneyRef` makes
  // confirmOnAutoResolveGuard return REQUEST_CONFIRMATION, which is what the
  // resume's confirmation receipt substitutes to EXECUTE. That substitution is
  // the mechanism the hole rides on, so the control arm must really take it.
  const parkedState = () => driveState({ autoResolvedMoneyRef: true });

  async function resolveParked(): Promise<Decision | undefined> {
    // `policyFor` mirrors getAgentApprovalGateway's own resolution — the
    // bootstrap's `policyForKind` over its module-level composed packs, with the
    // same null-is-unowned throw — so the arms below exercise the bundle the
    // real staff-accept path adjudicates against, not a local rebuild.
    const { policyForKind } = await import("../claustrum-bootstrap.js");
    const engine = createAgentApprovalEngine({
      notify: async () => {},
      now: () => NOW,
      tokenFactory: () => "tok-f51",
    });
    await engine.request({
      envelope: regenerateEnvelope(),
      prompt: "Regenerar cobrança PIX?",
    });
    const { decision } = await engine.resolve({
      token: "tok-f51",
      accepted: true,
      resolvedBy: { id: "mgr_1", displayName: "Gerente" },
      rebuildState: () => parkedState(),
      policyFor: (k) => {
        const policy = policyForKind(k);
        if (policy === null) {
          throw new Error(`agent approval: no installed pack owns kind "${k}"`);
        }
        return policy;
      },
      sink: capturingSink(),
    });
    return decision;
  }

  it("CONTROL — agent live: the manager's accept re-adjudicates to EXECUTE via the receipt", async () => {
    const decision = await resolveParked();
    expect(decision?.kind).toBe("EXECUTE");
    expect(deriveAgentApprovalOutcome(true, decision).status).toBe("executed");
  });

  it("TREATMENT — agent killed: the resume is REFUSEd by the kernel, not executed", async () => {
    await plane!.killSwitch.trip(PIX_REMEDIATION_AGENT.id, "ops: F-51 resume");
    await tick();

    const decision = await resolveParked();
    expect(decision?.kind).toBe("REFUSE");
    if (decision === undefined || decision.kind !== "REFUSE") throw new Error("unreachable");
    expect(decision.refusal.code).toBe(AGENT_KILL_SWITCH_REFUSAL_CODE);

    // The AUTH-phase REFUSE pre-empts the confirmation-receipt substitution:
    // the receipt only rewrites a REQUEST_CONFIRMATION, so an accepted approval
    // for a killed agent is reported honestly rather than executed.
    const outcome = deriveAgentApprovalOutcome(true, decision);
    expect(outcome.status).toBe("refused");
    expect(outcome.reasonCode).toBe(AGENT_KILL_SWITCH_REFUSAL_CODE);
  });
});
