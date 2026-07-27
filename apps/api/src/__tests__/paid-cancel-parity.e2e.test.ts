/**
 * LE2-024 — THE PARITY PIN for the paid-cancel re-platform.
 *
 * Every other workflow e2e in this directory drives ONE path and asserts it is
 * correct. This one drives TWO — the direct-intent `order.cancel` ladder that
 * has always existed, and `workflow.orders.paid-cancel` that re-platforms it —
 * over ONE set of fixtures, and DIFFS THE OBSERVATIONS.
 *
 * ── WHY A ONE-PATH SUITE WOULD BE VACUOUS ────────────────────────────────────
 *
 * A "parity" test that drove only the workflow and compared it to hard-coded
 * expected strings would be pinning the new path against a snapshot of what
 * somebody BELIEVED the old path did. Every interesting failure — the old path
 * changing, the two paths agreeing on the wrong thing, a copy edit moving one
 * render — is invisible to it. Both paths run here, in the same file, against
 * the same seeded order, and the assertions are over the DIFFERENCE.
 *
 * The observation is deliberately narrow and deliberately structural
 * ({@link Observation}): the customer-facing renders, the decision kinds and
 * bases the kernel wrote for `order.cancel`, what reached the staff handoff, and
 * what actually moved in the store. Those are the four things "same behaviour"
 * can honestly mean.
 *
 * ── THE THREE DIVERGENCES THIS SUITE MEASURES RATHER THAN HIDES ──────────────
 *
 * Parity is not identity here, and the suite's job is to say exactly where and
 * why. All three are asserted as facts, not tolerated as gaps:
 *
 *   1. THE ESCALATE BAND COSTS ONE TURN. The direct ladder escalates on the
 *      first turn without asking; the workflow asks its confirm and escalates on
 *      the second. Forced by BKL-103 — an escalation raised at the anchor would
 *      park an `order.cancel.request`, which no approval path can act on. See
 *      `confirmPaidCancel`'s doc.
 *   2. THE WORKFLOW REFUNDS AND THE DIRECT PATH DOES NOT. `order.cancel`'s
 *      registered tool (`cancelOrder`) skips settled payments silently; the
 *      workflow dispatches `executeOrderCancel`, which is refund-first. This is
 *      a DEFECT IN THE OLD PATH, measured here rather than reproduced, and it is
 *      the strongest argument on the retirement question.
 *   3. THE SUCCESS RENDER DIFFERS. The direct path renders from the tool's own
 *      outcome; the workflow renders its authored `completed` template. Both are
 *      first-party and neither is model prose.
 *
 * Mocks sit at the client boundary only — Redis, Stripe, Medusa's `fetch`,
 * `@ibatexas/domain`'s services, the NATS publisher. Above those everything is
 * production: the real planner, the real RESOLVE stage, the real composed policy
 * router, the real `adjudicateAndAudit`, the real tool registry, the real
 * `WebConfirmChannel.matchToParked`, and both real cancel write paths.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake, orderRowsFake, paymentRowsFake, natsSpy } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    orderRowsFake: { rows: [] as Record<string, unknown>[] },
    paymentRowsFake: { rows: new Map<string, Record<string, unknown>>() },
    natsSpy: { calls: [] as { event: string; payload: Record<string, unknown> }[] },
  };
});

vi.mock("redis", () => {
  const client = {
    isOpen: true,
    on: () => client,
    connect: async () => client,
    quit: async () => undefined,
    get: async (key: string) => redisFake.strings.get(key) ?? null,
    set: async (key: string, value: string) => {
      redisFake.strings.set(key, String(value));
      return "OK";
    },
    del: async (key: string) => (redisFake.strings.delete(key) ? 1 : 0),
    incr: async () => 1,
    eval: async () => null,
    hGetAll: async (key: string) => redisFake.hashes.get(key) ?? {},
    hSet: async (key: string, field: string, value: string) => {
      const h = redisFake.hashes.get(key) ?? {};
      h[field] = String(value);
      redisFake.hashes.set(key, h);
      return 1;
    },
    hDel: async () => 1,
    expire: async () => 1,
    multi: () => {
      const chain: Record<string, unknown> = {
        hSet: () => chain,
        expire: () => chain,
        exec: async () => [],
      };
      return chain;
    },
    duplicate: () => client,
  };
  return { createClient: () => client };
});

vi.mock("stripe", () => ({
  default: vi.fn().mockImplementation(() => ({
    paymentIntents: {
      confirm: vi.fn().mockResolvedValue({ id: "pi_le2024", status: "succeeded" }),
      update: vi.fn().mockResolvedValue({ id: "pi_le2024" }),
      retrieve: vi.fn().mockResolvedValue({ id: "pi_le2024" }),
      cancel: vi.fn().mockResolvedValue({ id: "pi_le2024", status: "canceled" }),
    },
  })),
}));

vi.mock("@ibatexas/nats-client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    publishNatsEvent: async (event: string, payload: Record<string, unknown>) => {
      natsSpy.calls.push({ event, payload });
    },
  };
});

/**
 * The domain doubles — the SAME shapes the swap-for-coupon suite uses, because
 * both paths under test read through them and a second dialect of "what the
 * store does" would make a diff between the paths unreadable.
 */
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const sorted = (customerId: string): Record<string, unknown>[] =>
    orderRowsFake.rows
      .filter((r) => r["customerId"] === customerId)
      .sort(
        (a, b) =>
          Number(new Date(String(b["medusaCreatedAt"]))) -
          Number(new Date(String(a["medusaCreatedAt"]))),
      );
  const activePayment = (orderId: string): Record<string, unknown> | null =>
    [...paymentRowsFake.rows.values()].find(
      (p) =>
        p["orderId"] === orderId &&
        p["status"] !== "refunded" &&
        p["status"] !== "pay_canceled",
    ) ?? null;
  return {
    ...actual,
    createOrderQueryService: () => ({
      getById: async (id: string, opts?: { customerId?: string }) => {
        const row = orderRowsFake.rows.find((r) => r["id"] === id) ?? null;
        if (row === null) return null;
        if (opts?.customerId !== undefined && row["customerId"] !== opts.customerId) {
          return null;
        }
        return row;
      },
      listByCustomer: async (customerId: string, input?: { limit?: number }) => {
        const owned = sorted(customerId);
        return { orders: owned.slice(0, input?.limit ?? 20), count: owned.length };
      },
      findByDisplayId: async () => [],
      listAll: async () => ({ orders: [...orderRowsFake.rows], count: orderRowsFake.rows.length }),
      getStatusHistory: async () => [],
    }),
    createOrderCommandService: () => ({
      transitionStatusFromEnvelope: async (envelope: {
        payload: { orderId: string; newStatus: string };
      }) => {
        const { orderId, newStatus } = envelope.payload;
        const row = orderRowsFake.rows.find((r) => r["id"] === orderId);
        if (row === undefined) return { decision: { kind: "REFUSE" }, result: null };
        row["fulfillmentStatus"] = newStatus;
        row["version"] = Number(row["version"] ?? 1) + 1;
        return {
          decision: { kind: "EXECUTE" },
          result: { version: row["version"], newStatus },
        };
      },
    }),
    createPaymentQueryService: () => ({
      getById: async (id: string) => paymentRowsFake.rows.get(id) ?? null,
    }),
    createPaymentCommandService: () => ({
      findActiveByOrderId: async (orderId: string) => activePayment(orderId),
      issueRefundFromEnvelope: async (envelope: {
        payload: { paymentId: string; refundAmountCentavos: number };
      }) => {
        const { paymentId, refundAmountCentavos } = envelope.payload;
        const p = paymentRowsFake.rows.get(paymentId);
        if (p === undefined) return { decision: { kind: "REFUSE" }, result: null };
        if (p["refundDecision"] !== undefined && p["refundDecision"] !== "EXECUTE") {
          return { decision: { kind: String(p["refundDecision"]) }, result: null };
        }
        paymentRowsFake.rows.set(paymentId, {
          ...p,
          status: "refunded",
          refundedAmountCentavos: refundAmountCentavos,
          version: Number(p["version"] ?? 1) + 1,
        });
        return {
          decision: { kind: "EXECUTE" },
          result: { refundAmountCentavos, newStatus: "refunded" },
        };
      },
      transitionStatusFromEnvelope: async (envelope: {
        payload: { paymentId?: string; newStatus?: string };
      }) => {
        const paymentId = envelope.payload.paymentId;
        const p = paymentId === undefined ? undefined : paymentRowsFake.rows.get(paymentId);
        if (p !== undefined && paymentId !== undefined) {
          paymentRowsFake.rows.set(paymentId, {
            ...p,
            status: envelope.payload.newStatus ?? "pay_canceled",
          });
        }
        return { decision: { kind: "EXECUTE" }, result: { newStatus: "pay_canceled" } };
      },
    }),
  };
});

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeCartFixture,
  makeMedusaFetchFake,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
  CUSTOMER_ROUTER,
} = await import("./customer-e2e-harness.js");
type CustomerChannel = import("./customer-e2e-harness.js").CustomerChannel;
type ScriptedToolCall = import("./customer-e2e-harness.js").ScriptedToolCall;

