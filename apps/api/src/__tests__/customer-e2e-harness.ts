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
//   - `handleTurn` from @claustrum/core
//   - THE PRODUCTION COMPOSITION ITSELF (R1-S2). This harness no longer composes a
//     conductor; it builds a `CustomerConductorDeps` bag and calls
//     `composeCustomerConductor` from `claustrum/compose-customer-conductor.ts` —
//     the same function `claustrum-bootstrap.ts` calls. So the planner, the
//     responder, the claims-seam planner identity, the workflow decision observer
//     and the one-funnel-instance invariant are not merely "like production", they
//     ARE production. Before this, the composition below was a hand copy, and it
//     had drifted (no safe-unknown gate, no prompt composer, opt-in readAnswer).
//     Divergences now have to be DECLARED as deps to exist; see
//     `composeCustomerConductor` below for the full list.
//   - the production planner over the REAL composed capability planners (so
//     `order.checkout.create` proposability is genuinely gated on an
//     authenticated customer)
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
// Explainer/memory/grounding/telemetry are inert stubs, and the claims seams
// default OFF so a render degrade cannot interfere — BKL-234 makes them OPT-IN
// REAL (`withClaims: true`, the same `buildClaimsSeams` composition as
// claustrum-bootstrap). The RESPONDER defaults
// to an inert stub for the same original reason — this harness asserted on `decision`
// / `acted` / park state, not on rendered text, because render precedence was another
// worker's surface — and LE2-007 makes it OPT-IN REAL (`realResponder: true`), because
// a funnel tier's whole deliverable IS its deterministic template: there is no model
// prose for precedence to arbitrate, so asserting the text is asserting the feature.
//
// SCOPE: checkout-turn needs, plus the funnel's L0 tier (LE2-007 — `funnel`,
// `realResponder`, `scheduleSignal`, `throwingModel`, and the per-turn funnel context
// `runCustomerTurn` publishes like the production ingresses), plus the opt-in claims
// seams (BKL-234 — `withClaims`), plus (BKL-103) an optional `handoff` port so an
// ESCALATE-ing turn can drive the AUT-017 park seam. No speculative ports, no
// fixtures for other intent kinds — a kind's own fixtures live in its test file
// (see chat-cancel-escalate-approve.e2e.test.ts, which supplies the order/payment
// doubles for a cancel turn). Expected to keep growing as later tickets extend the
// customer funnel.

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
  createToolRegistry,
  handleTurn,
  type Adjudicator,
  type ChannelMessage,
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
import { IBATEXAS_COMPOSED_PACKS } from "@ibatexas/packs-composed";
import { WhatsAppChannel } from "@claustrum/channel-whatsapp";
import { buildIbatexasPolicyPacks, type ErasedPack } from "../claustrum/compose-policy-packs.js";
import { composePolicyRouter } from "../claustrum/capability-policy.js";
// R1-S2 — THE PRODUCTION COMPOSER. This harness is its SECOND ADAPTER: everything
// below builds a production `CustomerConductorDeps` bag out of this harness's
// doubles and delegates. Aliased on import so the harness keeps its own export
// names (24 test files consume them) while it is unambiguous at every use site
// which of the two `composeCustomerConductor`s is meant.
import {
  composeCustomerConductor as composeProductionCustomerConductor,
  type CustomerConductorDeps as ProductionCustomerConductorDeps,
} from "../claustrum/compose-customer-conductor.js";
import { buildClaimsSeams, claimsPipelineEnabled } from "../claustrum/claims-pipeline.js";
import { createSafeUnknownGate } from "../claustrum/safe-unknown-gate.js";
import { createIbatexasPromptComposer } from "../claustrum/prompts/ibatexas-prompts.js";
import { createIbatexasResolver } from "../claustrum/ibatexas-resolver.js";
import {
  closeFunnelTurn,
  createParseFunnel,
  openFunnelTurn,
  type FunnelParseMemoSeam,
  type FunnelPlannerSeam,
  type FunnelResponderSeam,
  type FunnelAliasSeam,
  type FunnelScopeSeam,
} from "../claustrum/funnel-tier.js";
import type { CapabilityRetriever } from "../claustrum/capability-retrieval.js";
import type { ScheduleSignal } from "../claustrum/closed-hours.js";
import { WebConfirmChannel } from "../claustrum/web-confirm-channel.js";
import { buildLanguageEngineAuditMetadata } from "../claustrum/language-engine/audit-metadata.js";
import { registerIbatexasToolPacks } from "../tools/register-ibatexas-tool-packs.js";
import { registerWorkflowAnchorTools } from "../tools/register-workflow-anchor-tools.js";
import { registerWorkflowScopedTools } from "../tools/register-workflow-scoped-tools.js";
import type { WorkflowRuntime } from "../claustrum/workflow/workflow-runtime.js";
import { installWorkflowRuntime } from "../claustrum/workflow/workflow-install.js";
import { closeWorkflowTurn } from "../claustrum/workflow/workflow-trace.js";
import { beginWorkflowTurn } from "../claustrum/workflow/workflow-turn.js";

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

