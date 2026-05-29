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
//   - Adjudicator            adjudicateBridge() wrapping @adjudicate/core
//   - PlannerPort            createIbatexasPlanner() (LLM intent extractor over
//                            the 5 packs' CapabilityPlanners — RC-A1 Phase A.1)
//   - ResponderPort          anthropicResponder() (uses ModelProvider)
//   - ExplainerPort          ibatexasExplainer() (pt-BR templates)
//   - HandoffPort            noopHandoff() (TODO: wire Slack/PagerDuty)
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
  type Conductor,
  type ExplainerPort,
  type HandoffPort,
  type CognitiveState,
  type MemoryAccess,
  type ResponderPort,
  type Session,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
  type TurnRecord,
} from "@claustrum/core";
import { AnthropicProvider } from "@claustrum/anthropic";
import { createPostgresMemoryProvider } from "@claustrum/memory-postgres";
import { createPgVectorGroundingProvider } from "@claustrum/grounding-pgvector";
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
  adjudicateAndAudit,
  decisionRefuse,
  installPack,
  refuse,
  verifyAuditRecord as kernelVerifyAuditRecord,
} from "@adjudicate/core";
import {
  auditInsertParams,
  createPostgresSink,
  INSERT_AUDIT_SQL,
  type IntentAuditRow,
  type PostgresWriter,
} from "@adjudicate/audit-postgres";

// Pack imports — at the time of this commit, ibatexas's first-party Packs
// are in packages/pack-*/ but those packages have no published package.json
// at the root yet (only `dist/`). We import their compiled .d.ts barrel via
// relative path; pnpm install will resolve these via the workspace symlinks
// if/when they grow proper package.json files. If a pack isn't yet available,
// the bootstrap logs a warning and skips it (graceful degradation).
//
// TODO(post-cutover): swap these to canonical `@ibatexas/pack-*` imports
// once each pack's package.json is restored.
import { prisma } from "@ibatexas/domain";
import { getRedisClient } from "@ibatexas/tools";

// ── RC-A1 cutover composition (Phase A.1/A.2) ────────────────────────────────
// The production planner + per-kind PolicyBundle router, composed over the 5
// first-party packs. INERT until bootstrapClaustrum() is called.
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import type { PolicyBundle } from "@adjudicate/core/kernel";
import { ordersPack, ordersCapabilityPlanner } from "@ibatexas/pack-orders";
import { paymentsPack, paymentsCapabilityPlanner } from "@ibatexas/pack-payments";
import {
  reservationsPack,
  reservationsCapabilityPlanner,
} from "@ibatexas/pack-reservations";
import {
  customerOnboardingPack,
  customerOnboardingCapabilityPlanner,
} from "@ibatexas/pack-customer-onboarding";
import { whatsappPack, whatsappCapabilityPlanner } from "@ibatexas/pack-whatsapp";
import { requireSecret } from "./utils/require-secret.js";
import {
  composePolicyRouter,
  resolveCapabilityPolicy,
  type CapabilityPolicyPack,
} from "./claustrum/capability-policy.js";
import { createIbatexasPlanner } from "./claustrum/ibatexas-planner.js";

// ── Singleton ────────────────────────────────────────────────────────────────

let _conductor: Conductor | null = null;

export function getConductor(): Conductor {
  if (!_conductor) {
    throw new Error(
      "Claustrum Conductor not initialized. Call bootstrapClaustrum() in server.ts before serving requests.",
    );
  }
  return _conductor;
}

/**
 * Non-throwing conductor accessor for the lazy-conductor route pattern (RC-A1
 * Phase B). Returns `null` when the conductor is not yet bootstrapped (the
 * inert, pre-activation state) so a route can fall back to its legacy direct
 * path. Post-activation (`bootstrapClaustrum()` called) it returns the live
 * conductor and the route adjudicates the mutation through the kernel. The
 * legacy fallback is removed in the same commit as the activation flip.
 */