const { rk } = await import("@ibatexas/tools");
const { loadCartCtx, loadOrderCtx, resolveAndAssemble, previousOrderCtxFields } =
  await import("../claustrum/resolve-and-assemble.js");
const { loadPreviousOrder } = await import("../claustrum/previous-order.js");
const { projectWorkflowFacts } = await import("../claustrum/workflow/workflow-facts.js");
const { createWorkflowRuntime } = await import("../claustrum/workflow/workflow-runtime.js");
const {
  ORDER_CTX_ACTIVITY_KINDS,
  actorIdentityBase,
  activityIdentityBase,
  activitySessionArg,
  resolveActivityTool,
  stampOrderActivityPayload,
} = await import("../claustrum/workflow/workflow-composition.js");
const { workflowTrace } = await import("../claustrum/workflow/workflow-trace.js");
const { currentWorkflowChannel } = await import("../claustrum/workflow/workflow-turn.js");
const { executeOrderCancel } = await import("../routes/order-actions.js");
const { renderCustomerActionAnswer } = await import("../claustrum/customer-action-render.js");
const { PAID_CANCEL_WORKFLOW_ID, WORKFLOW_DEFINITIONS } = await import("@ibatexas/catalog");
const { paidCancelConfirmText } = await import("@ibatexas/pack-orders");
const { adjudicateAndAudit } = await import("@adjudicate/core/kernel");
const { buildLanguageEngineAuditMetadata } = await import(
  "../claustrum/language-engine/audit-metadata.js"
);
const domain = await import("@ibatexas/domain");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CUSTOMER = "cus_le2024_owner";
const CONVERSATION = "conv_le2024";
const CART_ID = "cart_le2024_session";
const ORDER_ID = "order_le2024_target";
const PAYMENT_ID = "pay_le2024";

/**
 * THE MONEY BAND, restated here ONLY as the number the fixtures sit around.
 * `ESCALATE_REFUND_THRESHOLD_CENTAVOS` is R$1.000 and the comparator is `>=`, so
 * the three fixtures below are the boundary and its two neighbours — which is
 * what makes the exact-threshold case a real test rather than a spot check.
 */
const BAND = 100_000;
/** R$999,99 — one centavo BELOW the band. CONFIRMs. */
const JUST_UNDER = BAND - 1;
/** R$1.000,00 — EXACTLY the band. ESCALATEs, because the comparator is `>=`. */
const EXACTLY_AT = BAND;
/** R$120 — comfortably sub-band, the ordinary paid-cancel shape. */
const SUB_BAND = 12_000;

const ORDER_LINES = [
  {
    productId: "prod_costela",
    variantId: "var_costela",
    title: "Costela bovina defumada",
    quantity: 2,
    priceInCentavos: 4500,
  },
  {
    productId: "prod_pao",
    variantId: "var_pao",
    title: "Pão de alho",
    quantity: 1,
    priceInCentavos: 3000,
  },
];

function orderRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    displayId: 4120,
    customerId: CUSTOMER,
    totalInCentavos: SUB_BAND,
    paymentStatus: "paid",
    paymentMethod: "card",
    fulfillmentStatus: "confirmed",
    itemsJson: ORDER_LINES,
    version: 1,
    medusaCreatedAt: new Date("2026-07-25T18:00:00Z"),
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    status: "paid",
    amountInCentavos: SUB_BAND,
    refundedAmountCentavos: 0,
    method: "card",
    version: 1,
    ...overrides,
  };
}

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2024";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/** Layered over the harness's base fake, which throws on anything unrouted. */
function withCancelRoutes(
  base: ReturnType<typeof makeMedusaFetchFake>,
): ReturnType<typeof makeMedusaFetchFake> {
  const json = (payload: unknown): unknown => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  return {
    calls: base.calls,
    fetch: async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();

      // Both write paths end at Medusa's native cancel.
      if (method === "POST" && /^\/admin\/orders\/[^/]+\/cancel$/.test(path)) {
        base.calls.push({ method, path });
        const row = orderRowsFake.rows.find((r) => r["id"] === ORDER_ID);
        if (row !== undefined) row["fulfillmentStatus"] = "canceled";
        return json({ order: { id: ORDER_ID, status: "canceled" } });
      }
      const orderMatch = /^\/admin\/orders\/([^/]+)$/.exec(path);
      if (method === "GET" && orderMatch !== null) {
        base.calls.push({ method, path });
        const row = orderRowsFake.rows.find((r) => r["id"] === orderMatch[1]);
        if (row === undefined) return { ok: false, status: 404, text: async () => "not found" };
        return json({
          order: {
            customer_id: CUSTOMER,
            items: (row["itemsJson"] as typeof ORDER_LINES).map((i) => ({
              variant_id: i.variantId,
              quantity: i.quantity,
              title: i.title,
            })),
          },
        });
      }
      return base.fetch(input, init);
    },
  };
}

/**
 * The AUT-017-shaped handoff double: PARKS the full envelope, then PUBLISHES,
 * exactly as `natsHandoff(publish, parkDeps)` does — and, like the real one,
 * never throws.
 *
 * ONE double is wired into BOTH the conductor's `handoff` (the direct plane's
 * escalation seam) and the runtime's `escalationHandoff` (the workflow plane's),
 * so "what reached staff" is a single comparable list whichever path produced it.
 */
function makeParkingHandoff(): {
  parked: { kind: string; actorId: unknown; reason: string }[];
  queue: (
    envelope: { readonly kind: unknown; readonly payload?: unknown },
    reason: string,
  ) => Promise<void>;
} {
  const parked: { kind: string; actorId: unknown; reason: string }[] = [];
  return {
    parked,
    // Typed STRUCTURALLY rather than as `never`: this double is handed to the
    // conductor's real `handoff` port, whose parameter is a genuine
    // `IntentEnvelope`, so a `never` parameter does not satisfy it. Reading only
    // the two fields the assertions need keeps it a double rather than a second
    // implementation of the port.
    queue: async (envelope, reason) => {
      const payload = (envelope.payload ?? {}) as { actorId?: unknown };
      parked.push({ kind: String(envelope.kind), actorId: payload.actorId, reason });
    },
  };
}

// ── The two harnesses, over ONE fixture set ───────────────────────────────────

/** Which path a run drives. The suite's whole vocabulary. */
type Path = "direct" | "workflow";

interface HarnessOpts {
  readonly path: Path;
  readonly total?: number;
  readonly orders?: readonly Record<string, unknown>[];
  readonly payments?: readonly Record<string, unknown>[];
  readonly channel?: CustomerChannel;
  /**
   * LE2-024 — put an EXPLICIT order id on the direct path's `express_intent`
   * payload, as a customer naming their order produces.
   *
   * It changes the direct ladder materially, which is the point: with a named
   * target `resolve-and-assemble` stamps no `autoResolvedMoneyRef`, the composed
   * router's blind-resolution confirm never fires, and `gatePaidCancel`'s own
   * sentence becomes the question the customer actually READS. That is the only
   * shape in which the two paths' money question can be compared byte-for-byte.
   */
  readonly directOrderId?: string;
}

/**
 * The DIRECT plane's tool call: the model names the capability and supplies no
 * identifier. The order id is auto-resolved by `resolve-and-assemble`, which is
 * how a directly-parsed cancel has always found its target.
 */
function directCall(orderId?: string): ScriptedToolCall {
  return {
    id: "tc-direct-cancel",
    name: "express_intent",
    input: {
      capability: "order.cancel",
      payload: {
        reason: "Cancelado a pedido do cliente",
        ...(orderId === undefined ? {} : { orderId }),
      },
    },
  };
}

/**
 * The WORKFLOW plane's tool call: the model names the WORKFLOW and nothing else.
 * This workflow declares no slots, so there is no value for a model to supply —
 * which is the strongest form of the anti-confabulation property and the reason
 * the input carries an empty `slots`.
 */
const WORKFLOW_CALL: ScriptedToolCall = {
  id: "tc-workflow-cancel",
  name: "start_workflow",
  input: { workflow: PAID_CANCEL_WORKFLOW_ID, slots: {} },
};

async function projectAnchorState(
  kind: string,
  payload: Record<string, unknown>,
  opts: { readonly resume?: boolean; readonly channel?: CustomerChannel } = {},
): Promise<unknown> {
  const resolved = await resolveAndAssemble({
    kind,
    payload,
    customerId: CUSTOMER,
    channel: opts.channel ?? "web",
    ...(opts.resume === true ? {} : { sessionId: CONVERSATION }),
  } as never);
  return { ctx: resolved.ctx };
}