/**
 * A model that THROWS on every surface — the wire-proof instrument (LE2-007).
 *
 * The harness's contract is that a fake must fail loudly rather than degrade quietly
 * (see `makeMedusaFetchFake`'s unrouted-egress throw), and a ZERO-MODEL-CALL claim can
 * only be proven by an instrument that cannot be satisfied: if any seam — the planner's
 * extraction pass, the claim planner, the responder's synthesis — reaches the model, the
 * turn fails instead of quietly costing a completion. A counting spy would let a
 * regression pass with a wrong number nobody asserted.
 */
export function throwingModel(label = "L0 zero-call proof"): ModelProvider {
  const boom = (surface: string): never => {
    throw new Error(
      `[customer-e2e-harness] model.${surface}() was called — ${label} requires ZERO model calls on this turn`,
    );
  };
  return {
    complete: vi.fn(async () => boom("complete")),
    stream: () => boom("stream"),
    embed: async () => boom("embed"),
  };
}

/**
 * A model that throws on any TOOL-BEARING (extraction/planner) request but serves
 * an ordinary responder completion otherwise — the wire-proof instrument for a
 * tier that removes the PARSE call and only the parse call (LE2-009's L1).
 *
 * WHY NOT `throwingModel` FOR L1. L0 answers from a template, so its turn is
 * genuinely zero-call and `throwingModel` is the honest instrument there. L1
 * replays a PARSE: the turn still resolves, adjudicates, executes and then has to
 * SAY something, and unless that reply happens to come from a deterministic
 * render the responder legitimately calls the model. Using `throwingModel` for an
 * L1 turn would therefore assert a claim the tier never made. This double asserts
 * the claim it does make — the extraction surface is never reached — and does it
 * by construction rather than by counting, exactly like its sibling.
 *
 * `tools.length > 0` is the same discriminator `scriptedModel` and the real
 * `OllamaFetchClient.wireBody()` use to tell a planner body from a responder one.
 */