export function tryGetConductor(): Conductor | null {
  return _conductor;
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
    async replayEnvelopesByCustomerId(_customerId, _since) {
      // TODO(loop-closure): wire to `createPostgresAuditStore` reader once the
      // conductor's memory-recall path is exercised (Stage 3). The write-audit
      // invariant (above) does not depend on this read path.
      return [] as ReadonlyArray<AuditRecord>;
    },
    async *streamAuditByIntentHashPrefix(_prefix): AsyncIterable<AuditRecord> {
      // TODO(loop-closure): wire through @adjudicate/audit-postgres reader.
    },
    async getOutcomes(_filter) {
      // TODO(loop-closure): wire through @adjudicate/audit-postgres outcomes-store.
      return [];
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
    const result = await adjudicateAndAudit(
      envelope,
      state as never,
      policy as never,
      {
        sink: deps.sink,
        ...(deps.ledger ? { ledger: deps.ledger } : {}),
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

function installFirstPartyPacks(): void {
  // Each pack registers its (kind, payload, state) shape with the kernel.
  // installPack is the kernel-side variant; the runtime never reaches in to
  // mutate the registry — it's a one-time boot step.
  //
  // The dynamic require pattern lets us skip a missing pack gracefully (its
  // package.json may not yet be wired to the workspace). When restored,
  // each pack call becomes a plain top-level import.
  const packs = [
    "@ibatexas/pack-orders",
    "@ibatexas/pack-payments",
    "@ibatexas/pack-reservations",
    "@ibatexas/pack-customer-onboarding",
    "@ibatexas/pack-whatsapp",
    "@adjudicate/pack-payments-pix",
  ];

  for (const packName of packs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pack = require(packName);
      const value =
        pack[`${pluralCamel(stripScope(packName))}Pack`] ??
        pack[`${stripScope(packName).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Pack`] ??
        pack.pack ??
        pack.default;
      if (value && typeof installPack === "function") {
        installPack(value);
      }
    } catch (err) {
      console.warn(
        `[claustrum-bootstrap] Pack '${packName}' could not be installed (likely not yet workspace-published):`,
        (err as Error).message,
      );
    }
  }
}

function stripScope(name: string): string {
  return name.replace(/^@[^/]+\//, "").replace(/^pack-/, "");
}

function pluralCamel(name: string): string {
  // "orders" -> "orders"; "customer-onboarding" -> "customerOnboarding"
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ── Audit-postgres readiness probe ───────────────────────────────────────────

async function assertAuditPostgresReady(): Promise<void> {
  try {
    // The audit-postgres package owns its own pool; a `SELECT 1` via the
    // verify-API exercises the connection without coupling to internals.
    // If the package exposes a probe, prefer that.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ap = require("@adjudicate/audit-postgres");
    if (typeof ap.assertReady === "function") {
      await ap.assertReady();
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
 * Minimal pt-BR explainer. Production-grade implementation lives in a
 * dedicated module under `apps/api/src/explainer/` (TODO).
 */
function ibatexasExplainer(): ExplainerPort {
  return {
    render(refusal): string {
      // SECURITY refusals MUST NOT leak `detail` to the user. We fall back to
      // a generic message; the operator-facing `detail` is logged via
      // telemetry, not surfaced here.
      if (refusal.kind === "SECURITY") {
        return (
          refusal.userFacing ??
          "Não consigo continuar com essa solicitação. Pode tentar de outra forma?"
        );
      }
      return refusal.userFacing ?? "Desculpe, não consegui atender ao pedido.";
    },
  };
}

function noopHandoff(): HandoffPort {
  return {
    async queue(envelope: IntentEnvelope, reason: string): Promise<void> {
      // TODO: wire Slack/PagerDuty. For now, fail-loud in logs only.
      console.warn(
        `[handoff.noop] envelope intentHash=${(envelope as { intentHash?: string }).intentHash ?? "?"} reason=${reason}`,
      );
    },
  };
}

// ── Production planner + policy composition (RC-A1 Phase A) ───────────────────

/**
 * The 5 first-party packs as policy-resolution inputs. Cast to the loose
 * `CapabilityPolicyPack` shape (heterogeneous K/P/S erased to string/unknown) so
 * one router can dispatch across all domains. See capability-policy.ts.
 */
const IBATEXAS_POLICY_PACKS: ReadonlyArray<CapabilityPolicyPack> = [
  ordersPack,
  paymentsPack,
  reservationsPack,
  customerOnboardingPack,
  whatsappPack,
].map((p) => ({
  id: p.id,
  intents: [...p.intents],
  policy: p.policy as unknown as PolicyBundle<string, unknown, unknown>,
}));

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

/** The packs' capability planners — union'd by the production planner. */
const IBATEXAS_CAPABILITY_PLANNERS = [
  ordersCapabilityPlanner,
  paymentsCapabilityPlanner,
  reservationsCapabilityPlanner,
  customerOnboardingCapabilityPlanner,
  whatsappCapabilityPlanner,
] as unknown as ReadonlyArray<CapabilityPlanner<unknown, unknown>>;

/**
 * Map the claustrum CognitiveState onto the union (state, context) the pack
 * capability planners read. Each pack reads only its own `ctx` field
 * (orders/reservations: customerId; reservations: staffId; onboarding:
 * isAuthenticated; payments/whatsapp: none), so a union ctx satisfies all.
 *
 * CONSERVATIVE: CognitiveState carries no actor/customerId, so we derive an
 * UNAUTHENTICATED context — the capability planners then expose only the
 * unauthenticated intent subset, and the kernel's authGuards enforce the
 * authoritative auth check on the envelope. Production wiring of the real actor
 * (a claustrum CognitiveState that carries customerId, or a capsule-aware
 * planner) is a documented follow-up.
 */
function deriveIbatexasPlannerContext(state: CognitiveState): {
  readonly state: unknown;
  readonly context: unknown;
} {
  return {
    state: {
      ctx: {
        channel: state.perception.channel,
        customerId: null,
        staffId: null,
        isAuthenticated: false,
        cartId: null,
        orderId: null,
      },
    },
    context: {},
  };
}

/**
 * Minimal responder — direct Anthropic completion. The full ibatexas
 * responder uses the prompt synthesizer in `@ibatexas/llm-provider`;
 * that integration is incremental work.
 */
function naiveResponder(model: AnthropicProvider): ResponderPort {
  return {
    async respond(input) {
      const completion = await model.complete({
        model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5-20250101",
        maxTokens: 1024,
        system:
          "Você é o atendente da IbateXas. Responda em pt-BR de forma curta e clara.",
        messages: [
          { role: "user", content: input.cognition.perception.text },
        ],
      });
      return { text: completion.text };
    },
  };
}

/**
 * Redis-backed SessionPort. Mirrors the existing
 * `apps/api/src/session/store.ts` semantics (key format, TTLs, ownership
 * checks). Full migration into claustrum's port shape — including parked-
 * envelope semantics — is the next iteration.
 */
function redisSessionStore(): SessionPort {
  let current: Session | null = null;
  return {
    async load(customerId, channel) {
      const now = new Date().toISOString();
      const sessionId = `${channel}:${customerId}`;
      current = {
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
      return current;
    },
    async save(_session) {
      // TODO: persist to Redis using rk() keys
      return;
    },
    // SessionPort.current() was removed (RC-R3 SessionHandle residual): park ops
    // now name their target session explicitly by sessionId rather than acting on
    // a process-global "last loaded" session.
    async parkPendingConfirmation(_sessionId, _envelope, _token, _prompt) {
      // TODO
      return;
    },
    async parkDeferred(_sessionId, _envelope, _signal, _until, _timeoutMs) {
      // TODO
      return;
    },
    async unpark(_sessionId, _intentHash) {
      // TODO
      return;
    },
    isStale(): boolean {
      return false;
    },
  };
}

/**
 * Minimal Telemetry — emits to console (pino is wired up at the Fastify
 * layer). The full implementation will fan out to prom-client metrics
 * and the existing audit-sink subscriber.
 */
function fastifyTelemetry(): TelemetryPort {
  return {
    async emitTurn(record: TurnRecord) {
      console.log(`[telemetry.turn] ${record.turnId} ${record.durationMs}ms`);
    },
    async emitLLMTrace(_trace) {
      // TODO: persist to dedicated LLM-trace store (NOT the audit ledger).
      return;
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
  async resolve({ channel }) {
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
      // Real SystemState is assembled by the planner + kernel from the
      // per-request Capsule (cart, customer, etc.). Static empty for now.
      state: { channel },
      // Per-capability PolicyBundle resolution: one kind-dispatching router over
      // the installed packs (RC-A1 Phase A.2 — capability-policy.ts). Replaces the
      // `{}` that fail-closed every mutation. INERT until bootstrapClaustrum() runs.
      policy: IBATEXAS_POLICY_ROUTER,
    };
  },
};

// ── Boot ─────────────────────────────────────────────────────────────────────

export async function bootstrapClaustrum(): Promise<Conductor> {
  if (_conductor) return _conductor;

  installFirstPartyPacks();
  await assertAuditPostgresReady();

  const anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  });
  // The structural AnthropicClientLike type in @claustrum/anthropic exposes
  // only the subset of the SDK we use; the real Anthropic class has many
  // more fields. Cast through `unknown` is intentional.
  const modelProvider = new AnthropicProvider({
    client: anthropicClient as unknown as ConstructorParameters<
      typeof AnthropicProvider
    >[0]["client"],
  });

  // Audit infra — the Postgres sink is the durable AuditRecord store
  // (`intent_audit`). The bridge fails CLOSED if this sink throws, so an
  // unauditable mutation is refused rather than silently executed.
  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const auditWriter: PostgresWriter = {
    async insertAudit(row: IntentAuditRow): Promise<void> {
      await pgPool.query(INSERT_AUDIT_SQL, auditInsertParams(row) as unknown[]);
    },
  };
  const auditSink = createPostgresSink({
    writer: auditWriter,
    onError: (err) =>
      console.error(
        "[claustrum-bootstrap] audit sink emit failed:",
        err.message,
      ),
  });
  // TODO(Stage 3): wire createRedisLedger({ client: redis, keyFor: rk }) for
  // cross-turn replay-suppression once EXECUTE fires. The bridge already
  // accepts an optional `ledger` dep (AdjudicatorBridgeDeps); domain-level
  // idempotency (cycle-2 PAY-3) guards payment double-fire meanwhile.
  const adjudicator = buildAdjudicator({ sink: auditSink });
  const redis = await getRedisClient();

  const memory = createPostgresMemoryProvider({
    prisma: prisma as never,
    redis: redis as never,
    adjudicator,
  });

  const grounding = createPgVectorGroundingProvider({
    pool: pgPool as never,
    modelProvider,
    modelId: process.env.EMBEDDING_MODEL_ID ?? "text-embedding-3-small",
    tenantId: "ibatexas",
  });

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
    console.warn(
      "[claustrum-bootstrap] WhatsApp channel disabled — TWILIO_* env vars not set",
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

  _conductor = createConductor({
    adjudicator,
    memory,
    grounding,
    planner: createIbatexasPlanner({
      model: modelProvider,
      modelId: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-5-20250101",
      capabilityPlanners: IBATEXAS_CAPABILITY_PLANNERS,
      deriveContext: deriveIbatexasPlannerContext,
    }),
    responder: naiveResponder(modelProvider),
    explainer: ibatexasExplainer(),
    handoff: noopHandoff(),
    telemetry: fastifyTelemetry(),
    session: redisSessionStore(),
    tools: createToolRegistry(),
    channels,
    tenantResolver: resolveIbatexasTenantPolicy,
  });

  return _conductor;
}

// Re-export types frequently used by routes.
export type { Capsule, Conductor };