function buildHarness(opts: HarnessOpts) {
  const total = opts.total ?? SUB_BAND;
  orderRowsFake.rows = [...(opts.orders ?? [orderRow({ totalInCentavos: total })])];
  paymentRowsFake.rows = new Map(
    (opts.payments ?? [paymentRow({ amountInCentavos: total })]).map((p) => [
      String(p["id"]),
      { ...p },
    ]),
  );

  const cart = makeCartFixture({ id: CART_ID });
  const medusa = withCancelRoutes(makeMedusaFetchFake(cart));
  vi.stubGlobal("fetch", medusa.fetch);
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const handoff = makeParkingHandoff();
  const channel = opts.channel ?? "web";

  const model = scriptedModel([
    opts.path === "direct" ? directCall(opts.directOrderId) : WORKFLOW_CALL,
  ]);
  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: async (envelope) =>
      projectAnchorState(
        String(envelope.kind),
        (envelope.payload ?? {}) as Record<string, unknown>,
        { resume: true, channel },
      ) as never,
  });

  // The DIRECT path composes NO workflow runtime — that is what makes it the
  // pre-LE2-024 composition rather than a workflow run in disguise.
  if (opts.path === "direct") {
    const harness = composeCustomerConductor({
      model,
      session,
      adjudicator,
      handoff,
      withWhatsApp: true,
      realResponder: true,
      readAnswer: {
        render: () => undefined,
        renderAction: (acted: unknown) => renderCustomerActionAnswer(acted),
      },
    });
    return { harness, sink, session, handoff, medusa, model, runtime: undefined };
  }

  // ── The production workflow composition, rebuilt from its EXTRACTED decisions ──

  const activityState = async (envelope: {
    kind: unknown;
    payload?: unknown;
    actor?: unknown;
  }): Promise<unknown> => {
    const identity = activityIdentityBase(
      envelope as never,
      currentWorkflowChannel(),
      process.env.KERNEL_TENANT_ID,
    );
    if (ORDER_CTX_ACTIVITY_KINDS.has(String(envelope.kind))) {
      const payload = (envelope.payload ?? {}) as { orderId?: unknown };
      const orderId = typeof payload.orderId === "string" ? payload.orderId : null;
      return { ctx: await loadOrderCtx(identity as never, identity.customerId ?? "", orderId) };
    }
    return {
      ctx: await loadCartCtx(
        identity as never,
        (envelope.payload ?? {}) as never,
        activitySessionArg(envelope as never),
      ),
    };
  };

  const workflowFacts = async (
    actor: { customerId?: string; sessionId?: string },
    _slots: Record<string, unknown>,
  ) => {
    const identity = actorIdentityBase(
      actor,
      currentWorkflowChannel(),
      process.env.KERNEL_TENANT_ID,
    );
    const sessionId = actor.sessionId;
    const ctx = (await loadCartCtx(
      identity as never,
      {} as never,
      sessionId === undefined ? {} : { sessionId },
    )) as Record<string, unknown>;
    const previous =
      identity.customerId === null ? null : await loadPreviousOrder(identity.customerId);
    return projectWorkflowFacts({ ...ctx, ...previousOrderCtxFields(previous) });
  };

  const resolveActivityPayload = async (args: {
    capability: string;
    payload: Readonly<Record<string, unknown>>;
    actor: { customerId?: string; sessionId?: string };
  }) => {
    const identity = actorIdentityBase(
      args.actor,
      currentWorkflowChannel(),
      process.env.KERNEL_TENANT_ID,
    );
    if (!ORDER_CTX_ACTIVITY_KINDS.has(args.capability)) return args.payload;
    const previous =
      identity.customerId === null ? null : await loadPreviousOrder(identity.customerId);
    return stampOrderActivityPayload({
      capability: args.capability,
      payload: args.payload,
      customerId: identity.customerId,
      orderId: previous?.orderId,
    });
  };

  /** `buildWorkflowRuntime`'s `dispatchOrderCancel` — the REAL refund-first path. */
  const dispatchOrderCancel = async (envelope: { payload?: unknown }): Promise<unknown> => {
    const payload = (envelope.payload ?? {}) as {
      orderId?: unknown;
      actorId?: unknown;
      reason?: unknown;
    };
    const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
    const customerId = typeof payload.actorId === "string" ? payload.actorId : "";
    if (orderId === "" || customerId === "") {
      throw new Error(
        "[workflow] order.cancel activity reached dispatch without a resolved orderId/actorId",
      );
    }
    const order = (await domain.createOrderQueryService().getById(orderId, {
      customerId,
    })) as unknown as { fulfillmentStatus: string; displayId: number } | null;
    if (order === null) {
      throw new Error(`[workflow] order.cancel activity: order ${orderId} not readable`);
    }
    return executeOrderCancel({
      orderId,
      customerId,
      reason:
        typeof payload.reason === "string" && payload.reason !== ""
          ? payload.reason
          : "Cancelado para aplicar cupom",
      order,
      orderCmdSvc: domain.createOrderCommandService(),
      paymentCmdSvc: domain.createPaymentCommandService(),
      paymentQuerySvc: domain.createPaymentQueryService(),
      log: console as never,
    });
  };

  const harnessRef: { current?: ReturnType<typeof composeCustomerConductor> } = {};
  const runtime = createWorkflowRuntime({
    workflows: WORKFLOW_DEFINITIONS,
    projectFacts: async ({ actor, slots }) => workflowFacts(actor as never, slots as never),
    resolveActivityPayload: resolveActivityPayload as never,
    escalationHandoff: handoff as never,
    adjudicateActivity: async (envelope, callOpts) =>
      (
        await adjudicateAndAudit(
          envelope,
          (await activityState(envelope as never)) as never,
          CUSTOMER_ROUTER as never,
          {
            sink,
            metadataProvider: buildLanguageEngineAuditMetadata,
            ...(callOpts?.confirmationReceipt
              ? { confirmationReceipt: callOpts.confirmationReceipt as never }
              : {}),
          },
        )
      ).decision,
    dispatchActivity: async (envelope, ctx) =>
      String(envelope.kind) === "order.cancel"
        ? dispatchOrderCancel(envelope as never)
        : resolveActivityTool(harnessRef.current?.tools, envelope, ctx).execute(
            envelope.payload,
            ctx,
          ),
  });

  const harness = composeCustomerConductor({
    model,
    session,
    adjudicator,
    handoff,
    workflowRuntime: runtime,
    withWhatsApp: true,
    realResponder: true,
    readAnswer: {
      render: () => undefined,
      renderAction: (acted: unknown) => renderCustomerActionAnswer(acted),
    },
  });
  harnessRef.current = harness;
  return { harness, sink, session, handoff, medusa, model, runtime };
}

// ── THE OBSERVATION — what "same behaviour" is allowed to mean ────────────────

/**
 * A path-independent record of what a run DID, comparable across the two paths.
 *
 * Every field is something a customer or an operator can actually perceive.
 * There is deliberately NO field for anything internal to one path — no anchor
 * rows, no instance ids, no trace shape — because a diff over those would report
 * differences that are true and meaningless, and a parity table nobody believes
 * is worse than none.
 */
