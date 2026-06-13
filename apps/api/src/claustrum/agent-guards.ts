/**
 * Agent scope + budget guards (plan-v2 T3-4) — the kernel-side authorization
 * envelope for server-resident managed agents (@ibatexas/agents).
 *
 * ALTITUDE (the governance critic's finding, plan §9): both guards are
 * composed into the AUTH phase of EVERY pack bundle (kernel evaluation order:
 * state → taint → auth → business). They must NOT live in the business phase:
 * `confirmOnAutoResolveGuard` is PREPENDED to every pack's business phase, so
 * a business-phase scope guard would be short-circuited — an out-of-scope
 * money kind (e.g. `order.cancel`) from an agent would surface as
 * REQUEST_CONFIRMATION instead of REFUSE. The conformance fixture in
 * `__tests__/agent-guards.test.ts` pins exactly that trap.
 *
 * Identity model (D-017): a managed agent's envelopes carry
 * `actor.sessionId = agent:<id>@<version>:entity:<entityId>` (minted by
 * `agentSessionId()`, written UNHASHED to intent_audit). The namespace prefix
 * `agent:<id>@<version>` is the agent's authorization identity here:
 *
 *   - `createAgentScopeGuard(registry)` — REFUSE (code
 *     `agent_scope_violation`) any agent-namespaced envelope whose kind is
 *     outside that agent's `declaredIntentKinds`; an UNREGISTERED agent
 *     namespace always REFUSEs (fail-closed — the `agent:` prefix is
 *     reserved). Non-agent envelopes pass through untouched (null).
 *
 *   - `createAgentBudgetGuards(registry)` — per-agent over-budget ESCALATE
 *     via `createEscalateGuard` from @adjudicate/primitives (threshold =
 *     `budgets.tokensPerDay`; `createTokenBudgetGuard`'s action union is
 *     REFUSE|DEFER only and cannot ESCALATE — the feasibility critic's
 *     correction). The meter is the `llm:tokens`-shaped counter the resolve
 *     stage injects into `state.ctx.agentTokensConsumed` for agent sessions
 *     (resolve-and-assemble.ts, keyed by the agent namespace through
 *     `sessionTokenKey`). An absent meter means "no opinion" (the guard
 *     never fires on missing data — parity with the F4 read side's
 *     fail-open-to-0 posture; host hard caps in T3-2 still bound the run).
 *
 * Pure (no I/O) — composable by the policy-manifest exporter and the CLI
 * without booting the conductor (same constraint as compose-policy-packs).
 */

import { basis, BASIS_CODES, decisionRefuse, refuse } from "@adjudicate/core";
import { nameGuard, type Guard } from "@adjudicate/core/kernel";
import { createEscalateGuard } from "@adjudicate/primitives";
import { AGENT_SESSION_NAMESPACE, type AgentDefinition } from "@ibatexas/agents";

/**
 * Stable machine-readable refusal code for every agent-scope refusal
 * (out-of-scope kind AND unregistered agent namespace). Journey oracles and
 * the T3-6 shadow monitors assert this exact string.
 */
export const AGENT_SCOPE_REFUSAL_CODE = "agent_scope_violation";

/** Ctx key the resolve stage injects the agent token meter under. */
export const AGENT_TOKENS_CONSUMED_CTX_KEY = "agentTokensConsumed";

/**
 * Machine-readable refusal code for a kill-switched agent. Journey oracles and
 * the T3-6 shadow monitors assert this exact string; the decision also carries
 * a `kill.ACTIVE` basis (the kernel's own kill-switch basis category).
 */
export const AGENT_KILL_SWITCH_REFUSAL_CODE = "agent_kill_switch_active";

/**
 * Parse the agent namespace prefix (`agent:<id>@<version>`) out of a
 * sessionId, or null when the sessionId is not agent-namespaced. The
 * namespace is the segment up to the first `:` after the `agent:` marker
 * (agent ids are kebab-case and versions plain x.y.z — neither can carry a
 * colon, enforced by AgentDefinitionSchema), so
 * `agent:pix-payment-failure-remediation@0.1.0:entity:pay_1` →
 * `agent:pix-payment-failure-remediation@0.1.0`. A bare/malformed
 * `agent:`-prefixed sessionId returns the (unregisterable) raw remainder so
 * the scope guard fails it closed as an unknown agent rather than treating
 * it as non-agent traffic.
 */
export function parseAgentSessionNamespace(sessionId: string): string | null {
  if (!sessionId.startsWith(AGENT_SESSION_NAMESPACE)) return null;
  const rest = sessionId.slice(AGENT_SESSION_NAMESPACE.length);
  const cut = rest.indexOf(":");
  const idAtVersion = cut === -1 ? rest : rest.slice(0, cut);
  return `${AGENT_SESSION_NAMESPACE}${idAtVersion}`;
}

const refuseOutOfScope = (detail: string) =>
  refuse(
    "AUTH",
    AGENT_SCOPE_REFUSAL_CODE,
    "Este agente não tem permissão para executar esta ação.",
    detail,
  );

/**
 * AUTH-phase scope guard over the managed-agent roster. See module header
 * for semantics; composed into every pack bundle by
 * `buildIbatexasPolicyPacks` (compose-policy-packs.ts).
 */
