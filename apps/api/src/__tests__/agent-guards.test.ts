/**
 * T3-4 conformance — agent scope + budget guards at the correct altitude.
 *
 * THE GOVERNANCE CRITIC'S NAMED FIXTURE (plan-v2 §9 / T3-4): an out-of-scope
 * kind from a REGISTERED agent yields REFUSE (`agent_scope_violation`) — NOT
 * REQUEST_CONFIRMATION — even where `confirmOnAutoResolveGuard` matches. The
 * trap is real and pinned by a counterfactual leg: with the agent AUTH guards
 * removed, the very same envelope + state short-circuits into
 * REQUEST_CONFIRMATION via the business-phase confirm-on-autoresolve prepend.
 * That is exactly why the scope guard lives in the AUTH phase (kernel order:
 * state → taint → auth → business).
 *
 * Also covered, per the task's conformance list:
 *  - in-scope kind from the agent passes the adopter guards → pack EXECUTEs;
 *  - over-budget agent session ESCALATEs (to supervisor) before any business
 *    guard runs;
 *  - non-agent traffic is untouched (same envelopes minus the agent
 *    namespace behave exactly as before);
 *  - unknown `agent:` namespaces fail closed (the prefix is reserved);
 *  - exact-namespace matching (`…@0.1.1` never governs `…@0.1.10`).
 *
 * Everything here runs the REAL packs (`@ibatexas/pack-orders`,
 * `@ibatexas/pack-payments`) through the REAL production composition
 * (`buildIbatexasPolicyPacks`) and the REAL kernel (`adjudicate`) — no mocks.
 */

import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate, type PolicyBundle } from "@adjudicate/core/kernel";
import { ordersPack } from "@ibatexas/pack-orders";
import { paymentsPack } from "@ibatexas/pack-payments";
import {
  AGENT_REGISTRY,
  PIX_REMEDIATION_AGENT,
  agentSessionId,
  type AgentDefinition,
} from "@ibatexas/agents";
import {
  buildIbatexasPolicyPacks,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  type ErasedPack,
} from "../claustrum/compose-policy-packs.js";
import {
  AGENT_SCOPE_REFUSAL_CODE,
  createAgentBudgetGuards,
  createAgentScopeGuard,
  parseAgentSessionNamespace,
} from "../claustrum/agent-guards.js";

type Bundle = PolicyBundle<string, unknown, unknown>;

/** The production composition (default adopter business + auth guards). */
function composedBundle(pack: unknown): Bundle {
  return buildIbatexasPolicyPacks([pack as ErasedPack])[0]!.policy as Bundle;
}

/** Counterfactual composition: business prepend only, NO agent auth guards. */
function bundleWithoutAgentGuards(pack: unknown): Bundle {
  return buildIbatexasPolicyPacks(
    [pack as ErasedPack],
    IBATEXAS_ADOPTER_BUSINESS_GUARDS,
    [],
  )[0]!.policy as Bundle;
}

const AGENT_SESSION = agentSessionId(PIX_REMEDIATION_AGENT, "pay_001");
const TOKENS_PER_DAY = PIX_REMEDIATION_AGENT.budgets.tokensPerDay!;

/**
 * order.cancel state that sails through the orders pack's state guards
 * (orderId present, not yet cancelled), its auth guards (tenant bound,
 * authenticated customer) and arms the confirm-on-autoresolve trap
 * (`autoResolvedMoneyRef` set by the resolve stage's NL→id auto-resolution).
 * Small ticket so the pack's own escalateLargeCancel stays silent.
 */
function cancelTrapState(extraCtx: Record<string, unknown> = {}) {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      staffId: null,
      isAuthenticated: true,
      orderId: "ord_001",
      cartId: null,
      paymentMethod: "pix",
      paymentStatus: "paid",
      totalInCentavos: 5_000,
      lastAction: null,
      sessionTokensConsumed: 0,
      autoResolvedMoneyRef: true,
      ...extraCtx,
    },
  };
}