interface Observation {
  /** The customer-facing text of every turn, in order. */
  readonly renders: readonly string[];
  /** How many turns the path needed before it stopped asking. */
  readonly turns: number;
  /** `order.cancel` decision kinds, in the order the kernel wrote them. */
  readonly cancelDecisions: readonly string[];
  /**
   * THE PAID-CANCEL LADDER — the comparable spine of the two paths.
   *
   * `order.cancel`'s rows with the AUTO-RESOLVE CONFIRM removed, each rendered
   * `KIND/reason`. The removal is the suite's one deliberate normalization and it
   * is a measured fact rather than a convenience: a directly-parsed cancel names
   * no order, so the composed router's `confirmOnAutoResolvedRef` asks "is this
   * the most recent one?" BEFORE the money ladder is ever reached. The workflow
   * resolves its target from the owner-scoped previous-order projection instead,
   * so that guard never fires — `autoResolvedMoneyRef` is not a field
   * `loadOrderCtx` stamps.
   *
   * That extra row is a real difference and it is asserted directly, in its own
   * case, rather than being quietly absorbed here. What this field isolates is
   * the question the ticket is actually about: given the same order, does the
   * MONEY ladder reach the same verdicts?
   */
  readonly paidLadder: readonly string[];
  /** Every question `order.cancel` asked the customer, in order. */
  readonly cancelPrompts: readonly string[];
  /** What reached the staff handoff: `kind` per parked envelope. */
  readonly parkedKinds: readonly string[];
  /** The BKL-103 proposer stamp on each parked envelope. */
  readonly parkedActorIds: readonly unknown[];
  /** Terminal store state — the money question, asked of the store itself. */
  readonly orderStatus: string;
  readonly paymentStatus: string;
  readonly refundedCentavos: number;
}

/** The composed router's blind-resolution confirm — see {@link Observation.paidLadder}. */
const AUTO_RESOLVE_PROMPT = "Identifiquei o seu pedido mais recente";

function basisOf(decision: unknown): readonly { category?: string; code?: string; detail?: unknown }[] {
  const basis = (decision as { basis?: unknown }).basis;
  return Array.isArray(basis) ? (basis as never[]) : [];
}

function reasonOf(decision: unknown): string {
  for (const entry of basisOf(decision)) {
    const detail = entry.detail;
    if (detail === null || typeof detail !== "object") continue;
    const reason = (detail as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason !== "") return reason;
  }
  return "";
}

/** The customer-facing question a decision carries, wherever its shape puts it. */
function promptOf(decision: unknown): string {
  const d = decision as {
    prompt?: unknown;
    userFacing?: unknown;
    refusal?: { userFacing?: unknown };
    confirmation?: { prompt?: unknown };
  };
  for (const candidate of [d.prompt, d.confirmation?.prompt, d.refusal?.userFacing, d.userFacing]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return "";
}

function observe(
  sink: ReturnType<typeof makeCapturingAuditSink>,
  handoff: ReturnType<typeof makeParkingHandoff>,
  renders: readonly string[],
): Observation {
  const cancelRows = sink.byKind("order.cancel");
  const order = orderRowsFake.rows.find((r) => r["id"] === ORDER_ID);
  const payment = paymentRowsFake.rows.get(PAYMENT_ID);
  return {
    renders,
    turns: renders.length,
    cancelDecisions: cancelRows.map((r) => String(r.decision.kind)),
    paidLadder: cancelRows
      .filter((r) => !promptOf(r.decision).startsWith(AUTO_RESOLVE_PROMPT))
      .map((r) => `${String(r.decision.kind)}/${reasonOf(r.decision)}`),
    cancelPrompts: cancelRows.map((r) => promptOf(r.decision)),
    parkedKinds: handoff.parked.map((p) => p.kind),
    parkedActorIds: handoff.parked.map((p) => p.actorId),
    orderStatus: String(order?.["fulfillmentStatus"] ?? "absent"),
    paymentStatus: String(payment?.["status"] ?? "absent"),
    refundedCentavos: Number(payment?.["refundedAmountCentavos"] ?? 0),
  };
}

/**
 * Drive ONE path to completion and observe it.
 *
 * Both paths are two-turn flows in the confirming case ("cancela…" then "sim"),
 * and BOTH are driven with the same two utterances. `answer` is passed even on
 * runs that never park, because a turn that had nothing to answer is itself an
 * observation — it lands in `renders` and shows up in the diff.
 */
async function drive(
  opts: HarnessOpts & { readonly answer?: string },
): Promise<Observation & { readonly turnIds: readonly string[] }> {
  const { harness, sink, handoff, runtime } = buildHarness(opts);
  const channel = opts.channel ?? "web";
  const renders: string[] = [];
  const turnIds: string[] = [];

  let turn = await runCustomerTurn(harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: "quero cancelar meu pedido por favor",
    channel,
  });
  renders.push(turn.response);
  turnIds.push(turn.turnId);

  // KEEP ANSWERING WHILE THE PATH IS STILL ASKING, rather than sending a fixed
  // number of turns. The two paths genuinely need different turn counts — a
  // directly-parsed cancel asks the auto-resolve question the workflow never
  // asks — and a fixed count would either cut the direct path off before it
  // reached the money ladder (making every verdict comparison vacuous) or send
  // the workflow a "sim" it has nothing to answer.
  //
  // Driving each path to ITS OWN terminal state is the only comparison that
  // means anything, and it makes the turn count itself an observation.
  //
  // The cap is a guard against a genuine confirm loop, and it is a FAILURE
  // rather than a silent stop: a path that never terminates is a defect, not a
  // shape to record.
  const MAX_TURNS = 5;
  while (
    opts.answer !== undefined &&
    String((turn.decision as { kind?: unknown }).kind ?? "") === "REQUEST_CONFIRMATION"
  ) {
    if (renders.length >= MAX_TURNS) {
      throw new Error(
        `[parity] the ${opts.path} path was still asking after ${MAX_TURNS} turns: ` +
          JSON.stringify(renders),
      );
    }
    turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: opts.answer,
      channel,
    });
    renders.push(turn.response);
    turnIds.push(turn.turnId);
  }
  void runtime;
  return { ...observe(sink, handoff, renders), turnIds };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  orderRowsFake.rows = [];
  paymentRowsFake.rows = new Map();
  natsSpy.calls = [];
  seedEnv();
});


/**
 * THE TERMINAL VERDICT — what the kernel finally said about this cancel.
 *
 * The single most comparable fact across the two paths, and the one the ticket's
 * "same decisions" criterion is really about. The full ladders legitimately
 * DIFFER in length (see the divergence suites below: the direct path's
 * `gatePaidCancel` REQUEST_CONFIRMATION is never emitted as a decision, because
 * the auto-resolve confirm parks first and one receipt then satisfies both), so
 * comparing them element-wise would report a difference that is real but is not
 * the money question.
 *
 * Where the ORDER ends up — executed, escalated, refused — and under which
 * grounded reason, is.
 */
function terminalVerdict(o: Observation): string {
  return o.paidLadder[o.paidLadder.length - 1] ?? "NONE";
}

// ── 0. THE CONFIRM SENTENCE — the byte-exact half, and who can render it ──────

