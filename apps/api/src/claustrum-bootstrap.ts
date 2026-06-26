// Claustrum bootstrap — wires up the @claustrum/* Conductor for ibatexas.
//
// Replaces the legacy `kernel-bootstrap.ts` plugin (deferred deletion). This
// is the new authoritative composition root for the chat surface (web + WA).
//
// The bootstrap is run ONCE at process start (in `server.ts` after Fastify
// is instantiated). It composes:
//
//   - ModelProvider          AnthropicProvider (Anthropic SDK)
//   - MemoryPort             createPostgresMemoryProvider (Prisma + Redis)
//   - GroundingPort          createPgVectorGroundingProvider (pgvector)
//   - ChannelDriver[]        [WhatsAppChannel, WebChannel]
//   - Adjudicator            buildAdjudicator() wrapping @adjudicate/core
//   - PlannerPort            createIbatexasPlanner() (LLM intent extractor over
//                            the 5 packs' CapabilityPlanners — RC-A1 Phase A.1)
//   - ResponderPort          createIbatexasResponder() (decision-aware; renders
//                            the explainer verbatim on REFUSE, grounds the model
//                            on EXECUTE — claustrum/ibatexas-responder.ts)
//   - ExplainerPort          ibatexasExplainer() (pt-BR templates)
//   - HandoffPort            natsHandoff() (ESCALATE → support.handoff_requested)
//   - TelemetryPort          fastifyTelemetry() (pino + prom-client)
//   - SessionPort            redisSessionStore() (Redis-backed sessions)
//   - ToolRegistry           ibatexas tool packs registered as ToolDefinitions
//   - TenantResolver         resolveIbatexasTenantPolicy() → composePolicyRouter
//                            (per-kind PolicyBundle over the packs — Phase A.2)
//
// CRITICAL: `installFirstPartyPacks()` MUST run before `assertAuditPostgresReady()`
// because policies use shared types from the packs.
//
// Boundary discipline (per claustrum CLAUDE.md):
//   - Adjudicator is the ONLY kernel-facing port — never `import "@adjudicate/core"`
//     from inside packs/* or routes/*. Always go through `capsule.adjudicator`.
//   - Capsule is per-turn; the Conductor is process-wide. Reviewers MUST surface
//     any `ctx.adjudicate(...)` calls and verify `ctx` is a Capsule, not a kernel
//     RuntimeContext.

import Anthropic from "@anthropic-ai/sdk";
import { Pool } from "pg";
import {
  createConductor,
  createToolRegistry,
  type Adjudicator,
  type AuditVerification,
  type Capsule,
  type ChannelDriver,
  type ConfirmationReceipt,
  type Conductor,
  type ExplainerPort,
  type HandoffPort,
  type CognitiveState,
  type LLMTrace,
  type MemoryAccess,
  type ModelProvider,
  type PlannerPort,
  type ResponderPort,
  type Session,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
  type TurnRecord,
} from "@claustrum/core";
import { AnthropicProvider } from "@claustrum/anthropic";
import { OpenAIProvider } from "@claustrum/openai";
import {
  createPostgresMemoryProvider,
  PostgresAdvisorySessionLock,
  type PrismaClientLike,
  type RedisClientLike,
} from "@claustrum/memory-postgres";
import { createPgVectorGroundingProvider } from "@claustrum/grounding-pgvector";
import { failSafeGrounding } from "./claustrum/fail-safe-grounding.js";
import { failSafeMemory } from "./claustrum/fail-safe-memory.js";
import { noopGroundingProvider, noopMemoryProvider } from "./claustrum/noop-memory-grounding.js";
import { OllamaFetchClient } from "./claustrum/ollama-fetch-client.js";
import { providerCanEmbed } from "./claustrum/provider-embed-capability.js";
import { WhatsAppChannel } from "@claustrum/channel-whatsapp";
import { WebChannel } from "@claustrum/channel-web";

// Kernel types — @adjudicate/core is the source of truth for envelope +
// decision shapes. The runtime imports them as types ONLY (per claustrum
// CLAUDE.md rule #6). Concrete kernel verbs (adjudicate, installPack) are
// re-exported from @adjudicate/core's root barrel.
import type {
  AuditRecord,
  AuditSink,
  Decision,
  IntentEnvelope,
  Ledger,
} from "@adjudicate/core";
import {
  AUDIT_RECORD_VERSION,
  adjudicateAndAudit,
  decisionRefuse,
  installPack,
  refuse,
  verifyAuditRecord as kernelVerifyAuditRecord,
} from "@adjudicate/core";
// pt-BR refusal registry (code → curated, detail-free pt-BR text). The kernel +
// pack refusals carry a stable `code`; the explainer localizes by it.
import { portugueseRefusalMessages } from "@adjudicate/locales-pt-br";
// Execution ledger implementation — Redis SET-NX dedup behind the kernel's
// Ledger contract (the contract itself lives in @adjudicate/core, above).
import {
  createRedisLedger,
  type RedisLedgerClient,
  type RedisPubSubClient,
} from "@adjudicate/audit";

import { prisma, createOrderQueryService, createPaymentQueryService } from "@ibatexas/domain";
import { rehydratePaymentState } from "@ibatexas/pack-payments";
import { emitLlmCall, getRedisClient, rk } from "@ibatexas/tools";
import { publishNatsEvent } from "@ibatexas/nats-client";
import { AGENT_REGISTRY } from "@ibatexas/agents";
// Managed-agent plane (T3-9) — composed + started behind IBX_AGENTS_ENABLED.
import { SystemChannel } from "./claustrum/system-channel.js";
import {
  createAgentApprovalEngine,
  type AgentApprovalEngine,
  type AgentApprovalRequest,
  type AgentApprovalStatus,
} from "./claustrum/agent-approvals.js";
// H2 (ERDS-061/062) — mirror the agent-approval registry into the adjudicate
// Redis registry (shared keyPrefix adjudicate:approval) so the adjudicate
// console/adjutant operator UIs read agent approvals. Best-effort, fail-open.
import { createRedisApprovalRegistry } from "@adjudicate/approval-engine";
import { createApprovalRedisClient } from "./claustrum/approval-engine-redis-wiring.js";
import {
  createAgentApprovalEngineBridge,
  mirrorTtlSeconds,
} from "./claustrum/approval-engine-bridge.js";
import {
  agentsEnabled,
  startManagedAgentPlane,
} from "./claustrum/managed-agent-plane.js";
import type { AgentPlane } from "./claustrum/agent-plane.js";
import type { LiveAgentConductorDeps } from "./claustrum/live-agent-conductor.js";
import { createPostgresAgentRunJournal } from "./claustrum/agent-run-journal.js";
import { createRefundCircuitBreaker } from "./claustrum/agent-realmoney-safety.js";
import { createRemediationProposalWriter } from "./claustrum/remediation-proposal-writer.js";
// ERDS-059 — durable per-llm.call token→USD persistence (best-effort, fail-open).
import {
  createPostgresTokenUsageSink,
  type TokenUsageSink,
} from "./claustrum/token-usage-sink.js";

/**
 * The intent kinds the composed kernel policy confirm-gates for agent sessions
 * (the B1 rule in pixPolicyBundle.business). Hand-maintained to mirror the
 * composed policy: if a new real-money kind is added to REAL_MONEY_KINDS without
 * a B1 confirm rule added here, startManagedAgentPlane's fail-closed assertion
 * crashes the boot rather than letting money move ungated.
 */
const AGENT_CONFIRM_GATED_KINDS: ReadonlySet<string> = new Set<string>([
  "pix.charge.refund",
]);

// Audit sink — dev's audit pipeline owns the durable AuditRecord store. The
// adjudicator consumes the sink composed by `@ibatexas/audit-sink` (boot-time
// DI). This replaces the audit-branch's bare `createPostgresSink` block: the
// dev audit-sink threads Postgres + NATS + Redis-spill + PII redaction, and is
// wired here via `bootstrapAuditSinkDI()` before `buildAdjudicator()` reads it.
import { __resetAuditSink, getAuditSink } from "@ibatexas/audit-sink";
import { bootstrapAuditSinkDI } from "./audit-sink-bootstrap.js";
// ERDS-060 — learning telemetry sink (learning.event.v1). Best-effort, fail-open;
// injected into the managed-agent plane so each trigger turn emits a learning event.
import { getLearningSink } from "./learning-sink-bootstrap.js";

// ── RC-A1 cutover composition (Phase A.1/A.2) ────────────────────────────────
// The production planner + per-kind PolicyBundle router, composed over the 5
// first-party packs. INERT until bootstrapClaustrum() is called.
import type { MetricsSink, PolicyBundle } from "@adjudicate/core/kernel";
import {
  _resetMetricsSink,
  hasMetricsSink,
  setMetricsSink,
} from "@adjudicate/core/kernel";
import { createIbatexasMetricsSink } from "./observability/metrics-sink.js";
import { logger } from "./lib/logger.js";
// The five first-party packs are named in exactly ONE site —
// @ibatexas/packs-composed (a workspace package, so the CLI/journeys gates
// can consume the same composition; an apps/api export is unreachable from
// packages/*). The pix lifecycle pack is the platform adopter pack (ADR #13),
// not first-party, so it stays a direct registry import.
import {
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
  IBATEXAS_COMPOSED_PACKS,
  composedIntentKinds,
} from "@ibatexas/packs-composed";
import { paymentsPixPack } from "@adjudicate/pack-payments-pix";
import { requireSecret } from "./utils/require-secret.js";
import { requireEnv } from "./utils/require-env.js";
import {
  composePolicyRouter,
  resolveCapabilityPolicy,
  type CapabilityPolicyPack,
} from "./claustrum/capability-policy.js";
import {
  SESSION_TOKEN_BUDGET,
  IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  buildIbatexasPolicyPacks,
  type ErasedPack,
} from "./claustrum/compose-policy-packs.js";
import {
  verifyConfigSeal,
  type SealablePackInput,
} from "@adjudicate/conformance";
import {
  createIbatexasPlanner,
  type ClaimAwarePlannerPort,
} from "./claustrum/ibatexas-planner.js";
import { buildClaimsSeams } from "./claustrum/claims-pipeline.js";
import { createIbatexasResponder } from "./claustrum/ibatexas-responder.js";
import { createIbatexasPromptComposer } from "./claustrum/prompts/ibatexas-prompts.js";
import {
  createTurnTraceWriter,
  type TurnTraceWriter,
} from "./claustrum/turn-trace-writer.js";
import { createIbatexasResolver } from "./claustrum/ibatexas-resolver.js";
import { sessionTokenKey, resolveAndAssemble } from "./claustrum/resolve-and-assemble.js";
import {
  buildCustomerAuthority,
  customerPrincipalForSession,
  resourceRefsForIntent,
} from "./claustrum/authority-wiring.js";
import {
  createInMemoryTokenUsageStore,
  type TokenUsageStore,
} from "@adjudicate/adapter-core";
import {
  listIbatexasToolPacks,
  registerIbatexasToolPacks,
  toolRosterDrift,
} from "./tools/register-ibatexas-tool-packs.js";
import {
  createAuditReadPaths,
  postgresReaderFromPool,
  type AuditReadPaths,
} from "./claustrum/audit-read-paths.js";

// ── Singleton ────────────────────────────────────────────────────────────────

let _conductor: Conductor | null = null;
// Managed-agent plane singleton (T3-9). Null unless IBX_AGENTS_ENABLED started it.
let _agentPlane: AgentPlane | null = null;
// Stage-1 approval engine (T3-7). Hoisted so the staff HTTP approvals route
// (routes/admin/agent-approvals.ts, WS-D1) can reach the SAME in-memory parked
// store the plane uses. Null unless IBX_AGENTS_ENABLED created it.
let _agentApprovals: AgentApprovalEngine | null = null;
// P4 proposal writer (set when the plane boots). The gateway's resolve updates
// the remediation_proposal status so the adjutant projection reflects it.
let _proposalWriter: ReturnType<typeof createRemediationProposalWriter> | null = null;
// The per-bootstrap pg Pool (audit readiness probe + audit read paths +
// pgvector grounding + advisory session lock). Tracked at module level so
// `resetClaustrumForTests()` can end it — a leaked pool keeps the vitest
// process (and any postgres testcontainer) alive. `_ownsPgPool` is false when
// the pool was injected via `ClaustrumBootstrapOptions.pgPool` — an injected
// pool is CALLER-owned and never ended by the reset hook.
let _pgPool: Pool | null = null;
let _ownsPgPool = false;

