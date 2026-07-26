// customer-e2e-harness — the FIRST customer-plane turn-seam harness that drives a
// REAL `handleTurn` all the way into a REAL tool executor from
// `register-ibatexas-tool-packs.ts`. Structural sibling of
// `apps/api/src/ops/__tests__/ops-e2e-harness.ts` (ops plane) — deliberately NOT
// importing from it, so neither plane's harness can break the other.
//
// WHY IT EXISTS (BKL-230). Before this file, no customer-plane test in the repo
// reached a real executor through a real turn: the ops harness is ops-only, the
// Docker-gated `scripted-pipeline` suite has no Medusa to serve a checkout's cart
// reads (and none of its goldens reach EXECUTE), and every chat route test mocks
// `handleTurn` outright. That is the same blind spot that let LE2-002 ship a
// structurally-dead feature with green "turn-seam" tests, and BKL-230's chat PIX
// payer-identity gap is exactly the class of defect that dies invisibly without
// it: the executor's third argument was simply never passed.
//
// WHAT IS REAL HERE (the point of the harness):
//   - `handleTurn` + `createConductor` from @claustrum/core
//   - the production planner `createIbatexasPlanner` over the REAL composed
//     capability planners (so `order.checkout.create` proposability is genuinely
//     gated on an authenticated customer)
//   - the production RESOLVE stage `createIbatexasResolver` → `resolveAndAssemble`
//     (so the snake_case wire keys `payment_method`/`delivery_type` are renamed
//     and `cartId` is hydrated from the session's active-cart Redis key exactly
//     as production does)
//   - the REAL composed policy router + REAL audited kernel (`adjudicateAndAudit`),
//     so the money-band confirm gate and every checkout guard actually fire
//   - the REAL tool registry (`registerIbatexasToolPacks`) resolved by
//     `resolveTool(envelope.kind)` — the true dispatch path
//   - the REAL `WebConfirmChannel.matchToParked`, so a "sim" resumes a park
//
// WHAT IS FAKED, and where the boundary sits: ONLY the model and the outermost
// I/O clients. Stripe (`vi.mock("stripe")`) and Medusa (`vi.stubGlobal("fetch")`)
// and Redis (`vi.mock("redis")`) are mocked at the CLIENT boundary — below the
// executor, never above it. Those three `vi.mock` calls must live in the TEST
// file (vitest hoists them per module graph); this harness only supplies the
// fakes to install. Bare-specifier mocks are what make this work at all: from
// apps/api, `@ibatexas/tools` resolves to its built `dist`, so mocking that
// package cannot intercept a tool's INTERNAL relative imports — but `stripe`,
// `redis`, and global `fetch` are shared across the whole graph and do reach
// inside.
//
// Responder/explainer/memory/grounding/telemetry are inert stubs: per the
// governing ruling this harness asserts on `decision` / `acted` / park state, not
// on rendered text (render precedence is another worker's surface), and the
// claims seams are deliberately omitted so a render degrade cannot interfere.
//
// SCOPE: checkout-turn needs ONLY. No speculative ports, no fixtures for other
// intent kinds. Expected to grow as later tickets extend the customer funnel.

import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { adjudicateAndAudit } from "@adjudicate/core/kernel";
import {
  buildEnvelope,
  type AuditRecord,
  type AuditSink,
  type Decision,
  type IntentEnvelope,
} from "@adjudicate/core";
import {
  createConductor,
  createToolRegistry,
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
  type CognitiveState,
  type Completion,
  type CompletionRequest,
  type Conductor,
  type ConfirmationReceipt,
  type GroundingPort,
  type MemoryPort,
  type ModelProvider,
  type ParkedEnvelope,
  type ResponderPort,
  type Session,
  type SessionLock,
  type SessionPort,
  type TelemetryPort,
  type TenantResolver,
} from "@claustrum/core";
import {
  IBATEXAS_COMPOSED_PACKS,
  IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
} from "@ibatexas/packs-composed";
import { buildIbatexasPolicyPacks, type ErasedPack } from "../claustrum/compose-policy-packs.js";
import { composePolicyRouter } from "../claustrum/capability-policy.js";
import { createIbatexasPlanner } from "../claustrum/ibatexas-planner.js";
import { buildClaimsSeams } from "../claustrum/claims-pipeline.js";
import { createIbatexasResolver } from "../claustrum/ibatexas-resolver.js";
import { WebConfirmChannel } from "../claustrum/web-confirm-channel.js";
import { buildLanguageEngineAuditMetadata } from "../claustrum/language-engine/audit-metadata.js";
import { registerIbatexasToolPacks } from "../tools/register-ibatexas-tool-packs.js";
import { isGuestCustomerId } from "../tools/guest-identity.js";