export function plannerThrowingModel(
  label = "L1 zero-extraction-call proof",
  opts: { responderText?: string } = {},
): ModelProvider {
  const responderText = opts.responderText ?? "Ok.";
  const complete = vi.fn(async (req: CompletionRequest): Promise<Completion> => {
    if ((req.tools?.length ?? 0) > 0) {
      throw new Error(
        `[customer-e2e-harness] a TOOL-BEARING completion was requested — ${label} requires ZERO extraction calls on this turn`,
      );
    }
    return {
      model: "mock",
      stopReason: "end_turn",
      text: responderText,
      toolCalls: [],
      inputTokens: 3,
      outputTokens: 2,
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

export function makeStatefulCustomerSession(
  /**
   * LE2-024 — the plane this session belongs to. Defaults to `"web"`, so every
   * pre-existing caller is byte-identical.
   *
   * `SessionPort.load` receives only a customer id, so the double cannot derive
   * the channel per call — it is a property of the composition. Taking it at
   * construction is what lets a WhatsApp turn's session report `channel:
   * "whatsapp"` (and key its parks under `whatsapp:<customerId>`) instead of
   * silently describing every plane as web, which was the last of the six
   * hard-wired `"web"` sites in this harness.
   */
  channel: CustomerChannel = "web",
): StatefulCustomerSession {
  const parks = new Map<string, ParkedEnvelope[]>();
  const sid = (customerId: string) => `${channel}:${customerId}`;
  return {
    load: async (customerId: string) => {
      const id = sid(customerId);
      return {
        id,
        customerId,
        channel,
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

// ── Conductor composition ─────────────────────────────────────────────────────
//
// R1-S2 — the hand-copied `deriveCustomerPlannerContext` that used to live here is
// GONE. It existed because importing the derivation meant importing the production
// composition root (pg pool, env `requireEnv` gates); R1-S1 moved the derivation
// into the import-pure composer module, so the production
// `deriveIbatexasPlannerContext` is now reachable without dragging any
// infrastructure — and the composer applies it itself, which is why this harness no
// longer names it at all.

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
   * BKL-103 — the HandoffPort the conductor calls on an ESCALATE. Defaults to the
   * inert no-op this harness shipped with (checkout turns never escalate). Supply
   * the AUT-017 PARKING handoff — the same `ESCALATION_RESUMABLE_KINDS`-gated
   * `park(buildEscalationParkInput(envelope))` shape `natsHandoff(publish,
   * parkDeps)` performs in production — to drive an escalate→park→approve→resume
   * loop through a REAL customer turn. Without it a resumable ESCALATE is audited
   * but never parked, which is exactly the pre-BKL-103 hole.
   */
  readonly handoff?: { queue: (envelope: IntentEnvelope, reason: string) => Promise<void> };
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
  /**
   * LE2-007 — the parse funnel's tier seam, wired into BOTH real seams (planner +
   * responder) exactly as `bootstrapClaustrum` wires one instance into both.
   *
   * R1-S2 — OMITTING IT IS NO LONGER "NO FUNNEL". The production composition
   * requires one instance and fans it into every tier seam, so an omitted funnel
   * becomes a bare `createParseFunnel({})`: L1 and L2 stay absent (no parse-cache
   * store, no retriever), but L0 and the ALIAS layer become ARMED, because the
   * planner arms alias canonicalization on the seam's mere PRESENCE. Pass a funnel
   * explicitly whenever a suite cares which tiers are live.
   */
  readonly funnel?: FunnelPlannerSeam & FunnelResponderSeam;
  /**
   * LE2-007 — replace the inert responder with the REAL production responder
   * (`createIbatexasResponder` over the same model). Required by any test that asserts
   * on the reply TEXT: the file header's "asserts on decision/acted, never text" rule
   * was scoped to render precedence being another worker's surface, and an L0 turn's
   * whole deliverable IS its deterministic template — there is no model prose to
   * arbitrate. Omitted ⟹ the inert responder ⟹ byte-identical.
   */
  readonly realResponder?: boolean;
  /**
   * LE2-007 — the structured open/closed signal the real responder resolves once per
   * turn (the closed-hours soft note + deterministic backstop read it). Omitted ⟹ no
   * schedule wired ⟹ no closed-hours behaviour, exactly as in the unit suites.
   */
  readonly scheduleSignal?: ScheduleSignal;
  /**
   * LE2-007 — replace the no-op telemetry. `emitTurn` is the loop's ONCE-PER-TURN
   * seam, and it is where production stamps funnel-tier attribution onto the
   * guaranteed per-turn trace line (claustrum-bootstrap's `emitTurn` reads
   * `funnelStage(turnId)`). A test that wires its own telemetry can therefore assert
   * tier attribution at the exact seam production writes it, rather than at a
   * synthetic probe. Omitted ⟹ `noopTelemetry` ⟹ byte-identical.
   */
  readonly telemetry?: TelemetryPort;
  /**
   * LE2-009 — the funnel's L1 seam (exact-match parse memoization). Normally the
   * SAME object passed as `funnel` (`createParseFunnel` returns both seams when a
   * parse cache store is wired); kept a separate option for the same reason the
   * planner takes it separately — L0 and L1 run at different points in `propose`.
   *
   * R1-S2 — DERIVED, NOT FORWARDED. The production composition takes no separate
   * tier-seam deps: it derives L1 from the one funnel instance
   * (`funnel.lookupParse !== undefined`), which is the same guard every caller here
   * already applied. So this option's only remaining job is to DECLARE the intent —
   * passing anything that is not the identical `funnel` object throws at compose
   * time rather than being silently ignored.
   */
  readonly parseMemo?: FunnelParseMemoSeam;
  /**
   * LE2-009 — the customer plane's DETERMINISTIC action render, which
   * `claustrum-bootstrap.ts` wires into the real responder in production
   * (`renderCustomerActionAnswer`) but this harness previously omitted.
   *
   * It is what makes a funnel turn provably zero-model-call END TO END rather
   * than merely zero-EXTRACTION-call: with it, a committed mutation's reply is
   * rendered from the tool's own outcome, so the responder never needs to author
   * prose and a `throwingModel` can stand as the wire proof.
   *
   * R1-S2 — NOW ALWAYS WIRED, AND NO LONGER READ. Production wires its own
   * `readAnswer` (the `renderCustomerActionAnswer` action render, with an empty
   * customer READ half) unconditionally, so this option is inert. Kept declared only
   * so the five suites that pass it still compile: all five pass exactly the
   * production shape, which is why converging on production's is a no-op for them.
   */
  readonly readAnswer?: {
    render: (turnId: string) => string | undefined;
    renderAction: (acted: unknown, turnId: string) => string | undefined;
  };
  /**
   * LE2-008 — the funnel's L2 tier: the capability retriever that narrows this
   * turn's advertised roster, and the seam that stamps its decision on the trace.
   * Normally the retriever plus the SAME funnel instance passed as `funnel`.
   * Omitted ⟹ no retrieval ⟹ the full roster, byte-identical to pre-L2.
   *
   * R1-S2 — `retriever` is forwarded (as the production `capabilityRetriever`);
   * `scopeSeam` is DERIVED from the funnel, exactly like `parseMemo`, and is
   * guarded for identity rather than ignored.
   */
  readonly retriever?: CapabilityRetriever;
  readonly scopeSeam?: FunnelScopeSeam;
  /**
   * LE2-025b — the alias layer's seam (resolutions for the trace + the CLARIFY
   * short-circuit). Normally the SAME funnel instance as `funnel`.
   *
   * R1-S2 — DERIVED AND UNCONDITIONAL. Production wires `aliasSeam: funnel` with no
   * flag ("deterministic catalog data with no external dependency, so there is
   * nothing to degrade to"), so ANY suite with a funnel now has the alias layer
   * armed whether or not it passes this option. Omitting it no longer means "no
   * canonicalization" — see the `funnel` option.
   */
  readonly aliasSeam?: FunnelAliasSeam;
  /**
   * LE2-020 — the WORKFLOW RUNTIME. Wired into three places at once, exactly as
   * a production composition would: the planner (which advertises the closed
   * workflow surface and instantiates a selection), the tool registry (whose
   * anchor tools are wrapped so a confirmed workflow runs its activities), and
   * the adjudicator (decorated to observe the kernel's confirm sentence so the
   * confirm template can quote it).
   *
   * Omitted ⟹ no workflow is advertised, no tool is wrapped, no decision is
   * observed ⟹ every pre-existing harness turn is byte-identical.
   */
  readonly workflowRuntime?: WorkflowRuntime;
  /**
   * LE2-024 — ALSO wire the REAL `WhatsAppChannel`, so a turn driven with
   * `channel: "whatsapp"` can resume a parked confirm.
   *
   * ── WHY THIS HAD TO BE A REAL DRIVER ────────────────────────────────────────
   *
   * `matchToParked` is CHANNEL-OWNED by design (the class's own doc says so:
   * matching is "a channel-shaped concern — regex against natural language,
   * hash-prefix conventions, locale variants"). This composition previously wired
   * the web driver alone, so a `channel: "whatsapp"` turn PARKED normally and
   * then silently failed to resume: the customer's "sim" read as a fresh
   * utterance, no re-adjudication happened, and every assertion about the second
   * turn measured the missing driver rather than the product.
   *
   * That failure is symmetric across paths, so it does not bias a parity diff —
   * but it makes the confirm half of cross-channel parity UNPROVABLE, which for a
   * ticket whose acceptance criterion is "the ladder behaves identically on every
   * channel it exists on" is the whole question.
   *
   * Outbound `render` is pointed at an injected no-op rather than global `fetch`,
   * using the config's own test seam: a suite that stubs `fetch` for Medusa must
   * not have a Twilio POST land in that fake, and a channel that silently
   * swallowed an unroutable egress would be the wrong kind of quiet.
   *
   * Omitted ⟹ the web driver alone ⟹ every pre-existing caller is byte-identical.
   */
  readonly withWhatsApp?: boolean;
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
/**
 * Build the tool registry for a composition: the real roster, plus — only when a
 * workflow runtime is wired — the workflow-scoped handlers its corpus invokes
 * and the anchor wrappers.
 *
 * Extracted from {@link composeCustomerConductor} (LE2-020) because the ORDER
 * here is load-bearing and deserves to be readable on its own: the registry is
 * last-write-wins per capability, so "scoped handlers, then anchors, then hand
 * it over" IS the installation mechanism, not a style choice.
 */
function buildHarnessTools(
  workflowRuntime: WorkflowRuntime | undefined,
): ReturnType<typeof createToolRegistry> {
  const tools = createToolRegistry();
  registerIbatexasToolPacks(tools);
  if (workflowRuntime !== undefined) {
    // The workflow-scoped handlers FIRST — `installWorkflowRuntime` asserts the
    // anchor has a tool, and a workflow-scoped activity needs one too before
    // the runtime can dispatch it.
    registerWorkflowScopedTools(tools, workflowRuntime.activityCapabilities());
    // LE2-021 — then the corpus-derived ANCHOR handlers, for a workflow anchored
    // on a kind the LLM-callable roster deliberately does not carry (see
    // `register-workflow-anchor-tools.ts`). A no-op for an anchor the roster
    // already owns, which is why LE2-020's fixture corpus is unaffected.
    registerWorkflowAnchorTools(tools, workflowRuntime.selectionAnchors());
    installWorkflowRuntime(tools, workflowRuntime);
  }
  return tools;
}

/**
 * An INERT {@link WorkflowRuntime} — the double a composition without a workflow
 * gets, because the production composer requires one.
 *
 * Inert by CONSTRUCTION, not by configuration: it advertises nothing, so no
 * workflow reaches the wire; it selects nothing, so `run` and `renderOutcome` are
 * unreachable; it renders no confirm and no notice, so the responder's two workflow
 * seams both fall through exactly as they did when the harness omitted them; and
 * `recordSelectionDecision` is a no-op, which is what makes the composer's
 * unconditional `observeWorkflowDecisions` wrap behaviourally invisible (the
 * observer's only side effect IS that call, and it returns the inner decision
 * unchanged — see workflow-install.ts).
 *
 * Every member of the interface is implemented rather than cast in, so adding a
 * member to `WorkflowRuntime` is a compile error here instead of a runtime
 * `undefined is not a function` on whichever suite happens to reach it first.
 */
function inertWorkflowRuntime(): WorkflowRuntime {
  return {
    advertise: () => [],
    select: () => undefined,
    instanceFor: () => undefined,
    instanceById: () => undefined,
    checkFeasibility: async () => undefined,
    renderNotice: () => undefined,
    recordSelectionDecision: () => {},
    renderConfirm: () => undefined,
    renderOutcome: () => "",
    run: async () => undefined,
    selectionCapabilities: () => new Set<string>(),
    activityCapabilities: () => new Set<string>(),
    close: () => {},
  };
}

/**
 * THE ADAPTER SWAP (R1-S2). Builds a production `CustomerConductorDeps` bag from
 * this harness's doubles and delegates to the ONE composition
 * (`claustrum/compose-customer-conductor.ts`). Production's
 * `bootstrapClaustrum` is adapter #1; this is adapter #2.
 *
 * WHAT THIS DELETED, and why that is the point: the harness used to hold its own
 * `createIbatexasPlanner` call, its own responder builder, a byte-copy of the
 * planner-context derivation, its own `observeWorkflowDecisions` wrap and its own
 * `createConductor` call — a second composition root that nothing forced to agree
 * with the first, kept in sync by hand through comments that said "PARITY with
 * buildResponder". Those comments are gone because the parity is now structural:
 * there is one composition, and a divergence has to be DECLARED as a dep to exist
 * at all (today exactly one is — `responderOverride`).
 *
 * THE DECLARED DIVERGENCES, all of them:
 *   - `responderOverride` — the inert responder, unless `realResponder: true`.
 *   - `explainer` — this harness's `{ render: (r) => r.userFacing }` rather than
 *     production's; changing reply-shaping for every suite at once is a different
 *     change from deleting a twin.
 *   - `readToolExecutors: {}` — the real registry drags bootstrap infrastructure.
 *   - `chatModelId: "mock-model"`, and the memory/grounding/telemetry/lock doubles.
 */
export function composeCustomerConductor(deps: CustomerConductorDeps): CustomerHarness {
  // The ORIGINAL dep, deliberately — NOT the inert double below. Workflow tooling
  // must be installed only when a test actually wired a runtime; installing it over
  // the inert double would register anchor/activity handlers for an empty corpus and
  // make `buildHarnessTools`'s last-write-wins ordering observable on every suite.
  const tools = buildHarnessTools(deps.workflowRuntime);

  // A funnel-derived option must be the SAME INSTANCE as `funnel` — the production
  // composer fans ONE instance into every tier seam (planner L0/L1/L2/ALIAS +
  // responder), so it takes no separate seam deps. Every caller already passes the
  // same object; this turns a future mismatch into a loud failure at compose time
  // instead of a suite that silently measures the wrong instance.
  for (const [name, seam] of [
    ["parseMemo", deps.parseMemo],
    ["scopeSeam", deps.scopeSeam],
    ["aliasSeam", deps.aliasSeam],
  ] as const) {
    if (seam !== undefined && seam !== (deps.funnel as unknown)) {
      throw new Error(
        `[customer-e2e-harness] \`${name}\` must be the SAME object as \`funnel\` — ` +
          "the production composition derives every tier seam from one funnel instance",
      );
    }
  }

  const webChannel = new WebConfirmChannel({
    gatewaySigningKey: "harness-web-signing-key",
    sink: async () => {},
    gateway: "customer-e2e-harness",
  });

  // LE2-024 — the REAL WhatsApp driver, opt-in. See `withWhatsApp`.
  const whatsAppChannel =
    deps.withWhatsApp === true
      ? new WhatsAppChannel({
          accountSid: "ACharness",
          authToken: "harness-twilio-auth-token",
          twilioFrom: "whatsapp:+14155238886",
          gatewaySigningKey: "harness-wa-signing-key",
          // The config's own test seam — never global `fetch`, which suites
          // stub for Medusa and which throws on an unrouted egress.
          fetch: (async () =>
            new Response(JSON.stringify({ sid: "SMharness" }), {
              status: 201,
              headers: { "content-type": "application/json" },
            })) as typeof globalThis.fetch,
        })
      : undefined;

  const productionDeps: ProductionCustomerConductorDeps = {
    // RAW. The composer applies `observeWorkflowDecisions` itself (that observer is
    // part of what "the customer conductor" means), and with an inert runtime the
    // wrap is behaviourally inert — so unlike the deleted inline version there is no
    // branch here on whether a workflow was wired.
    adjudicator: deps.adjudicator,
    workflowRuntime: deps.workflowRuntime ?? inertWorkflowRuntime(),
    model: deps.model,
    chatModelId: "mock-model",
    memory: customerMemory(),
    grounding: emptyGrounding(),
    channels: whatsAppChannel === undefined ? [webChannel] : [webChannel, whatsAppChannel],
    telemetry: deps.telemetry ?? noopTelemetry,
    session: deps.session,
    tools,
    tenantResolver: singleTenant,
    // A DEP now, not a call inside the composition — the composer is import-pure and
    // takes the resolver from whoever composes it.
    resolver: createIbatexasResolver(),
    sessionLock: inMemoryLock,
    handoff: deps.handoff ?? { async queue() {} },
    // The REAL composer: pure (a registry plus a synthesizer, no infrastructure), and
    // the single inviolable persona fragment makes `composed.system ===
    // DEFAULT_SYSTEM_PROMPT`, which is the system prompt the harness's planner got
    // when it passed no composer at all.
    promptComposer: createIbatexasPromptComposer(),
    // DECLARED VALUE DIVERGENCE — this harness's explainer, not production's. Every
    // suite that asserts on reply text was written against `r.userFacing`, and
    // converting all of them to production reply-shaping at once is out of scope.
    explainer: { render: (r) => r.userFacing },
    // `undefined` when the test wired no schedule, which is what the responder's
    // closed-hours layers read as "no schedule".
    resolveScheduleSignal: () => deps.scheduleSignal,
    // ── THE FUNNEL (see this option's doc on `CustomerConductorDeps.funnel`) ─────
    // Production requires ONE instance and fans it into every tier seam. The cast is
    // the harness option being NARROWER than the production seam union
    // (`FunnelPlannerSeam & FunnelResponderSeam` vs. what `createParseFunnel`
    // returns); every caller in fact passes a `createParseFunnel` product, and the
    // same-instance guard above is what keeps that true.
    funnel: (deps.funnel ?? createParseFunnel({})) as ProductionCustomerConductorDeps["funnel"],
    ...(deps.retriever === undefined ? {} : { capabilityRetriever: deps.retriever }),
    // DECLARED VALUE DIVERGENCE — importing the real one-hop read-tool registry would
    // drag bootstrap infrastructure. Empty behaves as the option's absence did: the
    // planner's enrichment loop finds no executor for any capability.
    readToolExecutors: {},
    // BKL-234 — the REAL seams, opt-in, over whichever planner instance the composer
    // hands the conductor (that identity is the Q6b invariant the composer owns).
    // `{}` both when not requested and when ENABLE_CLAIMS_PIPELINE is off.
    claimsSeamsFor: (planner) => (deps.withClaims === true ? buildClaimsSeams({ planner }) : {}),
    // PRODUCTION PARITY, deliberately: the harness never wired safeUnknown before, and
    // that was drift rather than a decision. Reading the SAME flag production reads
    // means a default-mode suite (flag off ⟹ undefined) sees no change, and a suite
    // that turns the flag on now gets the gate production would have given it.
    safeUnknownGateFor: () => (claimsPipelineEnabled() ? createSafeUnknownGate() : undefined),
    ...(deps.realResponder === true ? {} : { responderOverride: inertResponder() }),
  };

  const { conductor } = composeProductionCustomerConductor(productionDeps);
  return { conductor, tools };
}

// ── Turn driver ───────────────────────────────────────────────────────────────

/**
 * LE2-024 — the channels a harness turn can arrive on.
 *
 * A UNION rather than `string`, because the channel is not a label: it reaches
 * `activityIdentityBase`, `canCheckout` reads it, and a typo would silently
 * adjudicate against another plane's rules while every assertion still passed.
 * Two members because those are the two customer planes the production ingresses
 * bind (`routes/chat.ts`, `routes/whatsapp-webhook.ts`).
 */
export type CustomerChannel = "web" | "whatsapp";

export function customerInbound(
  customerId: string,
  conversationId: string,
  text: string,
  /** LE2-024 — defaults to `"web"`, so every pre-existing caller is unchanged. */
  channel: CustomerChannel = "web",
): ChannelMessage {
  return {
    channel,
    customerId,
    conversationId,
    externalId: `${channel}-${randomUUID()}`,
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
  /** The conductor-minted turn id — the key every per-turn trace surface (funnel
   *  stage record, turn_trace rows) is written under. */
  turnId: string;
}

/**
 * Open a Capsule with the AUTHENTICATED customer actor, run ONE real
 * `handleTurn`, close the Capsule. `conversationId` is the handle the resolver
 * uses to key the active-cart Redis read, so it must match the seeded
 * `rk("cart:active:session:<conversationId>")` key.
 */
export async function runCustomerTurn(
  harness: CustomerHarness,
  args: {
    customerId: string;
    conversationId: string;
    text: string;
    /**
     * LE2-024 — the plane this turn arrives on. Defaults to `"web"`, so every
     * pre-existing caller is byte-identical.
     *
     * It is threaded to all THREE places the production ingresses thread it —
     * the inbound message, the Capsule, and `beginWorkflowTurn` — because they
     * are read by different layers and agreeing on two of them is how a
     * WhatsApp workflow activity ends up adjudicated against web rules
     * (`activityIdentityBase`'s own header says so).
     *
     * The Capsule's `sessionKey` is channel-scoped to match, but note that
     * {@link makeStatefulCustomerSession} still keys its parks on the id IT
     * returns (`web:<customerId>`), so within one harness a park is shared
     * across planes. That is fine for the cross-channel suites, which build a
     * FRESH harness per channel, and it is called out here so nobody reads the
     * scoped key as a cross-plane isolation guarantee it does not make.
     */
    channel?: CustomerChannel;
  },
): Promise<CustomerTurnResult> {
  const { customerId, conversationId, text } = args;
  const channel = args.channel ?? "web";
  const message = customerInbound(customerId, conversationId, text, channel);
  const capsule = await harness.conductor.openCapsule({
    channel,
    customerId,
    sessionKey: `${channel}:${customerId}`,
    actor: {
      principal: "llm",
      role: "customer",
      sessionId: conversationId,
      customerId,
    },
    inbound: message,
  });
  try {
    // LE2-007 — publish the turn's FUNNEL CONTEXT exactly as the production customer
    // ingresses do (routes/chat.ts, routes/whatsapp-webhook.ts): the confirm-window
    // fact read from the authoritative `capsule.loadedSession`, keyed on this turn's
    // id. Inlined here because importing the route would drag the whole
    // composition root into a unit test (the ingress is the one production seam
    // R1-S2 did NOT extract — `composeCustomerConductor` composes the conductor,
    // not the per-turn context publication around `handleTurn`) — and it is what
    // makes the FE-D32 confirm-window gate reachable through the REAL
    // seam instead of a synthetic probe. Harmless when no funnel is wired: nothing
    // reads the context.
    openFunnelTurn(capsule.turnId, {
      confirmWindowOpen:
        (capsule.loadedSession?.pendingConfirmations?.length ?? 0) > 0,
    });
    // LE2-021 — bind the turn for the workflow decision observer, wrapping
    // `handleTurn` exactly as the production ingresses do (routes/chat.ts,
    // routes/whatsapp-webhook.ts). The binding is the async call tree's, not the
    // module's, so a caller driving two turns concurrently gets two bindings.
    const turn = await beginWorkflowTurn({ turnId: capsule.turnId, channel }, () =>
      handleTurn(capsule, message),
    );
    return {
      decision: turn.decision as Decision,
      response: turn.response.text,
      acted: turn.acted,
      plan: turn.plan,
      turnId: capsule.turnId,
    };
  } finally {
    closeFunnelTurn(capsule.turnId);
    await harness.conductor.closeCapsule(capsule);
  }
}

/**
 * Drop a turn's workflow state. Deliberately NOT in `runCustomerTurn`'s
 * `finally`: a multi-turn confirm flow needs the instance to SURVIVE the
 * selecting turn so the confirming turn can run it, and the trace to survive
 * the running turn so a test can read it. The production ingress owns the same
 * decision — it is the confirm window's lifetime, not the turn's.
 */
export function closeCustomerWorkflowTurn(
  runtime: WorkflowRuntime,
  turnId: string,
): void {
  runtime.close(turnId);
  closeWorkflowTurn(turnId);
}