export function getConductor(): Conductor {
  if (!_conductor) {
    throw new Error(
      "Claustrum Conductor not initialized. Call bootstrapClaustrum() in server.ts before serving requests.",
    );
  }
  return _conductor;
}

// ── Stage-1 agent approvals — HTTP gateway (WS-D1) ───────────────────────────
//
// Exposes the SAME in-memory approval engine the managed-agent plane uses to the
// staff HTTP route (routes/admin/agent-approvals.ts), so a Stage-1
// REQUEST_CONFIRMATION can be resolved over the wire. `resolve(accept:true)`
// re-adjudicates the IDENTICAL parked envelope through `adjudicateAndAudit` with
// the confirmation receipt — the kernel substitutes EXECUTE for the matching
// intentHash WHILE STILL ENFORCING EVERY GUARD, so an honest-but-imperfect
// rebuilt state can only REFUSE, never falsely EXECUTE. The audited EXECUTE +
// supersession lineage IS the "confirm→EXECUTE over the wire" this closes; the
// downstream side effect stays the agent runner's concern (the engine, by
// design, adjudicates+audits — it carries no executor).

export interface AgentApprovalGateway {
  list(filter?: { status?: AgentApprovalStatus }): ReadonlyArray<AgentApprovalRequest>;
  get(token: string): AgentApprovalRequest | null;
  resolve(input: {
    token: string;
    accepted: boolean;
    resolvedBy: { id: string; displayName?: string };
  }): ReturnType<AgentApprovalEngine["resolve"]>;
}

/**
 * Rebuild the FRESH pack state for an agent approval resume from the real
 * entity (the agent's only Stage-2 executing kind today is
 * `payment.pix.regenerate`). Built HONESTLY from `createPaymentQueryService`;
 * the kernel re-runs every guard on resume, so a missing/stale field yields a
 * REFUSE, never an unsafe EXECUTE.
 */
async function rebuildAgentApprovalState(_kind: string, payload: unknown): Promise<unknown> {
  const p = (payload ?? {}) as { paymentId?: unknown };
  const paymentId = typeof p.paymentId === "string" ? p.paymentId : null;
  if (paymentId === null) return rehydratePaymentState({ ctx: { exists: false } });

  const pay = (await createPaymentQueryService().getById(paymentId)) as {
    status?: string;
    method?: string;
    version?: number;
    orderId?: string;
    amountInCentavos?: number;
    regenerationCount?: number;
  } | null;
  if (pay === null) return rehydratePaymentState({ ctx: { exists: false } });

  return rehydratePaymentState({
    ctx: {
      exists: true,
      currentStatus: pay.status,
      currentMethod: pay.method,
      version: pay.version,
      orderId: pay.orderId,
      amountInCentavos: pay.amountInCentavos,
      regenerationCount: pay.regenerationCount,
    },
  });
}

/**
 * The staff approvals gateway, or null when the managed-agent plane is not
 * enabled (no engine → the route returns 404/empty). `policyForKind` +
 * `getAuditSink()` are read lazily so they always reflect the live wiring.
 */
export function getAgentApprovalGateway(): AgentApprovalGateway | null {
  const engine = _agentApprovals;
  if (engine === null) return null;
  return {
    list: (filter) => engine.list(filter),
    get: (token) => engine.get(token),
    resolve: async ({ token, accepted, resolvedBy }) => {
      const result = await engine.resolve({
        token,
        accepted,
        resolvedBy,
        rebuildState: rebuildAgentApprovalState,
        policyFor: (k) => {
          const policy = policyForKind(k);
          if (policy === null) {
            throw new Error(`agent approval: no installed pack owns kind "${k}"`);
          }
          return policy;
        },
        sink: getAuditSink(),
      });
      // P4: reflect the resolution in the remediation_proposal so the adjutant
      // projection shows executed/declined (best-effort; never blocks resolve).
      await _proposalWriter?.markResolvedByToken(
        token,
        accepted ? "executed" : "declined",
        new Date().toISOString(),
      );
      return result;
    },
  };
}

// ── Injectable seams (T2-6a — scripted-pipeline harness) ────────────────────

/**
 * Optional DI seams for `bootstrapClaustrum()`. Production call sites pass
 * NOTHING (zero-arg call in `index.ts` — today's behavior, unchanged); the
 * scripted journey harness (T2-6b) injects a content-keyed ModelProvider plus
 * test-plane infra so a full Conductor composition boots at zero token cost.
 *
 * Scope notes (honest seams, not a full IoC container):
 *  - `redis` overrides the BOOT-TIME client only (execution ledger + memory
 *    provider). The session store and telemetry fold resolve
 *    `getRedisClient()` lazily per call — in the test harness those converge
 *    on the same server because `REDIS_URL` points at the test container.
 *  - `auditSink`, when injected, is handed straight to the adjudicator bridge
 *    and `bootstrapAuditSinkDI()` is SKIPPED — the global `@ibatexas/audit-
 *    sink` leaf DI is left untouched (a test can wire/inspect it separately).
 *  - `metricsSink`, when injected, is installed UNCONDITIONALLY via
 *    `setMetricsSink()` (a test wants determinism); the zero-arg path keeps
 *    the WS7 guard (only install when no sink is present — the production
 *    sink from `installKernelMetricsSink()` wins).
 *  - A warm singleton wins: when `_conductor` already exists the options are
 *    IGNORED and the cached instance is returned (zero-arg double-init parity
 *    with index.ts). Harnesses MUST call `resetClaustrumForTests()` between
 *    differently-composed bootstraps.
 */
export interface ClaustrumBootstrapOptions {
  /**
   * ModelProvider for planner + responder + grounding embeds. Default: a
   * fresh `AnthropicProvider` over the Anthropic SDK (`ANTHROPIC_API_KEY`).
   * When injected, the Anthropic SDK client is never constructed.
   */
  readonly modelProvider?: ModelProvider;
  /**
   * pg Pool for the audit readiness probe, audit read paths, pgvector
   * grounding, and the advisory session lock. Default: a new `Pool` over
   * `DATABASE_URL`, OWNED by the bootstrap (ended by the reset hook).
   * Injected pools are caller-owned: the reset hook never ends them.
   */
  readonly pgPool?: Pool;
  /**
   * AuditSink for the adjudicator bridge. Default: `bootstrapAuditSinkDI()` +
   * `getAuditSink()` (the composed Postgres/NATS/spill/redaction pipeline).
   */
  readonly auditSink?: AuditSink;
  /** Kernel MetricsSink. Default: WS7 guard semantics (see above). */
  readonly metricsSink?: MetricsSink;
  /**
   * Boot-time Redis client (execution ledger + memory provider). Default:
   * the `@ibatexas/tools` singleton via `getRedisClient()` (`REDIS_URL`).
   */
  readonly redis?: Awaited<ReturnType<typeof getRedisClient>>;
}

/**
 * Test-fingerprint gate for the test-only surfaces below. Allowed only under
 * `NODE_ENV=test` (vitest) or when `IBX_TEST_FINGERPRINT` is set (the test
 * profile env, D-010) — a production composition can never reach them.
 */
function assertTestOnlySurface(surface: string): void {
  const fingerprint = process.env.IBX_TEST_FINGERPRINT;
  if (
    process.env.NODE_ENV === "test" ||
    (typeof fingerprint === "string" && fingerprint.length > 0)
  ) {
    return;
  }
  throw new Error(
    `[claustrum-bootstrap] ${surface} is test-only. It requires NODE_ENV=test ` +
      `or IBX_TEST_FINGERPRINT to be set; refusing in this environment.`,
  );
}

/** What `resetClaustrumForTests()` actually did (per-leg, machine-checkable). */
export interface ClaustrumResetReport {
  /** A conductor existed and was cleared. */
  readonly conductorCleared: boolean;
  /**
   * The bootstrap-OWNED pg Pool was ended (`pool.end()` resolved). False when
   * no pool existed, when the pool was injected (caller-owned), or when
   * `end()` threw (logged, swallowed — reset must always complete).
   */
  readonly pgPoolEnded: boolean;
  /** `@ibatexas/audit-sink` leaf DI was cleared via `__resetAuditSink()`. */
  readonly auditSinkReset: boolean;
  /** Kernel MetricsSink reset via `_resetMetricsSink()` (see caveat below). */
  readonly metricsSinkReset: boolean;
}

/**
 * Full reset hook for in-process test harnesses (T2-6a). Clears every piece
 * of process-global state `bootstrapClaustrum()` establishes so two
 * sequential bootstraps in ONE vitest process do not cross-contaminate:
 *
 *  1. `_conductor` singleton → null (`getConductor()` throws again).
 *  2. The bootstrap-OWNED pg Pool → `pool.end()` (no leaked handles).
 *     Injected pools (caller-owned) are left open.
 *  3. Audit-sink leaf DI → `__resetAuditSink()` (deps + cached sink cleared;
 *     `getAuditSink()` fail-closes until the next `bootstrapAuditSinkDI()` —
 *     which the next zero-`auditSink` bootstrap re-runs).
 *  4. Global kernel MetricsSink → `_resetMetricsSink()` (upstream @internal
 *     test hook in `@adjudicate/core` — the ONLY unset path; `setMetricsSink`
 *     has no removal API). `hasMetricsSink()` returns false afterwards, so
 *     the next bootstrap installs a fresh sink. CAVEAT: in the production
 *     boot order this would drop the `installKernelMetricsSink()` production
 *     sink (PostHog/Sentry/Prometheus) — exactly why this hook is gated.
 *
 * Deliberately NOT reset (out of this hook's ownership):
 *  - The shared `@ibatexas/tools` Redis singleton — process-wide infra used
 *    by far more than the conductor; test teardown owns it via
 *    `closeRedisClient()`.
 *  - The W3 observability hook registries on the audit-sink leaf
 *    (`setAuditLagHook` etc.) — inert observers, re-registered by
 *    `installKernelMetricsSink()` in the production boot order only.
 *  - `tokenUsageStore` (module-level, ADR-135) — telemetry-only, outside the
 *    determinism boundary, LRU-bounded.
 *  - Installed kernel packs — `installPack` is re-run-safe (a stateless
 *    conformance check; see the index.ts boot-order note).
 */
export async function resetClaustrumForTests(): Promise<ClaustrumResetReport> {
  assertTestOnlySurface("resetClaustrumForTests()");

  // Tear down the managed-agent plane (kill pollers + bridge worker/subscriptions)
  // before clearing the conductor, so a re-bootstrap never double-subscribes.
  if (_agentPlane !== null) {
    try {
      await _agentPlane.stop();
    } catch (err) {
      logger.warn(
        { component: "managed-agent-plane", err: (err as Error).message },
        "resetClaustrumForTests: agent plane stop() failed (continuing)",
      );
    }
    _agentPlane = null;
  }
  _agentApprovals = null;

  const conductorCleared = _conductor !== null;
  _conductor = null;

  let pgPoolEnded = false;
  if (_pgPool && _ownsPgPool && !_pgPool.ended) {
    try {
      await _pgPool.end();
      pgPoolEnded = true;
    } catch (err) {
      logger.warn(
        { component: "claustrum-bootstrap", err: (err as Error).message },
        "resetClaustrumForTests: owned pg pool end() failed (continuing)",
      );
    }
  }
  _pgPool = null;
  _ownsPgPool = false;

  __resetAuditSink();
  _resetMetricsSink();

  return {
    conductorCleared,
    pgPoolEnded,
    auditSinkReset: true,
    metricsSinkReset: true,
  };
}