/** payment.pix.regenerate state that passes the payments pack end to end. */
function regenerateState(extraCtx: Record<string, unknown> = {}) {
  return {
    ctx: {
      tenantId: "ibatexas",
      channel: "web",
      customerId: "cust_001",
      isAuthenticated: true,
      orderId: "ord_001",
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

function cancelEnvelope(sessionId: string) {
  return buildEnvelope({
    kind: "order.cancel",
    payload: { orderId: "ord_001" },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "nonce-cancel-1",
  });
}

function regenerateEnvelope(sessionId: string) {
  return buildEnvelope({
    kind: "payment.pix.regenerate",
    payload: { orderId: "ord_001" },
    actor: { principal: "llm", sessionId },
    taint: "UNTRUSTED",
    nonce: "nonce-regen-1",
  });
}

// ── The governance critic's named conformance fixture ───────────────────────

describe("T3-4 conformance — out-of-scope agent kind where confirmOnAutoResolve matches", () => {
  // `order.cancel` is in AUTORESOLVE_CONFIRM_KINDS and NOT in the PIX
  // agent's declaredIntentKinds — the exact collision the critic named.
  it("counterfactual: WITHOUT the agent AUTH guards the trap fires — REQUEST_CONFIRMATION", () => {
    const decision = adjudicate(
      cancelEnvelope(AGENT_SESSION),
      cancelTrapState(),
      bundleWithoutAgentGuards(ordersPack),
    );
    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
  });

  it("production composition: REFUSE agent_scope_violation — never REQUEST_CONFIRMATION", () => {
    const decision = adjudicate(
      cancelEnvelope(AGENT_SESSION),
      cancelTrapState(),
      composedBundle(ordersPack),
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind === "REFUSE") {
      expect(decision.refusal.code).toBe(AGENT_SCOPE_REFUSAL_CODE);
      expect(decision.refusal.kind).toBe("AUTH");
      // pt-BR user-facing copy (CLAUDE.md hard rule #4).
      expect(decision.refusal.userFacing).toMatch(/agente.*não tem permissão/i);
      expect(decision.basis.some((b) => b.category === "auth")).toBe(true);
    }
  });

  it("non-agent traffic is untouched: the same envelope from a customer still REQUEST_CONFIRMATIONs", () => {
    const decision = adjudicate(
      cancelEnvelope("cust_001"),
      cancelTrapState(),
      composedBundle(ordersPack),
    );
    expect(decision.kind).toBe("REQUEST_CONFIRMATION");
  });
});

// ── In-scope, budgets, unknown namespaces (kernel-level, real packs) ─────────

describe("T3-4 conformance — in-scope / over-budget / unknown agent", () => {
  it("in-scope kind from the registered agent passes the adopter guards → pack EXECUTEs", () => {
    const decision = adjudicate(
      regenerateEnvelope(AGENT_SESSION),
      regenerateState(),
      composedBundle(paymentsPack),
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("over-budget agent session ESCALATEs to supervisor (at and above tokensPerDay)", () => {
    for (const consumed of [TOKENS_PER_DAY, TOKENS_PER_DAY + 50_000]) {
      const decision = adjudicate(
        regenerateEnvelope(AGENT_SESSION),
        regenerateState({ agentTokensConsumed: consumed }),
        composedBundle(paymentsPack),
      );
      expect(decision.kind).toBe("ESCALATE");
      if (decision.kind === "ESCALATE") {
        expect(decision.to).toBe("supervisor");
        expect(decision.reason).toContain(PIX_REMEDIATION_AGENT.id);
      }
    }
  });

  it("under budget (and with an absent meter) the budget guard stays silent", () => {
    for (const ctx of [
      regenerateState({ agentTokensConsumed: TOKENS_PER_DAY - 1 }),
      regenerateState(), // meter absent — fail-open (host caps still bound the run)
    ]) {
      const decision = adjudicate(
        regenerateEnvelope(AGENT_SESSION),
        ctx,
        composedBundle(paymentsPack),
      );
      expect(decision.kind).toBe("EXECUTE");
    }
  });

  it("over-budget non-agent session is NOT escalated by the agent guards", () => {
    const decision = adjudicate(
      regenerateEnvelope("cust_001"),
      regenerateState({ agentTokensConsumed: TOKENS_PER_DAY * 10 }),
      composedBundle(paymentsPack),
    );
    expect(decision.kind).toBe("EXECUTE");
  });

  it("an UNREGISTERED agent namespace fails closed, even for a kind the pack would execute", () => {
    const decision = adjudicate(
      regenerateEnvelope("agent:ghost-agent@9.9.9:entity:pay_001"),
      regenerateState(),
      composedBundle(paymentsPack),
    );
    expect(decision.kind).toBe("REFUSE");
    if (decision.kind === "REFUSE") {
      expect(decision.refusal.code).toBe(AGENT_SCOPE_REFUSAL_CODE);
    }
  });
});

// ── Guard-level unit semantics ───────────────────────────────────────────────

const scopeGuard = createAgentScopeGuard(AGENT_REGISTRY);

describe("createAgentScopeGuard (unit)", () => {
  it("returns null (no opinion) for every non-agent sessionId shape", () => {
    for (const sessionId of [
      "cust_001", // customer principal
      "hashed:ab12cd34", // redacted chat namespace
      "payments.events:evt_1", // system-actor subject:eventId
      "agente:nao-e-namespace", // near-miss prefix
    ]) {
      expect(scopeGuard(cancelEnvelope(sessionId), {})).toBeNull();
    }
  });

  it("declared kind → null; undeclared kind → REFUSE with SCOPE_INSUFFICIENT detail", () => {
    expect(scopeGuard(regenerateEnvelope(AGENT_SESSION), {})).toBeNull();
    const refused = scopeGuard(cancelEnvelope(AGENT_SESSION), {});
    expect(refused?.kind).toBe("REFUSE");
    if (refused?.kind === "REFUSE") {
      expect(refused.refusal.code).toBe(AGENT_SCOPE_REFUSAL_CODE);
      expect(refused.basis[0]?.code).toBe("scope_insufficient");
    }
  });

  it("a bare/malformed `agent:` sessionId is treated as an unknown agent (fail-closed)", () => {
    for (const sessionId of ["agent:", "agent:not-a-registered-thing"]) {
      const refused = scopeGuard(regenerateEnvelope(sessionId), {});
      expect(refused?.kind).toBe("REFUSE");
      if (refused?.kind === "REFUSE") {
        expect(refused.refusal.code).toBe(AGENT_SCOPE_REFUSAL_CODE);
        expect(refused.basis[0]?.code).toBe("identity_missing");
      }
    }
  });
});

describe("createAgentBudgetGuards (unit)", () => {
  const def: AgentDefinition = {
    id: "test-agent",
    version: "0.1.1",
    displayName: "Agente de teste",
    declaredIntentKinds: ["payment.pix.regenerate"],
    trigger: { subjects: ["payment.status_changed"], eventKinds: ["payment.failed"] },
    autonomyStage: 0,
    budgets: {
      maxModelCallsPerTrigger: 1,
      wallClockMsPerTrigger: 1_000,
      tokensPerDay: 1_000,
      cooldownSeconds: 0,
    },
    killSwitchKey: "agent:test-agent",
    owner: "owner@example.com",
    sessionIdPrefix: "agent:test-agent@0.1.1",
  };

  it("mints one guard per agent WITH tokensPerDay; none for agents without", () => {
    const { tokensPerDay: _omit, ...rest } = def.budgets;
    const noBudgetDef: AgentDefinition = {
      ...def,
      id: "no-budget-agent",
      sessionIdPrefix: "agent:no-budget-agent@0.1.1",
      budgets: rest,
    };
    expect(createAgentBudgetGuards([def, noBudgetDef])).toHaveLength(1);
    expect(createAgentBudgetGuards([noBudgetDef])).toHaveLength(0);
  });

  it("matches its agent namespace EXACTLY — @0.1.1 never meters @0.1.10 sessions", () => {
    const [guard] = createAgentBudgetGuards([def]);
    const over = { ctx: { agentTokensConsumed: 5_000 } };
    expect(
      guard!(regenerateEnvelope("agent:test-agent@0.1.1:entity:e1"), over)?.kind,
    ).toBe("ESCALATE");
    expect(
      guard!(regenerateEnvelope("agent:test-agent@0.1.10:entity:e1"), over),
    ).toBeNull();
    expect(guard!(regenerateEnvelope("cust_001"), over)).toBeNull();
  });
});

describe("parseAgentSessionNamespace (unit)", () => {
  it("extracts the id@version namespace from full agent sessionIds", () => {
    expect(parseAgentSessionNamespace(AGENT_SESSION)).toBe(
      PIX_REMEDIATION_AGENT.sessionIdPrefix,
    );
    expect(
      parseAgentSessionNamespace("agent:test-agent@0.1.1:entity:pay_1"),
    ).toBe("agent:test-agent@0.1.1");
  });

  it("returns null for non-agent sessionIds", () => {
    expect(parseAgentSessionNamespace("cust_001")).toBeNull();
    expect(parseAgentSessionNamespace("hashed:ab12cd34")).toBeNull();
    expect(parseAgentSessionNamespace("agente:x")).toBeNull();
  });

  it("returns the raw remainder for prefix-only ids (unregisterable → fail-closed downstream)", () => {
    expect(parseAgentSessionNamespace("agent:")).toBe("agent:");
    expect(parseAgentSessionNamespace("agent:loose-id@1.0.0")).toBe(
      "agent:loose-id@1.0.0",
    );
  });
});