describe("LE2-024 parity — the paid-cancel question is the pack's OWN sentence", () => {
  it("the workflow renders `paidCancelConfirmText` BYTE-FOR-BYTE", async () => {
    // THE TICKET'S HEADLINE CRITERION. Asserted against the pack's exported
    // function rather than a string literal, which is the whole point: a literal
    // would keep passing while `gatePaidCancel` and this workflow drifted
    // together, and "both paths agree on the wrong sentence" is exactly the
    // failure a parity pin exists to catch.
    const workflow = await drive({ path: "workflow" });
    expect(workflow.renders[0]).toBe(paidCancelConfirmText(SUB_BAND));
    expect(workflow.renders[0]).toContain("R$ 120,00");
    expect(workflow.renders[0]).toContain("reembolso");

    // `{confirmation}`-ALONE, proved at the render: any framing word the template
    // added around the placeholder would break the equality above.
    expect(workflow.renders[0]!.startsWith("Esse pedido já foi pago")).toBe(true);
    expect(workflow.renders[0]!.endsWith("confirma o cancelamento?")).toBe(true);
  });

  it("the DIRECT conversational path CANNOT render it — structurally, not by luck", async () => {
    // The finding that makes the divergence suite below more than a curiosity.
    //
    // `order.cancel` is not in `ORDER_NAMED_REFERENCE_KINDS`, so `applyAutoResolve`
    // takes the BLIND `resolveOrderId` branch and stamps `autoResolvedMoneyRef`
    // whenever it resolves — and `orderId` is an Identity-class field the parse
    // seam strips from any model-supplied payload, so a customer NAMING their
    // order cannot change that. The composed router's `confirmOnAutoResolvedRef`
    // therefore always parks FIRST, and `gatePaidCancel`'s sentence is authored,
    // audited and never shown.
    //
    // This case drives the strongest possible counter-attempt — an explicit
    // `orderId` on the `express_intent` payload, which is more than the wire ever
    // permits — and shows the auto-resolve question anyway. Without it, "the
    // direct path never states the refund" reads as an accident of this fixture
    // rather than a property of the plane.
    const { harness } = buildHarness({ path: "direct", directOrderId: ORDER_ID });
    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: `cancela o pedido ${ORDER_ID}`,
    });

    expect(turn.response).toContain(AUTO_RESOLVE_PROMPT);
    expect(turn.response).not.toBe(paidCancelConfirmText(SUB_BAND));
    expect(turn.response.startsWith("Esse pedido já foi pago")).toBe(false);
  });
});

// ── 1. THE MONEY BANDS — the core parity claim ────────────────────────────────

describe("LE2-024 parity — the same order reaches the same kernel verdict on both paths", () => {
  it("a SUB-BAND paid cancel EXECUTEs on both, under the same grounded reason", async () => {
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    expect(terminalVerdict(workflow)).toBe(terminalVerdict(direct));
    // Pinned ABSOLUTELY too, so "identical" cannot be satisfied by both paths
    // degrading to the same nothing.
    expect(terminalVerdict(direct)).toBe("EXECUTE/paid_cancel_requires_confirmation");
  });

  it("a DECLINE cancels nothing on either path", async () => {
    const direct = await drive({ path: "direct", answer: "não" });
    const workflow = await drive({ path: "workflow", answer: "não" });

    expect(direct.cancelDecisions).not.toContain("EXECUTE");
    expect(workflow.cancelDecisions).not.toContain("EXECUTE");
    expect(direct.paymentStatus).toBe("paid");
    expect(workflow.paymentStatus).toBe("paid");
    expect(direct.refundedCentavos).toBe(0);
    expect(workflow.refundedCentavos).toBe(0);
  });
});

// ── 2. THE EXACT-THRESHOLD CASE — the `>=` boundary, both paths ───────────────

describe("LE2-024 parity — the EXACT threshold escalates, and the centavo below it does not", () => {
  it("totalInCentavos === 100_000 ESCALATEs on BOTH paths — the >= boundary", async () => {
    const direct = await drive({ path: "direct", total: EXACTLY_AT, answer: "sim" });
    const workflow = await drive({ path: "workflow", total: EXACTLY_AT, answer: "sim" });

    // THE BOUNDARY. `>=` means the band INCLUDES its own threshold, and a `>`
    // regression would let exactly-R$1.000 through unescalated on both planes.
    expect(terminalVerdict(direct)).toBe(
      "ESCALATE/paid_cancel_refund_above_escalate_threshold",
    );
    expect(terminalVerdict(workflow)).toBe(terminalVerdict(direct));
    expect(direct.cancelDecisions).not.toContain("EXECUTE");
    expect(workflow.cancelDecisions).not.toContain("EXECUTE");

    // Nothing moved, on either path — no cancel, and no money returned.
    expect(direct.refundedCentavos).toBe(0);
    expect(workflow.refundedCentavos).toBe(0);
    expect(direct.paymentStatus).toBe("paid");
    expect(workflow.paymentStatus).toBe("paid");
  });

  it("CONTROL — one centavo BELOW the band executes on BOTH paths", async () => {
    // De-vacuums the case above: without this, "escalates at 100_000" would be
    // indistinguishable from "escalates at every paid total".
    const direct = await drive({ path: "direct", total: JUST_UNDER, answer: "sim" });
    const workflow = await drive({ path: "workflow", total: JUST_UNDER, answer: "sim" });

    expect(terminalVerdict(direct)).toBe("EXECUTE/paid_cancel_requires_confirmation");
    expect(terminalVerdict(workflow)).toBe(terminalVerdict(direct));
    expect(direct.cancelDecisions).not.toContain("ESCALATE");
    expect(workflow.cancelDecisions).not.toContain("ESCALATE");
    expect(direct.parkedKinds).toEqual([]);
    expect(workflow.parkedKinds).toEqual([]);
  });

  it("the ESCALATE parks the SAME kind with the SAME proposer stamp on both paths", async () => {
    // THE BKL-103 CONTRACT, and the reason the workflow's escalate band lives at
    // the ACTIVITY rather than at the anchor. What staff can act on must be an
    // `order.cancel` carrying the proposer — on either path, or the approve
    // route 404s and the customer was promised a review nobody can perform.
    const direct = await drive({ path: "direct", total: EXACTLY_AT, answer: "sim" });
    const workflow = await drive({ path: "workflow", total: EXACTLY_AT, answer: "sim" });

    expect(direct.parkedKinds).toEqual(["order.cancel"]);
    expect(workflow.parkedKinds).toEqual(direct.parkedKinds);

    // The stamp `ESCALATION_PROPOSER_STAMPS` reads to make the park resumable.
    expect(direct.parkedActorIds).toEqual([CUSTOMER]);
    expect(workflow.parkedActorIds).toEqual([CUSTOMER]);

    // NOT the anchor. If this ever reads `order.cancel.request`, the escalation
    // has moved to the anchor and the approve path can no longer act on it.
    expect(workflow.parkedKinds).not.toContain("order.cancel.request");
  });

  it("the workflow reaches the `escalated` OUTCOME, not `failed`", async () => {
    // `failed` means NOTHING ran, which is literally true here and still a lie
    // about the future: an owner may approve minutes later.
    const { harness } = buildHarness({ path: "workflow", total: EXACTLY_AT });
    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "quero cancelar meu pedido por favor",
    });
    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });
    expect(workflowTrace(turn2.turnId)?.run.outcome).toBe("escalated");
  });
});