/**
 * Test-only accessor for the current per-bootstrap pg Pool (owned or
 * injected). Lets the reset acceptance test spy `end()` / assert `ended` on
 * the pool the bootstrap composed. Same gate as the reset hook.
 */
export function getClaustrumPgPoolForTests(): Pool | null {
  assertTestOnlySurface("getClaustrumPgPoolForTests()");
  return _pgPool;
}

// ── Adjudicator bridge ───────────────────────────────────────────────────────

/**
 * Dependencies the audited bridge closes over. Constructed once in
 * `bootstrapClaustrum()` from live infra (Postgres audit sink, Redis ledger);
 * injected as mocks/in-memory doubles in unit tests.
 */
export interface AdjudicatorBridgeDeps {
  /**
   * Audit sink — REQUIRED. Every adjudication emits an `AuditRecord` here.
   * This is the load-bearing change: the bridge previously called the
   * NON-audited `adjudicate()` and produced no record (audit RC-A1 prereq 3).
   */
  readonly sink: AuditSink;
  /**
   * Optional execution ledger for cross-turn replay-suppression / idempotency.
   * When present, a duplicate `intentHash` is suppressed to REPLAY_SUPPRESSED
   * so a side effect cannot double-fire across retried turns.
   */
  readonly ledger?: Ledger;
  /**
   * Optional audit READ paths (intent_audit / audit_outcomes) backing the
   * port's memory-recall surface — replayEnvelopesByCustomerId /
   * streamAuditByIntentHashPrefix / getOutcomes. Absent (unit tests, partial
   * composition) → those methods return empty. Fail-SAFE either way: these
   * reads feed recall, not the money path, and `createAuditReadPaths`
   * swallows read failures into empty results. The write-audit invariant
   * (`sink`, fail-closed) is independent of this dep.
   */
  readonly auditReads?: AuditReadPaths;
}

/**
 * Re-assemble the per-envelope SystemState ctx for a parked (already-resolved)
 * envelope on the resume path. The claustrum resume path adjudicates against
 * `resolution.state` (channel + customerId), not the plan-stage resolver's
 * enriched ctx — so without this the pack stateGuards would panic on the stub.
 * The parked envelope carries the RESOLVED id, so we re-load its entity state
 * (scoped to customerId). Fail-safe: falls back to the supplied state on any gap.
 */
async function enrichResumeState(
  envelope: IntentEnvelope,
  state: unknown,
): Promise<unknown> {
  const s = state as { channel?: string; customerId?: string };
  if (typeof s.customerId !== "string" || typeof s.channel !== "string") {
    return state;
  }
  try {
    const { payload, ctx, owned, ownershipIndeterminate } = await resolveAndAssemble({
      kind: envelope.kind,
      payload: (envelope.payload ?? {}) as Record<string, unknown>,
      customerId: s.customerId,
      channel: s.channel,
    });
    // 034-F1 (review finding 13): engage the kernel ownership/IDOR guard on the
    // RESUME re-adjudication too — the plan stage injects state.authority, but
    // without this the resumed envelope adjudicates with authority===undefined and
    // the guard is inert (asymmetric with the plan stage). The freshly-recomputed,
    // customer-scoped `owned` set is the load-bearing, non-tautological check (it
    // REFUSEs a now-unowned resource — e.g. an order reassigned since parking).
    //
    // principalForSession is bound to the PARKED envelope's actor.sessionId because
    // the resume turn's resolution.state carries no conversationId. This is safe:
    // the parked envelope ALREADY passed plan-stage IDOR (its actor.sessionId was
    // the authenticated session when parked — kernel-vetted, not raw input), and
    // the framework session-scopes park-matching, so the cross-session check is
    // covered upstream while resource-ownership is re-verified here.
    const refs = ownershipIndeterminate
      ? undefined
      : resourceRefsForIntent(envelope.kind, payload as Record<string, unknown>, s.customerId);
    if (refs !== undefined) {
      return {
        ctx,
        authority: buildCustomerAuthority(
          s.customerId,
          owned,
          customerPrincipalForSession(envelope.actor.sessionId, s.customerId),
        ),
      };
    }
    return { ctx };
  } catch {
    return state;
  }
}

/**
 * Wraps `@adjudicate/core`'s audited kernel verb (`adjudicateAndAudit`) +
 * `@adjudicate/audit-postgres` into the claustrum `Adjudicator` port. This is
 * the ONLY place in the ibatexas codebase that imports the kernel directly.
 *
 * Every adjudication now emits an AuditRecord via `deps.sink` — the cutover's
 * audit-completeness invariant ("a chat turn produces an AuditRecord, no direct
 * write"). Sink failures fail CLOSED (see `safeAuditedAdjudicate`).
 */
export function buildAdjudicator(deps: AdjudicatorBridgeDeps): Adjudicator {
  return {
    async adjudicate(envelope, state, policy): Promise<Decision> {
      return safeAuditedAdjudicate(
        deps,
        envelope as IntentEnvelope,
        state,
        policy,
      );
    },
    async resume(envelope, state, policy, receipt): Promise<Decision> {
      // Resume = RE-ADJUDICATE a parked envelope through the SAME audited
      // kernel path (one AuditRecord emitted BEFORE the caller dispatches).
      // The kernel re-runs every state/taint/auth guard against the supplied
      // (fresh, this-turn) state; the confirmation receipt only satisfies the
      // "ask the user first" threshold (REQUEST_CONFIRMATION → EXECUTE) and is
      // ignored if the re-adjudication returns anything else. A state change
      // that now REFUSEs is returned unchanged — never overridden by the
      // receipt (money-safety / the audit invariant). Omitting the receipt
      // (a deferred envelope whose condition is now met) is a plain
      // re-adjudication: EXECUTE only if the guards naturally pass.
      //
      // RESUME-PATH STATE ENRICHMENT: the claustrum resume path re-adjudicates the
      // PARKED envelope against `resolution.state` (channel+customerId), NOT the
      // plan-stage resolver's enriched ctx — so without this, the pack stateGuards
      // would panic on the stub ctx. The parked envelope already carries the
      // RESOLVED id (orderId/reservationId), so we re-assemble the per-envelope ctx
      // here from it (scoped to the resolved customerId). The auto-resolve flag is
      // NOT re-set (the id is now explicit), so confirm-on-autoresolve passes and
      // the kernel re-adjudicates against FRESH entity state (money-safety: a state
      // change since parking, e.g. order already shipped, REFUSEs).
      const resumeState = await enrichResumeState(envelope as IntentEnvelope, state);
      return safeAuditedAdjudicate(
        deps,
        envelope as IntentEnvelope,
        resumeState,
        policy,
        receipt,
      );
    },
    async adjudicatePlan(envelopes, state, policy): Promise<Decision> {
      // @adjudicate/core 1.x exposes only the single-envelope verb; serialize
      // multi-envelope plans (kill-all-or-execute-all). When 2.x ships
      // `adjudicatePlan` natively, swap this out.
      let last: Decision | undefined;
      for (const env of envelopes) {
        last = await safeAuditedAdjudicate(
          deps,
          env as IntentEnvelope,
          state,
          policy,
        );
        const d = last as { kind?: string };
        if (d.kind && d.kind !== "EXECUTE") return last;
      }
      // An empty plan means "no mutation was proposed" — there is nothing to
      // authorize. Fail CLOSED rather than fabricating an EXECUTE: an empty
      // plan must never license a side effect (an unguarded EXECUTE here would
      // hand the dispatcher a positive decision for a mutation nobody vetted).
      return (
        last ??
        decisionRefuse(
          refuse(
            "BUSINESS_RULE",
            "empty_plan",
            "Não há nenhuma ação para autorizar.",
            "adjudicatePlan called with zero envelopes",
          ),
          [],
        )
      );
    },
    // Audit read paths (loop-closure Stage 3) — delegate to the injected
    // reader (claustrum/audit-read-paths.ts). Un-wired dep → empty results,
    // never a throw: recall degradation must not crash a turn.
    async replayEnvelopesByCustomerId(customerId, since, tenantId) {
      if (!deps.auditReads) return [] as ReadonlyArray<AuditRecord>;
      return deps.auditReads.replayEnvelopesByCustomerId(
        customerId,
        since,
        tenantId,
      );
    },
    async *streamAuditByIntentHashPrefix(
      prefix,
      tenantId,
    ): AsyncIterable<AuditRecord> {
      if (!deps.auditReads) return;
      yield* deps.auditReads.streamAuditByIntentHashPrefix(prefix, tenantId);
    },
    async getOutcomes(filter) {
      if (!deps.auditReads) return [];
      return deps.auditReads.getOutcomes(filter);
    },
    verifyAuditRecord(record): AuditVerification {
      // Kernel tamper-evidence verifier (RC-K1 restored the v4 round-trip).
      // Map the kernel's {verified} union → the port's {ok} shape. A
      // missing-hash record is treated as NOT verified (fail-safe) — the
      // previous stub returned {ok:true} unconditionally, which was a bug.
      const v = kernelVerifyAuditRecord(record);
      if (v.verified === true) return { ok: true };
      return { ok: false, reason: v.reason };
    },
  };
}

// ── Fail-closed kernel call ──────────────────────────────────────────────────
//
// The kernel's `adjudicate(envelope, state, policy)` indexes into
// `policy.stateGuards`, `policy.authGuards`, `policy.business` and reads
// `policy.taint` / `policy.default`. A structurally-incomplete PolicyBundle
// (e.g. the `{}` the single-tenant TenantResolver returns today, before the
// per-capability policies are wired) makes the kernel throw a TypeError on
// `undefined.length` — and that throw propagates out of `capsule.adjudicate()`
// inside `handleTurn`, which does NOT wrap it, rejecting the whole turn.
//
// Until the real per-capability PolicyBundles are assembled (part of the
// not-yet-done cutover, see register-ibatexas-tool-packs.ts), guard the kernel
// call so an incomplete policy or an unexpected kernel throw becomes a
// fail-CLOSED REFUSE rather than a crash. This is defense-in-depth, NOT an
// activation: the planner still emits zero envelopes, so this path is not
// reached by the live cognitive loop. The point is that the day someone wires
// a planner, an un-wired policy degrades to "refuse safely", never to "throw"
// and never to "execute ungated".
function isWellFormedPolicyBundle(policy: unknown): boolean {
  if (policy === null || typeof policy !== "object") return false;
  const p = policy as Record<string, unknown>;
  return (
    Array.isArray(p.stateGuards) &&
    Array.isArray(p.authGuards) &&
    Array.isArray(p.business) &&
    typeof p.taint === "object" &&
    p.taint !== null &&
    typeof (p.taint as { minimumFor?: unknown }).minimumFor === "function" &&
    (p.default === "REFUSE" || p.default === "EXECUTE")
  );
}

function policyNotReadyRefusal(reason: string): Decision {
  return decisionRefuse(
    refuse(
      "SECURITY",
      "policy_not_ready",
      // pt-BR per ibatexas Hard Rule #4 — generic, leaks no internal detail.
      "Não consigo concluir essa ação no momento. Tente novamente em instantes.",
      reason,
    ),
    [],
  );
}