/** Fixed instant every park is stamped with, so park shapes are deterministic. */
export const HARNESS_NOW = "2026-07-25T12:00:00.000Z";

/** The EXACT composed router the conductor's SUBMIT stage adjudicates against. */
export const CUSTOMER_ROUTER = composePolicyRouter(
  buildIbatexasPolicyPacks(
    IBATEXAS_COMPOSED_PACKS as unknown as ReadonlyArray<ErasedPack>,
  ) as never,
);

// ── Model ─────────────────────────────────────────────────────────────────────

/** A scripted planner tool call (`express_intent`). */
export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * A scripted planner/responder model, once-latched. On a planner call (tools
 * present) it fires the scripted tool call(s) ONCE, then behaves as a plain
 * responder. The latch is what lets a follow-up "sim" read as a REPLY to the
 * park rather than a fresh command — the shape a confirm-resume turn needs.
 * Mirrors the ops harness's `scriptedModel` idiom.
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
      // A planner pass that emits no tool call still says something (live-verified
      // against the local 4B); empty text is realistic ONLY alongside a tool call.
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

// ── Client-boundary fakes (installed by the TEST file's vi.mock calls) ─────────

// REDIS is deliberately NOT faked here. `vi.mock("redis")`'s factory is hoisted
// above every import, so it can only reference `vi.hoisted` state declared in the
// TEST file itself — a fake exported from this module would be initialized too late
// to be usable. See chat-pix-checkout.e2e.test.ts for the map-backed double, and
// note WHY the `redis` PACKAGE is the seam rather than `@ibatexas/tools`: it is the
// only one reaching BOTH apps/api's own Redis use (resolve-and-assemble's
// active-cart read) AND the tools-dist internals (create-checkout), which a
// package-level mock cannot cross.

/** A Medusa cart as the store API returns it. `total`/`unit_price` are in REAIS —
 *  `reaisToCentavos` (x100) converts, so `total: 1500` is R$1.500,00 = 150000
 *  centavos, which clears the >=R$1.000 `confirmLargeTicket` band and stays under
 *  the R$10.000 `refuseAmountAboveCap` cap. */
export interface MedusaCartFixture {
  readonly id: string;
  readonly total: number;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly variant_id: string;
    readonly title: string;
    readonly quantity: number;
    readonly unit_price: number;
  }>;
  readonly payment_collection?: { id: string };
  readonly completed_at?: string | null;
  readonly region_id?: string;
}

export function makeCartFixture(
  overrides: Partial<MedusaCartFixture> = {},
): MedusaCartFixture {
  return {
    id: "cart_bkl230",
    total: 1500,
    items: [
      {
        id: "item_01",
        variant_id: "variant_costela_500g",
        title: "Costela Bovina Defumada 500g",
        quantity: 2,
        unit_price: 750,
      },
    ],
    region_id: "reg_br",
    completed_at: null,
    ...overrides,
  };
}

/** A syntactically-real JWT whose `exp` claim is far in the future — `getAdminToken`
 *  base64url-decodes segment 2 to read `exp`, so an opaque token would throw. */
function fakeAdminJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp })}.sig`;
}

/** Records every Medusa request the turn made, for assertions. */
export interface MedusaFetchFake {
  readonly calls: Array<{ method: string; path: string; body?: unknown }>;
  fetch: (input: unknown, init?: { method?: string; body?: unknown }) => Promise<unknown>;
}

/**
 * A path-routed `fetch` double covering every Medusa egress a PIX checkout makes:
 * the publishable-key bootstrap, the two cart GETs (total check + payment
 * collection), the payment-provider lookup, and the payment-collection /
 * payment-session POSTs. Anything unrouted throws LOUDLY rather than returning a
 * benign empty object — an unexpected egress must fail the test, not silently
 * degrade into the swallowed-error path that hid this bug class before.
 */
export function makeMedusaFetchFake(cart: MedusaCartFixture): MedusaFetchFake {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];

  const json = (payload: unknown): unknown => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });

  const cartBody = {
    cart: {
      ...cart,
      items: [...cart.items],
      ...(cart.payment_collection ? { payment_collection: cart.payment_collection } : {}),
    },
  };

  const fetchFake = async (
    input: unknown,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, ...(init?.body ? { body: init.body } : {}) });

    // Admin login — `getAdminToken` decodes the JWT's `exp` claim, so the token
    // must be a real 3-segment base64url JWT shape (not an opaque string).
    if (path === "/auth/user/emailpass") {
      return json({ token: fakeAdminJwt() });
    }
    // Publishable-key bootstrap (admin API) — any shape with a key works.
    if (path.includes("/admin/api-keys")) {
      return json({ api_keys: [{ id: "apk_1", token: "pk_test_bkl230" }] });
    }
    if (path.includes("/store/payment-providers")) {
      return json({ payment_providers: [{ id: "pp_stripe_stripe", is_enabled: true }] });
    }
    if (method === "GET" && /^\/store\/carts\/[^/]+$/.test(path)) {
      return json(cartBody);
    }
    if (method === "POST" && /^\/store\/carts\/[^/]+$/.test(path)) {
      return json(cartBody);
    }
    if (method === "POST" && path === "/store/payment-collections") {
      return json({ payment_collection: { id: "pc_bkl230" } });
    }
    if (
      method === "POST" &&
      /^\/store\/payment-collections\/[^/]+\/payment-sessions$/.test(path)
    ) {
      return json({
        payment_session: {
          provider_id: "stripe",
          data: { client_secret: "pi_secret_bkl230", id: "pi_bkl230" },
        },
      });
    }
    throw new Error(
      `[customer-e2e-harness] unrouted Medusa egress ${method} ${path} — ` +
        "add an explicit route rather than letting the turn degrade silently",
    );
  };

  return { calls, fetch: fetchFake };
}

// ── Kernel-side primitives ────────────────────────────────────────────────────

export interface CapturingAuditSink extends AuditSink {
  readonly records: AuditRecord[];
  byKind(kind: string): AuditRecord[];
  lastDecision(kind: Decision["kind"]): AuditRecord | undefined;
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
    lastDecision: (kind) => [...records].reverse().find((r) => r.decision.kind === kind),
  };
}

/**
 * A REAL audited adjudicator over the composed router — the same
 * `adjudicateAndAudit` + `buildLanguageEngineAuditMetadata` wiring production
 * uses. `resume` re-adjudicates the parked envelope WITH the confirmation
 * receipt (CONFIRM → EXECUTE), re-projecting state via `projectResumeState` so
 * the resumed turn sees fresh cart state exactly as production's
 * `enrichResumeState` does.
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
      const resumeState = projectResumeState ? await projectResumeState(env) : state;
      return decideWith(env, resumeState, policy, receipt as ConfirmationReceipt);
    },
    replayEnvelopesByCustomerId: async () => [],
    streamAuditByIntentHashPrefix: async function* () {},
    getOutcomes: async () => [],
    verifyAuditRecord: () => ({ ok: true }),
  };
}

/** A stateful in-memory customer SessionPort: parks persist across turns so a
 *  "sim" can resume one. Session id is `web:<customerId>`, matching the
 *  customer-plane lock/session key convention. */
export interface StatefulCustomerSession extends SessionPort {
  parksFor(customerId: string): ParkedEnvelope[];
}

export function makeStatefulCustomerSession(): StatefulCustomerSession {
  const parks = new Map<string, ParkedEnvelope[]>();
  const sid = (customerId: string) => `web:${customerId}`;
  return {
    load: async (customerId: string) => {
      const id = sid(customerId);
      return {
        id,
        customerId,
        channel: "web",
        startedAt: HARNESS_NOW,
        lastActivityAt: HARNESS_NOW,
        pendingConfirmations: parks.get(id) ?? [],
        deferredEnvelopes: [],
        activeGoals: [],
        workingMemory: { summary: "", facts: [], updatedAt: HARNESS_NOW },
      } satisfies Session;
    },
    save: async () => {},
    parkPendingConfirmation: async (sessionId, envelope, confirmationToken, userPrompt) => {
      const list = parks.get(sessionId) ?? [];
      list.push({
        envelope: envelope as IntentEnvelope,
        confirmationToken,
        userPrompt,
        parkedAt: HARNESS_NOW,
      });
      parks.set(sessionId, list);
    },
    parkDeferred: async () => {},
    unpark: async (sessionId, intentHash) => {
      parks.set(
        sessionId,
        (parks.get(sessionId) ?? []).filter((p) => p.envelope.intentHash !== intentHash),
      );
    },
    parksFor: (customerId) => parks.get(sid(customerId)) ?? [],
  };
}

// ── Planner context (faithful copy of the production derivation) ───────────────

/**
 * Byte-equivalent to `deriveIbatexasPlannerContext` (claustrum-bootstrap.ts),
 * inlined rather than imported because importing that module would drag the whole
 * production composition root (pg pool, env `requireEnv` gates) into a unit test.
 * Reads the customerId from the recalled memory snapshot and reuses the SAME
 * `isGuestCustomerId` predicate, so the planner's willingness to propose
 * `order.checkout.create` is gated exactly as in production.
 */
export function deriveCustomerPlannerContext(state: CognitiveState): {
  readonly state: unknown;
  readonly context: unknown;
} {
  const raw = (state.memory as { customerId?: unknown } | undefined)?.customerId;
  const id = typeof raw === "string" ? raw.trim() : "";
  const customerId = id !== "" && !isGuestCustomerId(id) ? id : null;
  return {
    state: {
      ctx: {
        tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
        channel: state.perception.channel,
        customerId,
        staffId: null,
        isAuthenticated: customerId !== null,
        cartId: null,
        orderId: null,
      },
    },
    context: {},
  };
}

// ── Conductor composition ─────────────────────────────────────────────────────

export const noopTelemetry: TelemetryPort = {
  emitTurn: async () => {},
  emitLLMTrace: async () => {},
  emitMemoryAccess: async () => {},
};

export const inMemoryLock: SessionLock = {
  acquire: async (key) => ({ key, release: async () => {} }),
};

/** Memory that carries ONLY the customerId — the single field the planner context
 *  derivation reads. Everything else is empty (no long-term memory in this
 *  harness), mirroring `noopMemoryProvider`'s designed-empty posture. */
function customerMemory(): MemoryPort {
  return {
    async recall(customerId: string) {
      return {
        customerId,
        episodic: [],
        semantic: [],
        procedural: [],
        relational: [],
        assembledAt: HARNESS_NOW,
      };
    },
    async observe() {},
    async search() {
      return [];
    },
    async recentActions() {
      return [];
    },
  };
}

function emptyGrounding(): GroundingPort {
  return {
    async retrieve() {
      return { docs: [], retrievedAt: HARNESS_NOW, modelId: "mock" };
    },
    async attestGrounding() {
      return [];
    },
  };
}

/** Inert responder — this harness asserts decision/acted/park state, never text. */
function inertResponder(): ResponderPort {
  return {
    async respond({ decision, acted }) {
      const actedKind = (acted as { kind?: string } | undefined)?.kind ?? "none";
      return { text: `decision=${decision.kind} acted=${actedKind}` };
    },
  };
}

/** Single-tenant resolver. `policy` carries the composed ROUTER — that is the seam
 *  through which the conductor hands the kernel a per-kind PolicyBundle (there is
 *  no `policy` field on createConductor). Same shape as `opsTenantResolver`. */
const singleTenant: TenantResolver = {
  resolve: async ({ channel, customerId }) => ({
    tenant: {
      tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
      displayName: "IbateXas BKL-230",
      locale: "pt-BR",
      environment: "dev",
    },
    state: { channel, customerId },
    policy: CUSTOMER_ROUTER,
  }),
};

export interface CustomerConductorDeps {
  readonly model: ModelProvider;
  readonly session: SessionPort;
  readonly adjudicator: Adjudicator;
  /**
   * BKL-234 — OPT IN to the customer plane's real claims seams (investigator, claim
   * planner, claims kernel, render-from-claims renderer + the precedence lattice),
   * exactly as `claustrum-bootstrap.ts` composes them.
   *
   * DEFAULT OFF, deliberately: the PIX/checkout suites this harness was built for
   * assert on action replies, and a claims render degrade would clobber them (the
   * reason the file header says claims seams are absent). Omitting the flag leaves
   * every existing caller byte-identical — the spread is `{}`.
   *
   * `buildClaimsSeams` itself also returns `{}` unless ENABLE_CLAIMS_PIPELINE is on,
   * so an opting-in test must set that env var too.
   */
  readonly withClaims?: boolean;
}

export interface CustomerHarness {
  readonly conductor: Conductor;
  /** The real registry the conductor resolves tools from. */
  readonly tools: ReturnType<typeof createToolRegistry>;
}

/**
 * Compose a customer-plane Conductor: real planner + real resolver + real tool
 * registry + real WebConfirmChannel, over the caller's model/session/adjudicator.
 * Claims seams are deliberately absent (see the file header).
 */
export function composeCustomerConductor(deps: CustomerConductorDeps): CustomerHarness {
  const tools = createToolRegistry();
  registerIbatexasToolPacks(tools);

  const planner = createIbatexasPlanner({
    model: deps.model,
    modelId: "mock-model",
    capabilityPlanners: IBATEXAS_COMPOSED_CAPABILITY_PLANNERS,
    deriveContext: deriveCustomerPlannerContext,
  });

  const webChannel = new WebConfirmChannel({
    gatewaySigningKey: "harness-web-signing-key",
    sink: async () => {},
    gateway: "customer-e2e-harness",
  });

  // BKL-234 — the REAL customer claims seams, opt-in. Same builder the customer
  // composition root uses, parameterized only by this harness's planner; `{}` both
  // when not requested and when ENABLE_CLAIMS_PIPELINE is off.
  const claimsSeams = deps.withClaims === true ? buildClaimsSeams({ planner }) : {};

  const conductor = createConductor({
    adjudicator: deps.adjudicator,
    memory: customerMemory(),
    grounding: emptyGrounding(),
    planner,
    responder: inertResponder(),
    explainer: { render: (r) => r.userFacing },
    handoff: { async queue() {} },
    telemetry: noopTelemetry,
    session: deps.session,
    tools,
    channels: [webChannel],
    tenantResolver: singleTenant,
    resolver: createIbatexasResolver(),
    sessionLock: inMemoryLock,
    ...claimsSeams,
  });

  return { conductor, tools };
}

// ── Turn driver ───────────────────────────────────────────────────────────────

export function customerInbound(
  customerId: string,
  conversationId: string,
  text: string,
): ChannelMessage {
  return {
    channel: "web",
    customerId,
    conversationId,
    externalId: `web-${randomUUID()}`,
    text,
    receivedAt: HARNESS_NOW,
    locale: "pt-BR",
  };
}

export interface CustomerTurnResult {
  decision: Decision;
  response: string;
  acted: unknown;
  plan: unknown;
}

/**
 * Open a Capsule with the AUTHENTICATED customer actor, run ONE real
 * `handleTurn`, close the Capsule. `conversationId` is the handle the resolver
 * uses to key the active-cart Redis read, so it must match the seeded
 * `rk("cart:active:session:<conversationId>")` key.
 */
export async function runCustomerTurn(
  harness: CustomerHarness,
  args: { customerId: string; conversationId: string; text: string },
): Promise<CustomerTurnResult> {
  const { customerId, conversationId, text } = args;
  const message = customerInbound(customerId, conversationId, text);
  const capsule = await harness.conductor.openCapsule({
    channel: "web",
    customerId,
    sessionKey: `web:${customerId}`,
    actor: {
      principal: "llm",
      role: "customer",
      sessionId: conversationId,
      customerId,
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
    await harness.conductor.closeCapsule(capsule);
  }
}
