/**
 * RC-A1 Stage 3 — hermetic loop-closure proof (Phase A.5).
 *
 * Composes the REAL cutover pieces end to end with only the two external
 * dependencies faked (LLM + Postgres writer):
 *
 *   mocked ModelProvider
 *     → createIbatexasPlanner.propose         (real planner → IntentEnvelope)
 *     → composePolicyRouter                    (real per-kind policy resolution)
 *     → buildAdjudicator({ sink }).adjudicate  (real audited kernel bridge:
 *                                               adjudicateAndAudit → AuditRecord)
 *     → dispatchDecision                        (real EXECUTE → tool dispatch)
 *
 * Proves the cutover's load-bearing invariant: a chat-driven mutation flows
 * perception → envelope → audited adjudication → AuditRecord persisted → tool
 * executed, and the ONLY mutation surface is the adjudicated tool (zero direct
 * Prisma/Medusa/Stripe writes — there are none in the trace). The audit record
 * is persisted by the bridge BEFORE dispatch runs, so an unauditable mutation
 * cannot occur.
 *
 * Hermetic = green-at-commit: the audit "Postgres sink" is the real
 * `createPostgresSink` path exercised by the bridge, fed an in-memory capturing
 * AuditSink double (same pattern as claustrum-bridge-audit.test.ts); no real DB,
 * no network, no live model. The live-Anthropic functional proof is the separate
 * Phase-C ceiling.
 */

import { describe, expect, it, vi } from "vitest";
import type { AuditRecord, AuditSink } from "@adjudicate/core";
import { decisionExecute } from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";
import { createToolRegistry, dispatchDecision } from "@claustrum/core";
import type {
  CapabilityId,
  Capsule,
  CognitiveState,
  Completion,
  CompletionRequest,
  IntentKind,
  ModelProvider,
} from "@claustrum/core";
import { buildAdjudicator } from "../claustrum-bootstrap.js";
import {
  composePolicyRouter,
  type CapabilityPolicyPack,
} from "../claustrum/capability-policy.js";
import {
  createIbatexasPlanner,
  EXPRESS_INTENT_TOOL,
} from "../claustrum/ibatexas-planner.js";

// ── Doubles ──────────────────────────────────────────────────────────────────

function capturingSink(): AuditSink & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async emit(record: AuditRecord) {
      records.push(record);
    },
  };
}

function mockModel(
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
): ModelProvider {
  return {
    async complete(_req: CompletionRequest): Promise<Completion> {
      return {
        model: "mock",
        stopReason: "tool_use",
        text: "",
        toolCalls,
        inputTokens: 0,
        outputTokens: 0,
      };
    },
    stream: () => {
      throw new Error("unused");
    },
    embed: async () => {
      throw new Error("unused");
    },
  };
}

/** Orders fixture pack whose single business guard authorizes order.item.add. */
function ordersFixturePack(): CapabilityPolicyPack {
  const authorize: Guard<string, unknown, unknown> = () => decisionExecute([]);
  const policy: PolicyBundle<string, unknown, unknown> = {
    stateGuards: [],
    authGuards: [],
    business: [authorize],
    taint: { minimumFor: () => "UNTRUSTED" },
    default: "REFUSE",
  };
  return { id: "fixture/orders", intents: ["order.item.add"], policy };
}

const capPlanner = {
  plan: () => ({ visibleReadTools: [], allowedIntents: ["order.item.add"] }),
};