async function safeAuditedAdjudicate(
  deps: AdjudicatorBridgeDeps,
  envelope: IntentEnvelope,
  state: unknown,
  policy: unknown,
  receipt?: ConfirmationReceipt,
): Promise<Decision> {
  if (!isWellFormedPolicyBundle(policy)) {
    // Fail closed: no PolicyBundle => no authority to mutate. The kernel
    // never runs, so there is nothing to audit.
    return policyNotReadyRefusal(
      "PolicyBundle is incomplete; cutover policy wiring not yet done",
    );
  }
  try {
    // Audited path: adjudicateAndAudit emits an AuditRecord via deps.sink for
    // EVERY decision (the audit-completeness invariant). Returns the Decision;
    // the AuditRecord is the durable side effect.
    // `isWellFormedPolicyBundle` is a runtime check returning boolean (not a
    // type predicate), so `policy` is still statically `unknown` here. The kernel
    // dispatches across heterogeneous kinds, so the honest erased shape is
    // PolicyBundle<string, unknown, unknown>; `state` infers to `unknown` (= S).
    // (Was `state as never`/`policy as never` — `never` is an unsound lie that
    // would hide a real shape mismatch; the routed-but-inert path made it linger.)
    //
    // `receipt` (the resume path) maps onto the kernel's confirmationReceipt:
    // when present and the re-adjudication returns REQUEST_CONFIRMATION for the
    // matching intentHash, the kernel substitutes EXECUTE + a
    // `confirmation_resolved` supersession link. Absent → ordinary adjudication.
    // The ConfirmationReceipt shape is structurally identical to the kernel's
    // confirmationReceipt dep (intentHash/at/originalAt?/token?).
    const result = await adjudicateAndAudit(
      envelope,
      state,
      policy as PolicyBundle<string, unknown, unknown>,
      {
        sink: deps.sink,
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
        ...(receipt ? { confirmationReceipt: receipt } : {}),
      },
    );
    return result.decision;
  } catch (err) {
    // Fail CLOSED: a throw from the kernel OR a failed audit emit must never
    // license an ungated mutation. Returning REFUSE means the handler skips
    // execution — no AuditRecord persisted, no side effect. (An unauditable
    // mutation is refused, not silently executed.)
    return policyNotReadyRefusal(
      `adjudicateAndAudit threw: ${(err as Error).message}`,
    );
  }
}

// ── First-party pack installation ────────────────────────────────────────────

function installFirstPartyPacks(): SealablePackInput[] {
  const installed: SealablePackInput[] = [];
  // Each pack registers its (kind, payload, state) shape with the kernel.
  // installPack is the kernel-side variant; the runtime never reaches in to
  // mutate the registry — it's a one-time boot step.
  //
  // The five first-party packs come from the single composition site
  // (@ibatexas/packs-composed) plus the platform pix adopter pack. A pack
  // that fails to install (conformance drift, double-install) is logged and
  // skipped — the F5 seal gate catches a pinned pack that did not install.
  const packs = [...IBATEXAS_COMPOSED_PACKS, paymentsPixPack] as const;

  for (const pack of packs) {
    try {
      installPack(pack as unknown as ErasedPack);
      // Seal the SOURCE pack object (pre-installPack-wrap; withBasisAudit
      // strips guard metadata) so the F5 config seal pins the real surface.
      installed.push(pack as unknown as SealablePackInput);
    } catch (err) {
      logger.warn(
        { component: "startup", pack: pack.id, err: (err as Error).message },
        "Pack could not be installed",
      );
    }
  }
  return installed;
}

// ── F5: config integrity seal (boot gate) ───────────────────────────────────
// Pins each money-pack's introspectable config surface (intents, basis vocab,
// per-guard metadata, default verdict, per-intent taint minimum) to a sha256
// digest. SAFE BY DEFAULT: when CONFIG_SEAL_DIGESTS is unset the gate is a
// no-op — enforcement activates only when an operator mints digests
// (`ibx kernel seal`) and pins them. When pinned, a mismatch (or a pinned pack
// that did not install) fails the WHOLE boot CLOSED, before any traffic.
//
// DEPTH CAVEAT: the seal pins guard count/order/metadata/default-verdict/taint-
// minimum — NOT guard function BODIES (describePolicyBundle emits only metadata).
// It is a config-DRIFT tripwire complementary to golden vectors, not behavioral
// attestation.
function parseSealDigests(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(";")) {
    const [id, hex] = entry.split("=").map((s) => s.trim());
    if (id && hex) map.set(id, hex.toLowerCase());
  }
  return map;
}

function assertConfigSealOrThrow(
  packs: ReadonlyArray<SealablePackInput>,
): void {
  // Tests build ad-hoc packs; never seal-gate them.
  if ((process.env.NODE_ENV ?? "dev") === "test") return;
  const pinned = parseSealDigests(process.env.CONFIG_SEAL_DIGESTS);
  if (pinned.size === 0) return; // safe default — unset ⇒ no enforcement
  const byId = new Map(packs.map((p) => [p.id, p]));
  const mismatches: string[] = [];
  for (const [id, expected] of pinned) {
    const pack = byId.get(id);
    if (!pack) {
      mismatches.push(
        `pinned pack '${id}' did not install (removed/renamed?)`,
      );
      continue;
    }
    const report = verifyConfigSeal(
      pack,
      { schemaVersion: 1, digest: expected, packId: id },
      { policy: "require_digest" },
    );
    if (!report.verified) {
      mismatches.push(
        `pack '${id}' SEAL_MISMATCH: expected ${expected.slice(0, 12)}…, got ${report.computedDigest.slice(0, 12)}…`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `[config-seal] boot refused — pack config drift detected:\n  ${mismatches.join("\n  ")}`,
    );
  }
  logger.info(
    { component: "startup", sealedPacks: pinned.size },
    "[config-seal] all pinned pack config seals verified",
  );
}

// ── Audit-postgres readiness probe ───────────────────────────────────────────

async function assertAuditPostgresReady(pool: Pool): Promise<void> {
  try {
    // Probe the SAME connection the audit sink will write through. The kernel
    // emits one `intent_audit` row BEFORE every money side-effect; a missing or
    // unwritable table must fail the boot CLOSED here, not silently at the first
    // payment. The table + partitions are provisioned by the
    // @adjudicate/audit-postgres migrations — `ibx kernel migrate` (run as part
    // of `ibx bootstrap`).
    //
    // (1) Parent table exists — to_regclass returns NULL when absent.
    const reg = await pool.query("SELECT to_regclass('intent_audit') AS oid");
    if (!reg.rows[0]?.oid) {
      throw new Error("table 'intent_audit' is absent");
    }
    // (2) At least one partition exists. `intent_audit` is RANGE-partitioned by
    // recorded_at; the parent rejects any row that no partition covers, so a
    // partitionless parent would throw on the first audited decision.
    const parts = await pool.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_inherits ` +
        `WHERE inhparent = 'intent_audit'::regclass`,
    );
    if (Number(parts.rows[0]?.n ?? 0) < 1) {
      throw new Error(
        "table 'intent_audit' has no partitions — a write would be rejected",
      );
    }
    // (3) The record_version CHECK admits the version THIS build's
    // @adjudicate/core stamps (AUDIT_RECORD_VERSION). The sink writes
    // `record_version` unconditionally, so when core bumps the version (v4→v5,
    // ADR-124) without migration 010 widening the CHECK, EVERY audit insert
    // fails Postgres 23514 (check_violation) at the first decision. Catch it at
    // boot — fail CLOSED here, not at the first payment. Tracks the installed
    // core version so it never needs hand-editing on a future bump.
    const conDef = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint ` +
        `WHERE conrelid = 'intent_audit'::regclass ` +
        `AND conname = 'intent_audit_record_version_check'`,
    );
    const def = conDef.rows[0]?.def as string | undefined;
    if (!def) {
      throw new Error(
        "record_version CHECK 'intent_audit_record_version_check' is absent",
      );
    }
    const v = AUDIT_RECORD_VERSION;
    // Postgres normalizes `IN (…)` to `= ANY (ARRAY[…])`; match the integer as a
    // standalone token so v5 doesn't false-match inside e.g. "15".
    if (!new RegExp(`(^|[^0-9])${v}([^0-9]|$)`).test(def)) {
      throw new Error(
        `record_version CHECK does not admit v${v} (core stamps ${v}; constraint is "${def}"). ` +
          `Run 'ibx kernel migrate' to apply the v${v} migration before serving.`,
      );
    }
  } catch (err) {
    throw new Error(
      `[claustrum-bootstrap] @adjudicate/audit-postgres not ready: ${(err as Error).message}. ` +
        `Did you run 'ibx bootstrap' or 'ibx kernel migrate'?`,
    );
  }
}

// ── Ibatexas-specific port adapters ──────────────────────────────────────────

/**
 * pt-BR refusal explainer. Localizes a kernel/pack `Refusal` to user-facing
 * pt-BR by its stable `code`, via the `@adjudicate/locales-pt-br` registry.
 * Exported for unit testing (claustrum-explainer.test.ts).
 */
export function ibatexasExplainer(): ExplainerPort {
  // Generic, detail-free pt-BR fallbacks — used when the registry has no entry
  // for `code` (and, for SECURITY, instead of `userFacing`).
  const GENERIC_PTBR = "Desculpe, não consegui atender ao pedido.";
  const GENERIC_SECURITY_PTBR =
    "Não consigo continuar com essa solicitação. Pode tentar de outra forma?";

  return {
    render(refusal): string {
      const fromRegistry = portugueseRefusalMessages.byCode[refusal.code];

      // SECURITY refusals MUST NOT surface the operator-facing `detail`, and we
      // do NOT trust pack-supplied `userFacing` here either: render the curated
      // pt-BR registry entry if one exists, else a generic pt-BR security
      // message. This branch references neither `detail` nor `userFacing`, so
      // no sensitive text can leak through a SECURITY render by construction.
      if (refusal.kind === "SECURITY") {
        return fromRegistry ?? GENERIC_SECURITY_PTBR;
      }

      // Non-SECURITY: registry first (canonical localized text for kernel +
      // mapped codes), then the pack's embedded pt-BR `userFacing` (every
      // @ibatexas/pack-* refusal ships pt-BR userFacing at construction), then a
      // generic pt-BR fallback. Never returns empty.
      return fromRegistry ?? refusal.userFacing ?? GENERIC_PTBR;
    },
  };
}

/**
 * HandoffPort (T3-8): an ESCALATE decision routes to staff via the existing
 * `support.handoff_requested` NATS surface (subscribers/handoff-subscriber.ts →
 * WhatsApp staff notification; same event the `handoff_to_human` tool publishes).
 * The envelope's `actor.sessionId` (a customer/agent session — agent ESCALATEs
 * carry the `agent:` namespace) is the correlation + dedup key the subscriber
 * uses (`handoff:${sessionId}`), so a redelivery never double-pages.
 *
 * `queue()` MUST NOT throw: the kernel dispatcher catches a throw here as a
 * `handoff_threw` failure and surfaces an operator-facing message instead of the
 * intended ESCALATE. A failed publish therefore degrades to a logged error.
 *
 * `publish` is injected (default `publishNatsEvent`) so the port is unit-testable
 * without a broker. NOTE: JOURNEY-003 (checkout-failure-recovery) stays blocked
 * on `chat-confirmation-resume` — T3-8 closes only `handoff-port-noop`; no phase
 * closes the web confirmation-resume product gap.
 */
export function natsHandoff(
  publish: (
    event: string,
    payload: Record<string, unknown>,
  ) => Promise<void> = publishNatsEvent,
): HandoffPort {
  return {
    async queue(envelope: IntentEnvelope, reason: string): Promise<void> {
      const sessionId = envelope.actor.sessionId;
      try {
        await publish("support.handoff_requested", {
          sessionId,
          reason,
          intentKind: envelope.kind,
        });
        logger.info(
          { component: "handoff", sessionId, intentKind: envelope.kind, reason },
          "ESCALATE → handoff queued (support.handoff_requested)",
        );
      } catch (err) {
        // Swallow — queue() must not throw (see header). The subscriber's
        // idempotency guard absorbs a later redelivery if the publish recovers.
        logger.error(
          { component: "handoff", sessionId, reason, err: String(err) },
          "handoff publish failed (swallowed — queue() must not throw)",
        );
      }
    },
  };
}

// ── Production planner + policy composition (RC-A1 Phase A) ───────────────────

/**
 * The 5 first-party packs as policy-resolution inputs. Cast to the loose
 * `CapabilityPolicyPack` shape (heterogeneous K/P/S erased to string/unknown) so
 * one router can dispatch across all domains. See capability-policy.ts.
 */