// ── 3. CROSS-CHANNEL — the ladder behaves identically on every plane ──────────

describe("LE2-024 parity — cross-channel: web and WhatsApp are the same ladder", () => {
  it("the SUB-BAND verdict is identical on web and WhatsApp, on BOTH paths", async () => {
    const directWeb = await drive({ path: "direct", answer: "sim", channel: "web" });
    const directWa = await drive({ path: "direct", answer: "sim", channel: "whatsapp" });
    const workflowWeb = await drive({ path: "workflow", answer: "sim", channel: "web" });
    const workflowWa = await drive({ path: "workflow", answer: "sim", channel: "whatsapp" });

    // Within a path, the channel changes nothing.
    expect(terminalVerdict(directWa)).toBe(terminalVerdict(directWeb));
    expect(terminalVerdict(workflowWa)).toBe(terminalVerdict(workflowWeb));

    // Across paths, on the SAME channel — the parity claim, restated per plane.
    expect(terminalVerdict(workflowWeb)).toBe(terminalVerdict(directWeb));
    expect(terminalVerdict(workflowWa)).toBe(terminalVerdict(directWa));

    // NON-VACUOUS: the verdict is the real one, not an empty default.
    expect(terminalVerdict(workflowWa)).toBe("EXECUTE/paid_cancel_requires_confirmation");

    // And the workflow's confirm sentence is byte-identical across channels —
    // the money copy is not channel-conditional.
    expect(workflowWa.renders[0]).toBe(workflowWeb.renders[0]);
    expect(workflowWa.renders[0]).toBe(paidCancelConfirmText(SUB_BAND));
  });

  it("the ESCALATE band is the same on WhatsApp as on web, on BOTH paths", async () => {
    const directWa = await drive({
      path: "direct",
      total: EXACTLY_AT,
      answer: "sim",
      channel: "whatsapp",
    });
    const workflowWa = await drive({
      path: "workflow",
      total: EXACTLY_AT,
      answer: "sim",
      channel: "whatsapp",
    });

    expect(terminalVerdict(directWa)).toBe(
      "ESCALATE/paid_cancel_refund_above_escalate_threshold",
    );
    expect(terminalVerdict(workflowWa)).toBe(terminalVerdict(directWa));
    expect(directWa.parkedKinds).toEqual(["order.cancel"]);
    expect(workflowWa.parkedKinds).toEqual(["order.cancel"]);
    expect(workflowWa.refundedCentavos).toBe(0);
  });
});

// ── 4. THE PONR REFUSAL — the same fact, from the same factory ────────────────

describe("LE2-024 parity — a PAST-PONR order is refused on both paths", () => {
  it("both name the point of no return, and neither cancels anything", async () => {
    const past = [orderRow({ fulfillmentStatus: "delivered" })];
    const direct = await drive({ path: "direct", orders: past, answer: "sim" });
    const workflow = await drive({ path: "workflow", orders: past, answer: "sim" });

    // The workflow refuses BEFORE any envelope exists (its pre-check), the
    // direct path refuses AT `requireCancellable`. Different moments, same fact,
    // and both name the point of no return in the customer's own language.
    expect(direct.renders.join(" ")).toContain("ponto de cancelamento");
    expect(workflow.renders.join(" ")).toContain("ponto de cancelamento");

    expect(direct.cancelDecisions).not.toContain("EXECUTE");
    expect(workflow.cancelDecisions).not.toContain("EXECUTE");
    expect(direct.refundedCentavos).toBe(0);
    expect(workflow.refundedCentavos).toBe(0);
  });
});

// ── 5. THE UNPAID PATH — no money question on either side ────────────────────

describe("LE2-024 parity — an UNPAID cancel asks no money question on either path", () => {
  it("neither path states a refund consequence; both reach EXECUTE", async () => {
    // The reason `confirmPaidCancel` returns null for an unpaid order rather
    // than asking anyway. A workflow that added a money confirm here would be a
    // re-platform that changed the thing it was pinning.
    const unpaid = [orderRow({ paymentStatus: "pending" })];
    const payments = [paymentRow({ status: "pending" })];

    const direct = await drive({ path: "direct", orders: unpaid, payments, answer: "sim" });
    const workflow = await drive({ path: "workflow", orders: unpaid, payments, answer: "sim" });

    expect(terminalVerdict(direct)).toBe("EXECUTE/");
    expect(terminalVerdict(workflow)).toBe("EXECUTE/");
    expect(direct.renders.some((r) => r.includes("confirma o cancelamento?"))).toBe(false);
    expect(workflow.renders.some((r) => r.includes("confirma o cancelamento?"))).toBe(false);

    // The workflow needs ONE turn here: its anchor guard returns null, so the
    // anchor EXECUTEs on the selecting turn and the activity runs behind it.
    expect(workflow.turns).toBe(1);
  });
});

// ── 6. THE MEASURED DIVERGENCES — asserted as facts, not tolerated as gaps ────