export function createAgentScopeGuard(
  registry: ReadonlyArray<AgentDefinition>,
): Guard<string, unknown, unknown> {
  const byNamespace = new Map<
    string,
    { readonly def: AgentDefinition; readonly kinds: ReadonlySet<string> }
  >(
    registry.map((def) => [
      def.sessionIdPrefix,
      { def, kinds: new Set(def.declaredIntentKinds) },
    ]),
  );

  const guard: Guard<string, unknown, unknown> = (envelope, _state) => {
    const namespace = parseAgentSessionNamespace(envelope.actor.sessionId);
    // Non-agent traffic (customers, staff, system subscribers, hashed run
    // namespaces) passes through untouched.
    if (namespace === null) return null;

    const entry = byNamespace.get(namespace);
    if (entry === undefined) {
      // The `agent:` sessionId namespace is RESERVED for registered managed
      // agents — an unknown id@version is a forged or drifted identity.
      return decisionRefuse(
        refuseOutOfScope(
          `unregistered agent namespace "${namespace}" (kind "${envelope.kind}")`,
        ),
        [
          basis("auth", BASIS_CODES.auth.IDENTITY_MISSING, {
            agentNamespace: namespace,
            kind: envelope.kind,
            reason: "agent_not_registered",
          }),
        ],
      );
    }

    if (!entry.kinds.has(envelope.kind)) {
      return decisionRefuse(
        refuseOutOfScope(
          `agent "${entry.def.id}@${entry.def.version}" declared ` +
            `[${entry.def.declaredIntentKinds.join(", ")}] but expressed ` +
            `kind "${envelope.kind}"`,
        ),
        [
          basis("auth", BASIS_CODES.auth.SCOPE_INSUFFICIENT, {
            agentId: entry.def.id,
            agentVersion: entry.def.version,
            kind: envelope.kind,
            reason: "intent_kind_not_declared",
          }),
        ],
      );
    }

    return null;
  };
  return nameGuard("agentScope", guard);
}

const refuseKilled = (detail: string) =>
  refuse(
    "SECURITY",
    AGENT_KILL_SWITCH_REFUSAL_CODE,
    "Este agente está temporariamente desativado.",
    detail,
  );

/**
 * AUTH-phase kill-switch guard. REFUSEs every `agent:`-namespaced envelope whose
 * agent is currently killed (`isKilled` reads the live per-agent state from the
 * {@link AgentKillSwitchManager}); non-agent traffic and live agents pass
 * through (null). The decision carries a `kill.ACTIVE` basis — the kernel's own
 * kill-switch basis — so audit/replay treat it identically to a global kill.
 *
 * `isKilled` is injected (late-bound at bootstrap to the live manager) so the
 * guard composes the same way for the conductor AND the pure policy-manifest
 * exporter / CLI, where it defaults to "never killed" (a kill switch is a
 * RUNTIME control, not static policy). Pure: an in-memory map lookup, no I/O at
 * decision time — exactly the kernel's own `RuntimeContext.killSwitch.isKilled()`
 * posture.
 */
export function createAgentKillSwitchGuard(
  isKilled: (agentNamespace: string) => boolean,
): Guard<string, unknown, unknown> {
  const guard: Guard<string, unknown, unknown> = (envelope, _state) => {
    const namespace = parseAgentSessionNamespace(envelope.actor.sessionId);
    if (namespace === null) return null;
    if (!isKilled(namespace)) return null;
    return decisionRefuse(
      refuseKilled(
        `agent namespace "${namespace}" kill switch active (kind "${envelope.kind}")`,
      ),
      [
        basis("kill", BASIS_CODES.kill.ACTIVE, {
          agentNamespace: namespace,
          kind: envelope.kind,
          reason: "agent_kill_switch_active",
        }),
      ],
    );
  };
  return nameGuard("agentKillSwitch", guard);
}

/**
 * Per-agent over-budget ESCALATE guards (AUTH phase, after the scope guard).
 * One guard per registered agent that declares `budgets.tokensPerDay`;
 * each matches ONLY its own agent namespace (exact-namespace match — never a
 * raw startsWith, so `…@0.1.1` can never meter `…@0.1.10`'s sessions).
 */
export function createAgentBudgetGuards(
  registry: ReadonlyArray<AgentDefinition>,
): ReadonlyArray<Guard<string, unknown, unknown>> {
  return registry
    .filter((def) => def.budgets.tokensPerDay !== undefined)
    .map((def) => {
      const tokensPerDay = def.budgets.tokensPerDay as number;
      return nameGuard(
        `agentTokenBudget:${def.id}`,
        createEscalateGuard<string, unknown, unknown>({
          matches: (envelope) =>
            parseAgentSessionNamespace(envelope.actor.sessionId) ===
            def.sessionIdPrefix,
          // Absent meter → null/undefined → the factory short-circuits to
          // "no opinion" (see module header for the fail-open rationale).
          extract: (_envelope, state) =>
            (state as { ctx?: { agentTokensConsumed?: number } }).ctx
              ?.agentTokensConsumed ?? null,
          threshold: tokensPerDay,
          comparator: ">=",
          to: "supervisor",
          reason: (value, threshold) =>
            `Agente ${def.id}@${def.version} excedeu o orçamento diário de ` +
            `tokens (${value} >= ${threshold}) — revisão de supervisor ` +
            `necessária antes de continuar.`,
          basis: (value, threshold) => [
            basis("business", BASIS_CODES.business.RULE_SATISFIED, {
              rule: "agent_token_budget_exceeded",
              agentId: def.id,
              agentVersion: def.version,
              threshold,
              value,
            }),
          ],
        }),
      );
    });
}