// TokenUsageStore (ADR-135) — TELEMETRY ONLY, strictly outside the determinism
// boundary. Dashboard-facing per-session / per-tenant consumption + exhaustion
// events; fed from emitTurn (below). It is an INDEPENDENT read of the same usage
// the F4 guard meters off the Redis counter — there is no edge between them, so
// the kernel's decision path is untouched. Process-local + LRU-bounded (a real
// cross-instance dashboard would swap in a Redis-backed impl behind the same
// interface — a documented follow-up). Budgets seed from the same env as the guard.
const PER_TENANT_TOKEN_BUDGET = Number.parseInt(
  process.env.AGENT_TENANT_TOKEN_BUDGET ?? "0",
  10,
);
const tokenUsageStore: TokenUsageStore = createInMemoryTokenUsageStore({
  ...(Number.isFinite(SESSION_TOKEN_BUDGET)
    ? { sessionBudget: SESSION_TOKEN_BUDGET }
    : {}),
  ...(Number.isFinite(PER_TENANT_TOKEN_BUDGET) && PER_TENANT_TOKEN_BUDGET > 0
    ? { perTenantBudget: PER_TENANT_TOKEN_BUDGET }
    : {}),
});

// The adopter-level business guards (F4 token-budget + confirm-on-autoresolve)
// and the prepend composition live in `./claustrum/compose-policy-packs.ts` so
// the policy-manifest exporter describes the IDENTICAL post-prepend bundles the
// kernel runs. `buildIbatexasPolicyPacks` performs the exact per-pack prepend
// that was previously inlined here.
const IBATEXAS_POLICY_PACKS: ReadonlyArray<CapabilityPolicyPack> =
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
    IBATEXAS_ADOPTER_BUSINESS_GUARDS,
  );

/** One kind-dispatching PolicyBundle over every installed pack (built once). */
const IBATEXAS_POLICY_ROUTER = composePolicyRouter(IBATEXAS_POLICY_PACKS);

/**
 * Resolve the concrete per-kind PolicyBundle for the explicit HTTP-route path
 * (RC-A1 Phase B). Routes that build their own `principal:"user"` envelope pass
 * the result to `runCustomerIntent`. Returns null for a kind no installed pack
 * owns — the audited bridge then fails closed (REFUSE).
 */
export function policyForKind(
  kind: string,
): PolicyBundle<string, unknown, unknown> | null {
  return resolveCapabilityPolicy(IBATEXAS_POLICY_PACKS, kind);
}

// The packs' capability planners — union'd by the production planner — now
// live alongside the pack list in @ibatexas/packs-composed
// (IBATEXAS_COMPOSED_CAPABILITY_PLANNERS, imported above).

/**
 * Map the claustrum CognitiveState onto the union (state, context) the pack
 * capability planners read. Each pack reads only its own `ctx` field
 * (orders/reservations: customerId; reservations: staffId; onboarding:
 * isAuthenticated; payments/whatsapp: none), so a union ctx satisfies all.
 *
 * WS3 — thread the real actor. The Capsule carries the authoritative actor, but
 * `PlannerPort.propose` (and therefore `deriveContext`) is handed only a
 * `CognitiveState`, never the Capsule. The faithful in-CognitiveState carrier of
 * the customer identity is `state.memory.customerId`: `handleTurn` assembles
 * `cognition.memory = capsule.memory.recall(capsule.customerId, …)` and
 * `MemorySnapshot.customerId` is exactly the Capsule's customerId. We derive the
 * customer/auth context from it so that AUTHENTICATED intent kinds
 * (`order.checkout.create`, `order.cancel`, `order.amend.request`,
 * `order.note.add`, every `reservation.*`, both `customer.*`) become proposable
 * when a real customer is present — previously hardcoded `customerId:null,
 * isAuthenticated:false` exposed only the unauthenticated subset.
 *
 * Guest convention mirrors `agentCtxFromCapsule` (register-ibatexas-tool-packs):
 * an empty or `guest:`/`anon:`-prefixed customerId is NOT a real customer — it
 * yields `customerId:null, isAuthenticated:false`. The kernel's authGuards remain
 * the authoritative auth check on the envelope; this only widens what the planner
 * is *willing to propose*. `staffId` stays null: a staff actor lives on the
 * Capsule's `actor.role`, which CognitiveState does not carry, so staff-only
 * reservation kinds (`reservation.checkin`/`.complete`) remain non-proposable via
 * the chat planner (they are staff-route only) — a documented follow-up if a
 * staff chat surface is ever wired.
 */
const PLANNER_GUEST_ID_PREFIXES = ["guest:", "anon:", "anonymous:"] as const;

function plannerCustomerIdFromState(state: CognitiveState): string | null {
  const raw = (state.memory as { customerId?: unknown } | undefined)?.customerId;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (id === "") return null;
  if (PLANNER_GUEST_ID_PREFIXES.some((p) => id.startsWith(p))) return null;
  return id;
}

export function deriveIbatexasPlannerContext(state: CognitiveState): {
  readonly state: unknown;
  readonly context: unknown;
} {
  const customerId = plannerCustomerIdFromState(state);
  const isAuthenticated = customerId !== null;
  return {
    state: {
      ctx: {
        // Single-tenant supply for the pack tenant-binding authGuard
        // (AuthReviewer-009): the app names the request's tenant in state. The
        // guard REFUSEs a mismatch; env-driven (Hard Rule #3).
        tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
        channel: state.perception.channel,
        // Real actor, derived from the recalled memory snapshot (= Capsule
        // customerId). orders/reservations read `customerId`; onboarding reads
        // `isAuthenticated`.
        customerId,
        staffId: null,
        isAuthenticated,
        cartId: null,
        orderId: null,
      },
    },
    context: {},
  };
}

// The decision-aware responder lives in ./claustrum/ibatexas-responder.ts
// (createIbatexasResponder). The previous decision-blind `naiveResponder` —
// which rendered from the user's text alone and could contradict the audited
// decision — was removed in Phase A (responder-trace-admin-plan.md).

/**
 * Redis-backed SessionPort (claustrum runtime). Persists the full Session
 * (working memory, parked/deferred envelopes, goals) as a JSON blob keyed by
 * sessionId, in a namespace distinct from the conversation-history list in
 * `apps/api/src/session/store.ts`. TTLs mirror that store: 24h for an
 * authenticated customer, 48h for a guest.
 *
 * Persistence model — matches the claustrum Conductor (conductor.ts):
 *   - openCapsule → `load()`           : held as the immutable `loadedSession`.
 *   - dispatch    → `park*`/`unpark(sessionId, …)` : read-modify-write on the
 *     STORE by sessionId (NOT on the in-memory object).
 *   - closeCapsule→ `load()` + `save()`: re-reads (picking up the parks made
 *     during dispatch) and persists.
 * The Conductor holds a per-session lock for the whole turn (conductor.ts:108),
 * so the read-modify-write park ops are serialized — no WATCH/MULTI needed.
 *
 * CRITICAL: `load()` PERSISTS a freshly-created session. Otherwise a park-by-id
 * during the first turn would read an absent key and silently no-op — the bug
 * the previous stub shipped (every REQUEST_CONFIRMATION was dropped).
 */
// Mirror apps/api/src/session/store.ts (the established session-TTL convention).
const CLAUSTRUM_SESSION_TTL_GUEST_SECONDS = 48 * 60 * 60; // 48h
const CLAUSTRUM_SESSION_TTL_CUSTOMER_SECONDS = 24 * 60 * 60; // 24h

function claustrumSessionKey(sessionId: string): string {
  // Distinct namespace from `session:<id>` (the history list) — rule #7: rk().
  return rk(`claustrum:session:${sessionId}`);
}

/** Guest-marker convention shared with the planner + tool registry. */
function isGuestCustomerId(customerId: string): boolean {
  return /^(guest|anon|anonymous):/i.test(customerId);
}

// ── Per-session LLM token accounting (cost-cap seam, ADR-120 / F4) ──────────────
// Both sides are now wired:
//   WRITE — `emitTurn` (below) folds each turn's planning + synthesis token total
//     (summed onto the TurnRecord by claustrum's loop from plan.usage + draft.usage)
//     into a per-session Redis counter, keyed `${channel}:${customerId}`, stored
//     OUTSIDE the audit ledger.
//   READ  — the pre-adjudication resolve stage (claustrum/resolve-and-assemble.ts)
//     reads that counter back into `state.ctx.sessionTokensConsumed` for EVERY
//     envelope, so the `sessionTokenBudgetGuard` (prepended to every pack's
//     business phase) REFUSEs once the session crosses AGENT_SESSION_TOKEN_BUDGET.
// `sessionTokenKey` is the single source of truth, exported by resolve-and-assemble
// (the read side) and imported here (the write side) so the key can never drift.