describe("LE2-024 divergence — only the WORKFLOW ever SHOWS the paid-cancel question", () => {
  it("the direct path never states the refund consequence it then acts on", async () => {
    // THE MOST IMPORTANT MEASUREMENT IN THIS FILE.
    //
    // On the direct plane the composed router's `confirmOnAutoResolvedRef` parks
    // FIRST — "is this your most recent order?" — and the customer's "sim" mints
    // ONE confirmation receipt against that envelope's hash. On the resume,
    // `gatePaidCancel` does fire and does return REQUEST_CONFIRMATION, and the
    // kernel's receipt override converts it straight to EXECUTE. Its sentence is
    // therefore authored, audited, and NEVER RENDERED: the row carries
    // `paid_cancel_requires_confirmation` for a question nobody was asked.
    //
    // A receipt is scoped to an intent hash, not to a QUESTION, so one "sim"
    // answers every confirm the same envelope can raise. That is a property of
    // the direct path this ticket did not create and does not fix; it is
    // measured here because it is the strongest evidence on the retirement
    // question, and because a silent change to it must break this test.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    // The direct customer is asked about the ORDER, never about the MONEY…
    expect(direct.renders[0]).toContain(AUTO_RESOLVE_PROMPT);
    expect(direct.renders.some((r) => r.startsWith("Esse pedido já foi pago"))).toBe(false);
    // …and yet the executed row cites the paid-cancel confirm as its reason.
    expect(terminalVerdict(direct)).toBe("EXECUTE/paid_cancel_requires_confirmation");

    // The workflow states it, byte-for-byte as the pack authors it, BEFORE
    // acting — and its coverage names that one reason explicitly.
    expect(workflow.renders[0]).toBe(paidCancelConfirmText(SUB_BAND));
    expect(workflow.renders[0]).toContain("R$ 120,00");
    expect(workflow.renders[0]).toContain("reembolso");
    expect(workflow.renders.some((r) => r.includes(AUTO_RESOLVE_PROMPT))).toBe(false);
  });

  it("the workflow's single question omits the order NUMBER the direct path verifies", async () => {
    // The cost of byte-exact confirm parity, stated rather than buried. The
    // direct path's first question establishes WHICH order; the workflow's
    // quotes the amount but no identifier, because it reuses `gatePaidCancel`'s
    // sentence verbatim and that sentence names no order.
    //
    // Adding one would break the byte-exact parity that is this ticket's own
    // acceptance criterion, so it is an OWNER COPY QUESTION and not a fix a
    // worker may take unilaterally.
    const workflow = await drive({ path: "workflow", answer: "sim" });
    expect(workflow.renders[0]).not.toContain("4120");
  });
});

describe("LE2-024 divergence — the WORKFLOW refunds a paid cancel and the DIRECT path does not", () => {
  it("is a DEFECT IN THE OLD PATH, measured here rather than reproduced", async () => {
    // `order.cancel`'s registered tool is `cancelOrder`, whose
    // `cancelActivePaymentForOrder` returns early for a settled payment — no
    // refund, no error, nothing in any log. The workflow dispatches
    // `executeOrderCancel`, which adjudicates a `payment.refund.issue` BEFORE
    // any order transition and throws if it does not settle.
    //
    // Pinned in BOTH directions: if the direct path is ever fixed, this test
    // goes red and somebody re-reads the retirement note.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    // Both reached EXECUTE on the same order…
    expect(terminalVerdict(direct)).toBe(terminalVerdict(workflow));

    // …and only ONE of them gave the customer their money back.
    expect(workflow.paymentStatus).toBe("refunded");
    expect(workflow.refundedCentavos).toBe(SUB_BAND);
    expect(direct.paymentStatus).toBe("paid");
    expect(direct.refundedCentavos).toBe(0);
  });

  it("and only the workflow's cancel reaches the DOMAIN order projection", async () => {
    // The second half of the same write-path split. `cancelOrder` cancels in
    // Medusa only; the domain `OrderProjection` row is updated by a subscriber
    // that does not run here (and, in production, runs later). `executeOrderCancel`
    // transitions the projection itself, through the kernel.
    //
    // Recorded because it is what makes `orderStatus` an unfair cross-path
    // comparison, which is worth knowing before anyone writes another one.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    expect(workflow.orderStatus).toBe("canceled");
    expect(direct.orderStatus).toBe("confirmed");
  });
});

describe("LE2-024 divergence — the SUCCESS render is model prose on the direct path", () => {
  it("the workflow's is an AUTHORED template; the direct path's is not first-party", async () => {
    // `customer-action-render.ts` declares no branch for `order.cancel` (its own
    // header notes `reservation.cancel` "keeps its model-prose success"), so the
    // deterministic action render yields nothing and the responder MODEL authors
    // the reply. Here that surfaces as the scripted model's `responderText`.
    //
    // The workflow renders its `completed` template verbatim through the LE2-021
    // outcome seam, so no probabilistic model touches the sentence.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    // MODEL-AUTHORED on the direct path — the scripted stand-in for prose.
    expect(direct.renders[direct.turns - 1]).toBe("Ok.");

    // AUTHORED TEMPLATE on the workflow path, verbatim from the catalog.
    expect(workflow.renders[workflow.turns - 1]).toBe(
      "Pronto, cancelei seu pedido. O reembolso já foi solicitado e o valor volta pra você pelo mesmo meio de pagamento.",
    );
  });
});

// ── 7. THE ANCHOR'S ACCESS CLASS — it must never reach the model ──────────────

describe("LE2-024 — the anchor is never on the capability wire", () => {
  it("`order.cancel.request` is never offered to the model, but the WORKFLOW is", async () => {
    const { harness, model } = buildHarness({ path: "workflow" });
    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "quero cancelar meu pedido por favor",
    });

    // Read the ACTUAL planner request — the wire, not the catalog's opinion of
    // it. A catalog-only assertion would pass while the anchor leaked onto the
    // surface through some other seam.
    const plannerCall = (
      model.complete as unknown as { mock: { calls: [{ tools?: { name: string }[] }][] } }
    ).mock.calls.find((c) => (c[0]?.tools?.length ?? 0) > 0)?.[0];
    const expressIntent = plannerCall?.tools?.find((t) => t.name === "express_intent");
    const advertised = JSON.stringify(expressIntent ?? {});

    // The anchor is identity-tier: the parser never picks it by name.
    expect(advertised).not.toContain("order.cancel.request");
    // The CONTROL — `order.cancel` itself IS advertised, so the assertion above
    // is about the access class and not about an empty roster.
    expect(advertised).toContain("order.cancel");

    // …and the WORKFLOW is on the wire, with its production-grounded phrasings.
    const startWorkflow = plannerCall?.tools?.find((t) => t.name === "start_workflow");
    const description = String((startWorkflow as { description?: unknown })?.description);
    expect(description).toContain(PAID_CANCEL_WORKFLOW_ID);
    expect(description).toContain("cancela o último pedido");
  });
});

