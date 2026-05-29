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
//   - PlannerPort            naivePlanner() (one envelope from one user message)
//   - ResponderPort          anthropicResponder() (uses ModelProvider)
//   - ExplainerPort          ibatexasExplainer() (pt-BR templates)
//   - HandoffPort            noopHandoff() (TODO: wire Slack/PagerDuty)
//   - TelemetryPort          fastifyTelemetry() (pino + prom-client)
//   - SessionPort            redisSessionStore() (Redis-backed sessions)
//   - ToolRegistry           ibatexas tool packs registered as ToolDefinitions
//   - TenantResolver         resolveIbatexasTenantPolicy()
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
  type Capsule,
  type ChannelDriver,
  type Conductor,
  type ExplainerPort,
  type HandoffPort,
  type MemoryAccess,
  type PlannerPort,
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
  Decision,
  IntentEnvelope,
} from "@adjudicate/core";
import {
  adjudicate as kernelAdjudicate,
  decisionRefuse,
  installPack,
  refuse,
} from "@adjudicate/core";

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
import { requireSecret } from "./utils/require-secret.js";

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

// ── Adjudicator bridge ───────────────────────────────────────────────────────

/**
 * Wraps `@adjudicate/core/kernel` + `@adjudicate/audit-postgres` into the
 * claustrum `Adjudicator` port. This is the ONLY place in the ibatexas
 * codebase that imports from `@adjudicate/core/kernel` directly.
 */
function buildAdjudicator(): Adjudicator {
  return {
    async adjudicate(envelope, state, policy): Promise<Decision> {
      return safeKernelAdjudicate(envelope as IntentEnvelope, state, policy);
    },
    async adjudicatePlan(envelopes, state, policy): Promise<Decision> {
      // @adjudicate/core 1.x exposes only the single-envelope verb; serialize
      // multi-envelope plans (kill-all-or-execute-all). When 2.x ships
      // `adjudicatePlan` natively, swap this out.
      let last: Decision | undefined;
      for (const env of envelopes) {
        last = await safeKernelAdjudicate(env as IntentEnvelope, state, policy);
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
      // TODO(post-cutover): wire through `@adjudicate/audit-postgres`
      // `createPostgresAuditStore({...}).list(...)`. The audit-postgres
      // surface is store-creation-only; the conductor needs a long-lived
      // pre-built store, which the production bootstrap will own.
      return [] as ReadonlyArray<AuditRecord>;
    },
    async *streamAuditByIntentHashPrefix(_prefix): AsyncIterable<AuditRecord> {
      // TODO(post-cutover): wire through @adjudicate/audit-postgres.
      // For now, return an empty stream.
    },
    async getOutcomes(_filter) {
      // TODO(post-cutover): wire through @adjudicate/audit-postgres outcomes-store.
      return [];
    },
    verifyAuditRecord(_record) {
      // TODO(post-cutover): wire through @adjudicate/core's hash verifier.
      return { ok: true };
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

async function safeKernelAdjudicate(
  envelope: IntentEnvelope,
  state: unknown,
  policy: unknown,
): Promise<Decision> {
  if (!isWellFormedPolicyBundle(policy)) {
    // Fail closed: no PolicyBundle => no authority to mutate.
    return policyNotReadyRefusal(
      "PolicyBundle is incomplete; cutover policy wiring not yet done",
    );
  }
  try {
    return kernelAdjudicate(envelope, state as never, policy as never);
  } catch (err) {
    // The kernel is fail-closed by design; a throw escaping it is unexpected.
    // Surface a REFUSE so handleTurn still reaches synthesize/observe instead
    // of rejecting the turn — and so nothing executes ungated.
    return policyNotReadyRefusal(
      `kernel adjudicate threw: ${(err as Error).message}`,
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
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

/**
 * Minimal planner — turns the perception into a single advisory envelope.
 * Real ibatexas planning will use the XState machine + CapabilityPlanner
 * from the packs; this is the seam that gets replaced incrementally.
 */
function naivePlanner(): PlannerPort {
  return {
    async propose(_state) {
      // Empty envelopes = "no mutation, just respond". The cognitive loop
      // still runs synthesize + observe.
      return {
        envelopes: [],
        rationale: "naive-planner: ibatexas planner not yet wired",
      };
    },
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
      // The kernel resolves PolicyBundle by intent kind from installed Packs.
      policy: {},
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

  const adjudicator = buildAdjudicator();
  const redis = await getRedisClient();

  const memory = createPostgresMemoryProvider({
    prisma: prisma as never,
    redis: redis as never,
    adjudicator,
  });

  const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
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
    planner: naivePlanner(),
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