function redisSessionStore(): SessionPort {
  async function readSession(sessionId: string): Promise<Session | null> {
    const redis = await getRedisClient();
    const raw = await redis.get(claustrumSessionKey(sessionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      // Corrupt blob → treat as absent; a fresh session is rebuilt (fail-safe).
      return null;
    }
  }

  async function writeSession(session: Session): Promise<void> {
    const redis = await getRedisClient();
    const ttl = isGuestCustomerId(session.customerId)
      ? CLAUSTRUM_SESSION_TTL_GUEST_SECONDS
      : CLAUSTRUM_SESSION_TTL_CUSTOMER_SECONDS;
    await redis.set(claustrumSessionKey(session.id), JSON.stringify(session), {
      EX: ttl,
    });
  }

  // Read-modify-write a stored session by id. No-op if the session is unknown
  // (per the SessionPort contract). Serialized by the Conductor's per-session
  // lock, so a plain RMW is race-free.
  async function mutateSession(
    sessionId: string,
    fn: (s: Session) => Session,
  ): Promise<void> {
    const existing = await readSession(sessionId);
    if (!existing) return;
    await writeSession({
      ...fn(existing),
      lastActivityAt: new Date().toISOString(),
    });
  }

  return {
    async load(customerId, channel) {
      const sessionId = `${channel}:${customerId}`;
      const existing = await readSession(sessionId);
      if (existing) return existing;
      const now = new Date().toISOString();
      const fresh: Session = {
        id: sessionId,
        customerId,
        channel,
        startedAt: now,
        lastActivityAt: now,
        pendingConfirmations: [],
        deferredEnvelopes: [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: now },
      };
      // Persist on first load so a park-by-id during this turn finds it.
      await writeSession(fresh);
      return fresh;
    },

    async save(session) {
      await writeSession(session);
    },

    // Park ops name their target session explicitly by sessionId (RC-R3): no
    // process-global "current" session, so concurrent turns can't cross-park.
    async parkPendingConfirmation(
      sessionId,
      envelope,
      confirmationToken,
      userPrompt,
    ) {
      const parkedAt = new Date().toISOString();
      await mutateSession(sessionId, (s) => ({
        ...s,
        pendingConfirmations: [
          // de-dupe by intentHash so a re-park replaces the prior entry
          ...s.pendingConfirmations.filter(
            (p) => p.envelope.intentHash !== envelope.intentHash,
          ),
          { envelope, confirmationToken, userPrompt, parkedAt },
        ],
      }));
    },

    async parkDeferred(sessionId, envelope, signal, deferUntil, timeoutMs) {
      const parkedAt = new Date().toISOString();
      await mutateSession(sessionId, (s) => ({
        ...s,
        deferredEnvelopes: [
          ...s.deferredEnvelopes.filter(
            (d) => d.envelope.intentHash !== envelope.intentHash,
          ),
          { envelope, signal, deferUntil, timeoutMs, parkedAt },
        ],
      }));
    },

    async unpark(sessionId, intentHash) {
      await mutateSession(sessionId, (s) => ({
        ...s,
        pendingConfirmations: s.pendingConfirmations.filter(
          (p) => p.envelope.intentHash !== intentHash,
        ),
        deferredEnvelopes: s.deferredEnvelopes.filter(
          (d) => d.envelope.intentHash !== intentHash,
        ),
      }));
    },
    // SessionPort.isStale() was removed upstream (claustrum APIReviewer-011,
    // commit 21c5393 — it was unused in the runtime). Do not re-add it.
  };
}

/**
 * Minimal Telemetry — emits to console (pino is wired up at the Fastify
 * layer). The full implementation will fan out to prom-client metrics
 * and the existing audit-sink subscriber.
 */
function fastifyTelemetry(
  usageStore: TokenUsageStore,
  turnTrace?: TurnTraceWriter,
  tokenUsageSink?: TokenUsageSink,
): TelemetryPort {
  // C1/C2 — per-turn LLMTrace buffer. The planner/responder emit an LLMTrace
  // per model call DURING the turn (emitLLMTrace); that trace carries turnId but
  // NOT conversationId. Buffer by turnId, then flush at emitTurn (which DOES
  // carry conversationId) into the redacted turn_trace store. LRU-capped so a
  // turn that emits traces but never reaches emitTurn (mid-turn throw) can't
  // leak unboundedly.
  const pendingTraces = new Map<string, LLMTrace[]>();
  const MAX_PENDING_TURNS = 500;
  return {
    async emitTurn(record: TurnRecord) {
      logger.info(
        {
          component: "conductor",
          event: "turn",
          correlationId: record.turnId,
          turnId: record.turnId,
          durationMs: record.durationMs,
        },
        `turn ${record.turnId} ${record.durationMs}ms`,
      );
      // Fold this turn's model token total (summed onto the TurnRecord by
      // claustrum's loop from plan.usage + draft.usage) into the per-session
      // counter the F4 budget guard reads (via resolve-and-assemble). The READ
      // side now closes the loop: the resolver injects this counter into
      // state.ctx.sessionTokensConsumed at the next turn's adjudication.
      // Best-effort: telemetry must never break a turn.
      try {
        const total = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
        if (total > 0) {
          const redis = await getRedisClient();
          const sessionKey = sessionTokenKey(record.channel, record.customerId);
          const ttl = isGuestCustomerId(record.customerId)
            ? CLAUSTRUM_SESSION_TTL_GUEST_SECONDS
            : CLAUSTRUM_SESSION_TTL_CUSTOMER_SECONDS;
          await redis
            .multi()
            .incrBy(sessionKey, total)
            .expire(sessionKey, ttl)
            .exec();
        }
      } catch (err) {
        logger.warn(
          { component: "conductor", event: "token_fold_failed", error: String(err) },
          "per-session token fold failed; ignoring",
        );
      }
      // T1a-13 — SUT-side dollar source: re-emit this turn's token usage as a
      // JSONL `llm.call` event through the shared @ibatexas/tools emitter.
      // Inert unless IBX_EVENTS=json (test profile; IBX_EVENTS_FILE adds the
      // file sink the journey harness parses). `sessionId` carries the
      // conversation handle so the harness scopes events to its run; only
      // token COUNTS are emitted — never message content or secrets.
      try {
        const total = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
        if (total > 0) {
          emitLlmCall({
            inputTokens: record.inputTokens ?? 0,
            outputTokens: record.outputTokens ?? 0,
            model: process.env.ANTHROPIC_MODEL,
            source: "sut",
            sessionId: record.conversationId,
            duration: record.durationMs,
          });
        }
      } catch (err) {
        logger.warn(
          { component: "conductor", event: "llm_call_emit_failed", error: String(err) },
          "SUT llm.call trace emit failed; ignoring",
        );
      }
      // ERDS-059 — durable token→USD persistence. Alongside the JSONL emit
      // above, persist an llm_token_usage row per turn (prompt/completion split
      // + pricing-map USD estimate) so the cost dashboards aggregate by session
      // and customer. Best-effort / FAIL-OPEN: the sink swallows its own write
      // errors, and we guard here too — cost telemetry must never break a turn.
      if (tokenUsageSink !== undefined) {
        const promptTokens = record.inputTokens ?? 0;
        const completionTokens = record.outputTokens ?? 0;
        if (promptTokens > 0 || completionTokens > 0) {
          // #94-15: off the turn's hot path (fire-and-forget) — the persist must
          // not gate turn latency. #94-1: idempotent on turnId so a retry of the
          // same turn overwrites rather than duplicates. #94-2: prefer the per-
          // turn trace model over the env value (env kept as the fallback —
          // pendingTraces is only populated when a turn-trace writer is wired;
          // `?.[0]` captures the first call's model for a multi-call turn).
          void Promise.resolve(
            tokenUsageSink.record({
              turnId: record.turnId,
              sessionId: record.conversationId,
              customerId: record.customerId,
              channel: record.channel,
              model:
                pendingTraces.get(record.turnId)?.[0]?.model ??
                process.env.ANTHROPIC_MODEL ??
                "claude-sonnet-4-6",
              promptTokens,
              completionTokens,
              recordedAt: record.at,
            }),
          ).catch((err: unknown) => {
            logger.warn(
              { component: "conductor", event: "token_usage_persist_failed", error: String(err) },
              "llm_token_usage persist failed; ignoring",
            );
          });
        }
      }
      // TokenUsageStore (ADR-135) telemetry — dashboard-facing, independent of the
      // Redis fold above (no edge to the F4 guard). Best-effort; never breaks a turn.
      try {
        const total = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
        if (total > 0) {
          usageStore.record({
            sessionId: `${record.channel}:${record.customerId}`,
            tenantId: record.tenantId ?? process.env.KERNEL_TENANT_ID ?? "ibatexas",
            total,
            at: record.at,
          });
        }
      } catch (err) {
        logger.warn(
          { component: "conductor", event: "token_usage_store_failed", error: String(err) },
          "token-usage store record failed; ignoring",
        );
      }
      // C2 — flush this turn's buffered LLM-call traces to the REDACTED
      // turn_trace store, attaching the conversationId only available here. Rows
      // are keyed (turnId, callIndex); the writer redacts the completion. The
      // trace write is additive — token accounting stays above (no double count).
      if (turnTrace !== undefined) {
        const traces = pendingTraces.get(record.turnId);
        pendingTraces.delete(record.turnId);
        if (traces !== undefined && traces.length > 0) {
          try {
            await Promise.all(
              traces.map((t, callIndex) =>
                turnTrace.write({
                  turnId: t.turnId,
                  callIndex,
                  conversationId: record.conversationId,
                  ...(t.intentHash !== undefined ? { intentHash: t.intentHash } : {}),
                  model: t.model,
                  temperature: t.temperature,
                  inputTokens: t.inputTokens,
                  outputTokens: t.outputTokens,
                  promptManifest: t.promptManifest,
                  completion: t.completion,
                  durationMs: t.durationMs,
                  recordedAt: t.at,
                  ...(t.schemaVersion !== undefined
                    ? { schemaVersion: t.schemaVersion }
                    : {}),
                }),
              ),
            );
          } catch (err) {
            logger.warn(
              { component: "conductor", event: "turn_trace_flush_failed", error: String(err) },
              "turn_trace flush failed; ignoring",
            );
          }
        }
      }
    },
    async emitLLMTrace(trace) {
      // C1 — buffer the per-model-call trace for the emitTurn flush (which
      // attaches conversationId + writes the redacted turn_trace rows). When no
      // turn_trace writer is wired, this is a no-op. Best-effort: never throws.
      if (turnTrace === undefined) return;
      try {
        const list = pendingTraces.get(trace.turnId);
        if (list !== undefined) {
          list.push(trace);
        } else {
          if (pendingTraces.size >= MAX_PENDING_TURNS) {
            const oldest = pendingTraces.keys().next().value;
            if (oldest !== undefined) pendingTraces.delete(oldest);
          }
          pendingTraces.set(trace.turnId, [trace]);
        }
      } catch {
        // ignore — telemetry must never break a turn
      }
    },
    async emitMemoryAccess(_record: MemoryAccess) {
      return;
    },
  };
}

/**
 * Single-tenant ibatexas resolver. Returns the same TenantConfig + empty
 * SystemState every call; PolicyBundle is composed from the installed
 * Packs at registration time (kernel-side state).
 */
const resolveIbatexasTenantPolicy: TenantResolver = {
  async resolve({ channel, customerId }) {
    return {
      tenant: {
        tenantId: "ibatexas",
        displayName: "IbateXas",
        locale: "pt-BR",
        environment: (process.env.NODE_ENV ?? "dev") as
          | "dev"
          | "staging"
          | "prod",
      },
      // Fallback SystemState. The conductor's resolve stage (IbatexasResolverPort)
      // assembles the real per-envelope ctx for the PLAN path; this carries
      // channel + customerId so the Adjudicator's resume path can re-assemble the
      // ctx from the (resolved) parked envelope on confirm/defer resumption.
      state: { channel, customerId },
      // Per-capability PolicyBundle resolution: one kind-dispatching router over
      // the installed packs (RC-A1 Phase A.2 — capability-policy.ts). Replaces the
      // `{}` that fail-closed every mutation. INERT until bootstrapClaustrum() runs.
      policy: IBATEXAS_POLICY_ROUTER,
    };
  },
};

// ── Boot ─────────────────────────────────────────────────────────────────────

export async function bootstrapClaustrum(
  options: ClaustrumBootstrapOptions = {},
): Promise<Conductor> {
  // Warm singleton wins — zero-arg double-init parity (index.ts boot order).
  // Options are IGNORED here by design: an in-process harness that wants a
  // differently-composed conductor MUST call resetClaustrumForTests() first.
  if (_conductor) return _conductor;

  // Model ids resolve ONCE, fail-fast, before any infra is touched. The
  // previous inline fallbacks were bogus: a dated Opus id that does not exist
  // at the Anthropic API (unset env surfaced as a 404 on the FIRST turn, not
  // at boot), and an OpenAI embedding id stamped onto grounding proofs by an
  // AnthropicProvider that cannot embed. An unset var now refuses boot,
  // naming the variable.
  const anthropicModelId = requireEnv("ANTHROPIC_MODEL");
  const embeddingModelId = requireEnv("EMBEDDING_MODEL_ID");

  const installedPacks = installFirstPartyPacks();
  // F5 — fail boot CLOSED on pack config drift (no-op unless CONFIG_SEAL_DIGESTS
  // is pinned). Runs before audit-postgres/tool-roster gates and before traffic.
  assertConfigSealOrThrow(installedPacks);

  // Live decision observability — install the structured MetricsSink so every
  // kernel decision / refusal / ledger op / audit-sink failure emits a
  // correlated log line (joined to the intent_audit row by intentHash). This is
  // an OBSERVER: the kernel's hashed/canonical path is untouched (core 456).
  //
  // WS7 coexistence: in the ibatexas app, `installKernelMetricsSink()` (run
  // inside `buildServer()` → kernel-bootstrap.ts) has ALREADY installed the
  // production MetricsSink (PostHog via NATS + Sentry breadcrumbs + Prometheus
  // counters + the audit-lag/dedup/spill recorder hooks subscribers depend on).
  // Overwriting it here would silently drop those signals. Only install the
  // observability-only sink when NO sink is present (i.e. when claustrum is
  // bootstrapped standalone, e.g. its own tests). The production sink wins.
  if (options.metricsSink) {
    // Injected sink (test seam) — installed unconditionally: a scripted
    // harness needs deterministic ownership of the metrics surface.
    setMetricsSink(options.metricsSink);
  } else if (!hasMetricsSink()) {
    setMetricsSink(createIbatexasMetricsSink(logger));
  }

  // Audit infra — dev's audit pipeline (`@ibatexas/audit-sink`) is the durable
  // AuditRecord store (`intent_audit` via Postgres, plus NATS fan-out + Redis
  // spill + PII redaction). The bridge fails CLOSED if this sink throws, so an
  // unauditable mutation is refused rather than silently executed. Create the
  // pool first so the readiness probe runs on the very connection backing the
  // Postgres writer (and the pgvector grounding provider below).
  const pgPool =
    options.pgPool ??
    new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  // Track for resetClaustrumForTests(): only a bootstrap-created pool is
  // OWNED (and therefore ended) by the reset hook; an injected pool stays
  // caller-owned.
  _pgPool = pgPool;
  _ownsPgPool = !options.pgPool;
  await assertAuditPostgresReady(pgPool);

  let modelProvider: ModelProvider;
  if (options.modelProvider) {
    // Injected provider (scripted harness, T2-6b) — the Anthropic SDK client
    // is never constructed, so a scripted composition is structurally unable
    // to spend tokens.
    modelProvider = options.modelProvider;
  } else if (process.env.LLM_PROVIDER === "ollama") {
    // Live local-model validation (plan C1): route the SUT's untrusted semantic
    // parser to a local Ollama /v1 endpoint (e.g. nemotron-3-nano:4b). The kernel
    // (@adjudicate/core) remains the sole authority — only the model swaps. Reuse
    // the contract-tested @claustrum/openai OpenAIProvider over a structural
    // fetch client (OllamaFetchClient) — its embed() throws not_implemented, so
    // the grounding capability probe / failSafeGrounding degrades to empty
    // retrieval and grounding-required intents fail CLOSED.
    modelProvider = new OpenAIProvider({ client: new OllamaFetchClient() });
    logger.warn(
      { provider: "ollama", baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL },
      "LLM_PROVIDER=ollama — using OpenAIProvider over a local Ollama endpoint for live validation",
    );
  } else {
    const anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    });
    // The structural AnthropicClientLike type in @claustrum/anthropic exposes
    // only the subset of the SDK we use; the real Anthropic class has many
    // more fields. Cast through `unknown` is intentional.
    modelProvider = new AnthropicProvider({
      client: anthropicClient as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
      // Route the provider's non-fatal warnings (max_tokens fallback) through the
      // structured logger so they reach VictoriaLogs (cycle-36 L5 sweep) instead
      // of a bare console.warn in the adapter.
      onWarn: (message, fields) => logger.warn(fields, message),
    });
  }

  // The chat model id stamped on each planner/responder CompletionRequest. The
  // OpenAIProvider forwards req.model to the endpoint, so the Ollama path MUST use
  // the local model name (was forced inside the old NemotronModelProvider); the
  // Anthropic path uses the pinned ANTHROPIC_MODEL.
  const chatModelId =
    process.env.LLM_PROVIDER === "ollama"
      ? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? "nemotron-3-nano:4b"
      : anthropicModelId;

  // Wire dev's audit-sink dependency injection (Postgres + NATS + Redis spill +
  // PII redaction) BEFORE reading the composed sink. `bootstrapAuditSinkDI`
  // resolves Redis best-effort and registers the deps on the `@ibatexas/audit-
  // sink` leaf; `getAuditSink()` then returns the fail-closed composed sink the
  // adjudicator bridge consumes. (Replaces the audit-branch's bare
  // `createPostgresSink` + hand-rolled `PostgresWriter` block — dev owns the
  // richer pipeline.) An injected sink (test seam) SKIPS the global DI wiring
  // entirely — the bridge consumes the injected sink directly and the leaf's
  // module state is left untouched.
  let auditSink: AuditSink;
  if (options.auditSink) {
    auditSink = options.auditSink;
  } else {
    await bootstrapAuditSinkDI(logger);
    auditSink = getAuditSink();
  }

  // Execution ledger (Hard Rule #9) — always-on, fail-closed cross-turn
  // replay-suppression. Redis must be up BEFORE the adjudicator exists, so the
  // client connect moves ahead of buildAdjudicator. Fail-closed is structural:
  // createRedisLedger's checkLedger/recordExecution reject when Redis is
  // unreachable, adjudicateAndAudit does not catch ledger throws, and the
  // bridge's safeAuditedAdjudicate catch degrades the throw to REFUSE — Redis
  // loss is a refusal, never a dedup bypass. Keys go through rk() (Hard Rule
  // #7); TTL stays the upstream 14-day default.
  const redis = options.redis ?? (await getRedisClient());
  // node-redis's generic reply type is `string | Buffer | null`; this client is
  // never put in buffer mode, so narrow set/get/del to the exact contract the
  // ledger consumes (RedisLedgerClient) rather than an `as unknown as` cast.
  // Rejections pass through untouched — that is the fail-closed path.
  const ledgerClient: RedisLedgerClient = {
    set: (key, value, options) =>
      redis.set(key, value, {
        ...(options?.NX ? { NX: true as const } : {}),
        ...(options?.EX !== undefined ? { EX: options.EX } : {}),
      }) as Promise<string | null>,
    get: (key) => redis.get(key) as Promise<string | null>,
    del: (key) => redis.del(key),
  };
  const ledger = createRedisLedger({ client: ledgerClient, keyFor: rk });
  // Audit READ paths over the same pool the readiness probe validated —
  // memory-recall reads (fail-safe: a read outage degrades recall to empty,
  // logged here, never a thrown turn).
  const auditReads = createAuditReadPaths({
    reader: postgresReaderFromPool(pgPool),
    onError: (err, op) =>
      logger.warn(
        { component: "claustrum-bootstrap", op, err: err.message },
        "audit read path failed (fail-safe: empty result)",
      ),
  });
  const adjudicator = buildAdjudicator({ sink: auditSink, ledger, auditReads });

  // Tool registry (RC-A1 Phase A) — register the ibatexas tool packs and assert
  // roster integrity before the conductor goes live. The registry keys tools by
  // `capability`; claustrum's dispatchDecision resolves by `envelope.kind`
  // (= `intentKind`), so every tool must have `capability === intentKind` and an
  // owning pack, else a kernel-approved EXECUTE would `tool_unresolved`. Fail
  // CLOSED at boot if drift exists — a failed boot beats a live conductor that
  // can't honor the decisions it makes. (Previously this passed an EMPTY registry,
  // so the chat path had no tools at all.)
  // P0-7: the same gate also probes the composed capability planners under the
  // named contexts (authed-customer / staff) so a planner-advertised kind with
  // no registered tool fails the boot; registered-but-unadvertised kinds are
  // WARN-only (order.review.submit — web-flow-reached, no chat advertisement).
  const toolRegistry = createToolRegistry();
  registerIbatexasToolPacks(toolRegistry);
  const rosterDrift = toolRosterDrift(
    listIbatexasToolPacks(),
    composedIntentKinds(),
    {
      planners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
      onWarn: (message) =>
        logger.warn({ component: "claustrum-bootstrap" }, message),
    },
  );
  if (rosterDrift.length > 0) {
    throw new Error(
      "[claustrum-bootstrap] tool roster integrity check failed (RC-A1 Phase A):\n  " +
        rosterDrift.join("\n  "),
    );
  }

  // The ibx prisma/redis are real clients that legitimately lack the memory
  // adapter's structural slices (the claustrum_memory_* delegates / setex+pipeline),
  // so the cast is irreducible — but name the exact contracts the adapter consumes
  // (`as unknown as <T>`) instead of `as never`, which would swallow real drift.
  //
  // Fail-safe wrapper: handleTurn awaits recall() with no catch (the
  // UNDERSTAND Promise.all), and the adapter's cold path throws today —
  // the domain PrismaClient generates NO claustrum_memory_* delegates, so
  // `prisma.claustrum_memory_episodic.findMany` is a TypeError on every
  // cache-cold turn ("Erro interno." on the chat routes; surfaced by T1a-5's
  // live contract test). Degrades to empty recall/search/recentActions and
  // dropped observes — the turn runs memory-less; mutations stay
  // kernel-guarded. See fail-safe-memory.ts + docs/agents/decisions.md D-012.
  // DEF-005: the @ibatexas/domain Prisma client generates NO claustrum_memory_*
  // delegates, so createPostgresMemoryProvider throws on every cache-cold turn.
  // Detect that capability gap UPFRONT and run a DESIGNED no-op (empty recall)
  // rather than relying on failSafeMemory to swallow a per-turn TypeError —
  // "safe by design", not "safe by catch". The wrapper stays as a last-resort
  // guard for genuinely UNEXPECTED provider errors.
  // Finding 14: probe EVERY claustrum_memory_* delegate the postgres provider
  // reads (not just episodic) — a partial/renamed delegate set would otherwise
  // pass a one-delegate probe and then throw per-turn inside the provider, the
  // very TypeError DEF-005 set out to eliminate.
  const memDelegates = ["episodic", "semantic", "procedural", "relational"] as const;
  const prismaForMemory = prisma as unknown as Record<
    string,
    { findMany?: unknown } | undefined
  >;
  const memoryDelegatesPresent = memDelegates.every(
    (slice) => typeof prismaForMemory[`claustrum_memory_${slice}`]?.findMany === "function",
  );
  if (!memoryDelegatesPresent) {
    logger.info(
      { component: "memory" },
      "claustrum_memory_* delegates absent/incomplete on the domain Prisma client — memory port runs as a designed no-op (empty recall); see DEF-005",
    );
  }
  // Finding 33: the no-op provider never throws BY DESIGN, so wrapping it in
  // failSafeMemory is dead code (a third place the empty shape would materialize).
  // Use it directly; the failSafe wrapper guards only the REAL postgres provider's
  // genuinely-unexpected errors.
  const memory = memoryDelegatesPresent
    ? failSafeMemory(
        createPostgresMemoryProvider({
          prisma: prisma as unknown as PrismaClientLike,
          redis: redis as unknown as RedisClientLike,
          adjudicator,
        }),
        {
          onError: (op, err) =>
            logger.warn(
              { component: "memory", op, error: String(err) },
              "memory port degraded (fail-safe): returning empty result",
            ),
        },
      )
    : noopMemoryProvider();

  // Fail-safe wrapper: handleTurn awaits retrieve() with no catch, and the
  // provider chain throws today (AnthropicProvider.embed() has no embedding
  // proxy configured) — without this every conversational turn rejects before
  // the planner runs. Degrades to empty retrieval; attestation failure yields
  // zero proofs (kernel refuses grounding-required envelopes — fail-closed).
  // See fail-safe-grounding.ts + docs/agents/decisions.md D-009.
  // DEF-005: the configured model provider may have no embedding capability (the
  // local 4B's embed() throws not_implemented; Anthropic has no embedding proxy
  // wired), so pgvector retrieve() would throw on every turn. Gate grounding on
  // BOTH the operator's intent flag AND a real boot-time capability probe — a
  // flag=true against a non-embedding provider must NOT re-introduce the per-turn
  // throw. When embeddings are unavailable, run a DESIGNED no-op (empty retrieval)
  // rather than letting failSafeGrounding swallow the throw each turn.
  const groundingEnabled = process.env.CLAUSTRUM_GROUNDING_ENABLED === "true";
  const canEmbed = groundingEnabled ? await providerCanEmbed(modelProvider) : false;
  const groundingActive = groundingEnabled && canEmbed;
  if (groundingEnabled && !canEmbed) {
    logger.warn(
      { component: "grounding" },
      "CLAUSTRUM_GROUNDING_ENABLED=true but the model provider cannot embed — running grounding as a designed no-op (empty retrieval); wire a working embedding proxy to enable it. See DEF-005",
    );
  } else if (!groundingEnabled) {
    logger.info(
      { component: "grounding" },
      "embeddings unavailable (CLAUSTRUM_GROUNDING_ENABLED!=true) — grounding port runs as a designed no-op (empty retrieval); see DEF-005",
    );
  }
  // Finding 33: as with memory, the grounding no-op never throws by design — use
  // it directly; failSafeGrounding wraps only the real pgvector provider.
  const grounding = groundingActive
    ? failSafeGrounding(
        createPgVectorGroundingProvider({
          // pg.Pool is structurally assignable to pgvector's minimal { query } Pool —
          // no cast needed (was a redundant `as never`).
          pool: pgPool,
          modelProvider,
          modelId: embeddingModelId,
          tenantId: "ibatexas",
        }),
        {
          modelId: embeddingModelId,
          onError: (op, err) =>
            logger.warn(
              { component: "grounding", op, error: String(err) },
              "grounding port degraded (fail-safe): returning empty result",
            ),
        },
      )
    : noopGroundingProvider(embeddingModelId);

  const channels: ChannelDriver[] = [];

  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM
  ) {
    channels.push(
      new WhatsAppChannel({
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        twilioFrom: process.env.TWILIO_FROM,
        gatewaySigningKey:
          process.env.WA_GATEWAY_SIGNING_KEY ??
          process.env.TWILIO_AUTH_TOKEN,
      }),
    );
  } else {
    logger.warn(
      { component: "startup" },
      "WhatsApp channel disabled — TWILIO_* env vars not set",
    );
  }

  // Web channel sink — for SSE, the actual delivery is via the streaming
  // emitter; the WebChannel.render just hands the response back to the
  // route handler via a sink callback set up per-request. For now, no-op.
  channels.push(
    new WebChannel({
      // Require a real signing key — no source-committed default. A known key
      // would let anyone mint web-gateway messages the conductor trusts. Fails
      // closed in prod/dev when WEB_GATEWAY_SIGNING_KEY is unset.
      gatewaySigningKey: requireSecret("WEB_GATEWAY_SIGNING_KEY"),
      sink: async () => {
        // Replaced per-request by chat.ts via attachStream() pattern (TODO).
      },
      gateway: process.env.WEB_GATEWAY_NAME ?? "ibatexas-api",
    }),
  );

  // ── Shared planner/responder factories (DRY — one change lands once) ────────
  // Both planes (the conductor here + the managed-agent plane below) build the
  // planner and the decision-aware responder identically; the ONLY divergence
  // is the ModelProvider (the conductor binds the singleton `modelProvider`;
  // the managed-agent plane passes a per-trigger capped-model factory). Factor
  // each into one closure over the shared config so a later B/C change to the
  // planner/responder lands in exactly one place — and so "wire BOTH points"
  // is a single call, not a standing duplication hazard.
  const ibxExplainer = ibatexasExplainer();
  // Phase B/C — content-addressed prompt composer + the redacted turn_trace
  // writer (the emitLLMTrace sink). ONE telemetry instance is shared across BOTH
  // planes: it buffers per-call LLMTraces by turnId and flushes them (with
  // conversationId) to turn_trace at emitTurn. turnId is globally unique, so a
  // shared buffer across the conductor + managed-agent plane is correct.
  const promptComposer = createIbatexasPromptComposer();
  const turnTraceWriter: TurnTraceWriter = createTurnTraceWriter(pgPool);
  await turnTraceWriter.ensureTable(); // best-effort (writer swallows failures)
  // ERDS-059 — durable token→USD sink (llm_token_usage). Best-effort; the sink
  // swallows write failures so cost telemetry never breaks a turn.
  const tokenUsageSink = createPostgresTokenUsageSink(prisma);
  const telemetry = fastifyTelemetry(
    tokenUsageStore,
    turnTraceWriter,
    tokenUsageSink,
  );
  const buildPlanner = (model: ModelProvider): ClaimAwarePlannerPort =>
    createIbatexasPlanner({
      model,
      modelId: chatModelId,
      capabilityPlanners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
      deriveContext: deriveIbatexasPlannerContext,
      promptComposer,
      telemetry,
    });
  const buildResponder = (model: ModelProvider): ResponderPort =>
    createIbatexasResponder({
      model,
      modelId: chatModelId,
      explainer: ibxExplainer,
      promptComposer,
      telemetry,
    });

  // B-PR1 — claims-runtime seams (SDD §M / §Q.6), FLAG DEFAULT-OFF. The planner
  // is hoisted so the claim-planner adapter reuses the SAME claim-aware instance
  // (its `proposeClaims`, Q6b). `buildClaimsSeams` returns {} when
  // ENABLE_CLAIMS_PIPELINE is OFF (the default), so the spread below is a no-op
  // and the Conductor is composed BYTE-IDENTICALLY to today (no INVESTIGATE /
  // CLAIMS-VALIDATE stage runs). ON → the shadow claims path is injected
  // (activation is a later PR). No `clock` is passed (not in the published
  // ConductorOptions; the per-turn clock is PENDING R2a).
  const planner = buildPlanner(modelProvider);
  const claimsSeams = buildClaimsSeams({ planner });
  _conductor = createConductor({
    adjudicator,
    memory,
    grounding,
    planner,
    responder: buildResponder(modelProvider),
    explainer: ibxExplainer,
    handoff: natsHandoff(),
    telemetry,
    session: redisSessionStore(),
    tools: toolRegistry,
    channels,
    tenantResolver: resolveIbatexasTenantPolicy,
    // F4 / conductor rich-state: the pre-adjudication resolve stage assembles the
    // per-pack SystemState (real entity state + sessionTokensConsumed) so the
    // kernel adjudicates commerce mutations correctly instead of panic-REFUSING
    // against the stub tenant state. See claustrum/resolve-and-assemble.ts.
    resolver: createIbatexasResolver(),
    // RC-R3 / Decision 1: without a distributed lock the conductor falls back to
    // its in-process InMemorySessionLock, so two api replicas would adjudicate
    // the same `${channel}:${customerId}` session concurrently (double-EXECUTE).
    // Postgres advisory locks pin acquire/release to one pooled connection.
    sessionLock: new PostgresAdvisorySessionLock(pgPool),
    // B-PR1 — OFF by default → {} (no-op spread, byte-identical). ON → the three
    // optional claims seams (investigator / claimPlanner / claimsKernel).
    ...claimsSeams,
  });

  // ── Managed-agent plane (T3-9) — OPT-IN via IBX_AGENTS_ENABLED ──────────────
  // Default OFF: a normal boot never subscribes the trigger bridge / boots kill
  // pollers. When enabled (the test stack), compose the Stage-0 shadow plane from
  // the SAME ports as the production conductor and start it — that boot starts
  // the Stage-0 soak clock (D-017). Wrapped fail-OPEN: a plane-start failure logs
  // and continues; it must never block the api boot / the conductor singleton.
  if (agentsEnabled()) {
    try {
      const subClient = redis.duplicate();
      await subClient.connect();
      const pubsub: RedisPubSubClient = {
        publish: (channel, message) => redis.publish(channel, message),
        subscribe: async (channel, handler) => {
          await subClient.subscribe(channel, (message: string) => handler(message));
          return async () => {
            await subClient.unsubscribe(channel);
          };
        },
      };
      // Hoist the approval engine so the staff HTTP route (WS-D1) shares its
      // parked store with the plane (single in-memory producer).
      const inMemoryApprovals = createAgentApprovalEngine({
        notify: async (req) => {
          // Stage-1 approval pending → page staff via the existing handoff surface.
          await publishNatsEvent("support.handoff_requested", {
            sessionId: req.agentNamespace,
            reason: `Aprovação de agente pendente: ${req.intentKind}`,
            intentKind: req.intentKind,
            approvalToken: req.token,
          });
        },
        now: () => new Date().toISOString(),
      });
      // H2 (ERDS-061/062): when Redis is configured, ALSO mirror the approval
      // lifecycle into @adjudicate/approval-engine's Redis registry (the shared
      // keyPrefix "adjudicate:approval" — the adjudicate console/adjutant read
      // the same `adjudicate:approval:req:*` keys). The in-memory engine stays
      // authoritative; the mirror is a best-effort, fail-OPEN operator
      // read-model. If REDIS_URL is unset (or the registry construction throws)
      // we fall back to the plain in-memory engine with no bridge — a mirror
      // must never gate the agent runtime.
      let agentApprovals: AgentApprovalEngine = inMemoryApprovals;
      if (process.env.REDIS_URL) {
        try {
          // #92-2: compute the mirror TTL ONCE and thread the SAME value into
          // both the registry (used by markResolved's default TTL) and the
          // bridge (used by put()'s per-call TTL), so pending and resolved rows
          // expire on one clock instead of the registry snapping back to 24h.
          const mirrorTtl = mirrorTtlSeconds();
          const registry = createRedisApprovalRegistry({
            redis: createApprovalRedisClient(redis),
            // Item D (producer): mirror agent approvals under the DEDICATED
            // `:agent` keyspace (`adjudicate:approval:agent:req:*`) so the
            // adjutant can tell them apart from customer-checkout approvals. The
            // consumer (adjutant) ships first and reads BOTH prefixes, so this
            // producer flip is rollout-safe.
            keyPrefix: "adjudicate:approval:agent",
            ttlSeconds: mirrorTtl,
          });
          agentApprovals = createAgentApprovalEngineBridge({
            inner: inMemoryApprovals,
            registry,
            ttlSeconds: mirrorTtl,
            onMirrorError: (stage, err) => {
              logger.warn(
                {
                  component: "agent-approval-mirror",
                  stage,
                  err: (err as Error).message,
                },
                "agent-approval Redis mirror failed (swallowed — fail-open)",
              );
            },
          });
        } catch (err) {
          logger.warn(
            { component: "agent-approval-mirror", err: (err as Error).message },
            "agent-approval Redis registry construction failed — using in-memory engine only (fail-open)",
          );
        }
      }
      _agentApprovals = agentApprovals;
      // Live conductor ingredients — H1 recomposes per trigger over a capped
      // model, so the planner/responder are passed as factories (over the
      // capped model) rather than pre-built ports. Tools are the REAL registry.
      const liveConductor: LiveAgentConductorDeps = {
        adjudicator,
        memory,
        grounding,
        explainer: ibxExplainer,
        handoff: natsHandoff(),
        // Share the SAME telemetry instance as the conductor — the turn_trace
        // buffer keys on the (globally-unique) turnId, so agent-plane model
        // calls flush to turn_trace at their emitTurn too.
        telemetry,
        session: redisSessionStore(),
        tenantResolver: resolveIbatexasTenantPolicy,
        sessionLock: new PostgresAdvisorySessionLock(pgPool),
        resolver: createIbatexasResolver(),
        tools: toolRegistry,
        systemChannel: new SystemChannel({
          // For a boot that can issue refunds, keep requireSecret with NO
          // devDefault — a known signing key would let anyone mint system-gateway
          // messages the agent conductor trusts (ties to B3).
          gatewaySigningKey: requireSecret("SYSTEM_GATEWAY_SIGNING_KEY"),
          gateway: process.env.SYSTEM_GATEWAY_NAME ?? "ibatexas-agent-host",
        }),
        modelProvider,
        // Same DRY factories the conductor uses — the per-trigger capped model is
        // passed in by the live runner (H1). Wiring BOTH points is now one call.
        buildPlanner,
        buildResponder,
      };
      // P4 producer seam: ensure the shared remediation_proposals table exists,
      // then write a proposal whenever the live runner parks a confirm-gated
      // remediation (the adjutant projects from it + agent_runs).
      const proposalWriter = createRemediationProposalWriter(pgPool);
      await proposalWriter.ensureTable();
      _proposalWriter = proposalWriter;
      _agentPlane = await startManagedAgentPlane({
        registry: AGENT_REGISTRY,
        liveConductor,
        journal: createPostgresAgentRunJournal(prisma),
        proposalSink: (p) => proposalWriter.write(p),
        // ERDS-060: each completed trigger turn emits a best-effort
        // learning.event.v1 (fail-open; the leaf no-ops if Redis+NATS are absent).
        learningSink: getLearningSink(),
        redis: ledgerClient,
        pubsub,
        approvals: agentApprovals,
        // Proactive per-agent/per-window refund money breaker (bounds the FIRST
        // N money attempts; the kill switch only bounds the tail).
        refundBreaker: createRefundCircuitBreaker({ redis }),
        // The kinds the composed kernel policy confirm-gates via the B1
        // agent-session refund rule. Must cover every REAL_MONEY_KINDS entry or
        // startManagedAgentPlane refuses to boot (fail-closed).
        realMoneyConfirmKinds: AGENT_CONFIRM_GATED_KINDS,
        resolveCustomer: async (orderId) => {
          const order = await createOrderQueryService().getById(orderId);
          return order?.customerId ?? null;
        },
        now: () => new Date().toISOString(),
      });
    } catch (err) {
      logger.error(
        { component: "managed-agent-plane", err: (err as Error).message },
        "managed-agent plane failed to start — continuing without it (boot not blocked)",
      );
    }
  }

  return _conductor;
}

// Re-export types frequently used by routes.
export type { Capsule, Conductor };