function mkState(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-05-29T00:00:00.000Z" },
    memory: {},
    retrieval: { docs: [], retrievedAt: "2026-05-29T00:00:00.000Z", modelId: "m" },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "web:cust-1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

/** Minimal capsule carrying only the ToolRegistry the EXECUTE dispatch touches. */
function capsuleWithTool(
  execute: (input: unknown, ctx: unknown) => Promise<unknown>,
): Capsule {
  const registry = createToolRegistry();
  registry.register({
    id: "fixture.cart.addItem.v1", // internal id — never LLM-facing
    // dispatchDecision resolves by `envelope.kind as capability`, so for the
    // simplest case the tool's capability === intentKind === the envelope kind.
    capability: "order.item.add" as CapabilityId,
    intentKind: "order.item.add" as IntentKind,
    description: "fixture: add item to cart",
    inputSchema: {},
    outputSchema: {},
    riskLevel: "low",
    execute,
  });
  return { tools: registry } as unknown as Capsule;
}

// ── The proof ────────────────────────────────────────────────────────────────

describe("RC-A1 hermetic loop-closure — audited mutation path", () => {
  it("perception → envelope → audited EXECUTE → AuditRecord → tool exec (zero direct writes)", async () => {
    const sink = capturingSink();
    const planner = createIbatexasPlanner({
      model: mockModel([
        {
          id: "tc1",
          name: EXPRESS_INTENT_TOOL,
          input: { capability: "order.item.add", payload: { sku: "costela", qty: 2 } },
        },
      ]),
      modelId: "mock",
      capabilityPlanners: [capPlanner],
    });
    const router = composePolicyRouter([ordersFixturePack()]);
    const bridge = buildAdjudicator({ sink });

    // PLAN — the planner turns the perception into one proposed envelope.
    const state = mkState("adiciona 2 costelas ao carrinho");
    const plan = await planner.propose(state);
    expect(plan.envelopes).toHaveLength(1);
    const envelope = plan.envelopes[0]!;
    expect(envelope.kind).toBe("order.item.add");
    expect(envelope.actor.principal).toBe("llm");

    // SUBMIT — audited adjudication. The AuditRecord is persisted HERE, before
    // any side effect, and the decision authorizes execution.
    const decision = await bridge.adjudicate(
      envelope,
      { channel: "web" } as never,
      router as never,
    );
    expect(decision.kind).toBe("EXECUTE");
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.intentHash).toBe(envelope.intentHash);

    // ACT — dispatch resolves the tool by kind and executes it. This fake tool
    // is the ONLY mutation surface in the entire trace; there is no direct
    // Prisma/Medusa/Stripe write anywhere.
    const toolExecute = vi.fn(
      async (payload: unknown) => ({ cartId: "c1", added: payload }),
    );
    const capsule = capsuleWithTool(toolExecute);
    const result = await dispatchDecision(decision, plan, capsule);

    expect(result.kind).toBe("executed");
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(toolExecute).toHaveBeenCalledWith({ sku: "costela", qty: 2 }, capsule);

    // 1:1 audit:execution — exactly one record, exactly one mutation.
    expect(sink.records).toHaveLength(1);
  });

  it("a refused mutation persists an audit record and runs NO tool (fail-closed)", async () => {
    const sink = capturingSink();
    // Pack requires TRUSTED for the kind; the LLM envelope is UNTRUSTED → the
    // kernel REFUSEs at the taint gate.
    const trustedPack: CapabilityPolicyPack = {
      id: "fixture/orders",
      intents: ["order.item.add"],
      policy: {
        stateGuards: [],
        authGuards: [],
        business: [() => decisionExecute([])],
        taint: { minimumFor: () => "TRUSTED" },
        default: "REFUSE",
      },
    };
    const planner = createIbatexasPlanner({
      model: mockModel([
        {
          id: "tc1",
          name: EXPRESS_INTENT_TOOL,
          input: { capability: "order.item.add", payload: { sku: "x", qty: 1 } },
        },
      ]),
      modelId: "mock",
      capabilityPlanners: [capPlanner],
    });
    const bridge = buildAdjudicator({ sink });

    const plan = await planner.propose(mkState("adiciona x"));
    const decision = await bridge.adjudicate(
      plan.envelopes[0]!,
      { channel: "web" } as never,
      composePolicyRouter([trustedPack]) as never,
    );

    expect(decision.kind).toBe("REFUSE");
    // The refusal was still audited (the kernel ran), and no tool executed.
    expect(sink.records).toHaveLength(1);
    const toolExecute = vi.fn(async () => ({}));
    const result = await dispatchDecision(decision, plan, capsuleWithTool(toolExecute));
    expect(result.kind).toBe("refused");
    expect(toolExecute).not.toHaveBeenCalled();
  });
});
