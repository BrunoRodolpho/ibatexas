/**
 * LE2-023 turn-seam e2e — the SWAP-FOR-COUPON workflow, driven through a REAL
 * `handleTurn`.
 *
 * Sibling of `reorder-last-workflow.e2e.test.ts`, and a separate file for the
 * same reason that one is separate from `workflow-runtime.e2e.test.ts`: this
 * drives `WORKFLOW_DEFINITIONS`' SECOND entry — the destructive one — and its
 * job is to prove the ROUTE a customer will actually take when they ask to
 * cancel a real, possibly-paid order and rebuild it with a coupon.
 *
 * Mocks sit at the client boundary only: Redis, Stripe, Medusa's `fetch`,
 * `@ibatexas/domain`'s order/payment services (there is no Postgres here) and
 * the NATS publisher. Above those, everything is production: the real planner,
 * the real `resolve-and-assemble` RESOLVE stage — so `stampPreviousOrderCtx` and
 * `stampCouponSwapCtx` genuinely run and genuinely stamp the ctx
 * `confirmSwapForCoupon` reads — the real composed policy router, the real
 * `adjudicateAndAudit`, the real tool registry, the real
 * `WebConfirmChannel.matchToParked`, and the REAL `executeOrderCancel` money
 * path.
 *
 * ── WHY THE RUNTIME IS COMPOSED FROM THE EXTRACTED DECISIONS ─────────────────
 *
 * `buildWorkflowRuntime` lives in `claustrum-bootstrap.ts` and importing it
 * would drag the whole composition root (pg pool, `requireEnv` gates) into a
 * unit test. So this file composes the same runtime — but every part of that
 * composition that is a DECISION rather than glue is imported from
 * `workflow/workflow-composition.ts` (`ORDER_CTX_ACTIVITY_KINDS`,
 * `stampOrderActivityPayload`, `activityIdentityBase`, `actorIdentityBase`,
 * `resolveActivityTool`) and the reads are the same production functions
 * (`loadCartCtx`, `loadOrderCtx`, `loadPreviousOrder`, `projectCouponForOrder`,
 * `executeOrderCancel`). That is exactly the split that module was extracted to
 * create: the glue may be rebuilt here, the decisions may not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake, orderRowsFake, paymentRowsFake, natsSpy } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    /** The domain `OrderProjection` rows this run's customer owns. */
    orderRowsFake: { rows: [] as Record<string, unknown>[] },
    /** The domain `Payment` rows, by id. */
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
      confirm: vi.fn().mockResolvedValue({ id: "pi_le2023", status: "succeeded" }),
      update: vi.fn().mockResolvedValue({ id: "pi_le2023" }),
      retrieve: vi.fn().mockResolvedValue({ id: "pi_le2023" }),
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
 * The domain doubles. `listByCustomer` reproduces the PRISMA ORDERING
 * (`medusaCreatedAt desc`) rather than insertion order, because
 * `loadPreviousOrder` takes `orders[0]` of a `limit: 1` read — "the previous
 * order" IS that sort, and a mock that returned insertion order would make the
 * resequencing case below prove nothing.
 *
 * The command services mutate the same row maps, so the cancel's effects are
 * visible to every later read in the same turn — which is the whole point of
 * the resequencing scenario.
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
        if (row === undefined) {
          return { decision: { kind: "REFUSE" }, result: null };
        }
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
        // The INJECTED band. A test that wants the refund NOT to settle sets
        // this on the row; everything else settles, which is production's own
        // sub-threshold behaviour.
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
      transitionStatusFromEnvelope: async () => ({
        decision: { kind: "EXECUTE" },
        result: { newStatus: "pay_canceled" },
      }),
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
const { rk } = await import("@ibatexas/tools");
const {
  loadCartCtx,
  loadOrderCtx,
  resolveAndAssemble,
} = await import("../claustrum/resolve-and-assemble.js");
const { loadPreviousOrder } = await import("../claustrum/previous-order.js");
const { previousOrderCtxFields } = await import("../claustrum/resolve-and-assemble.js");
const { projectCouponForOrder } = await import("../claustrum/coupon-price-projection.js");
const { projectWorkflowFacts } = await import("../claustrum/workflow/workflow-facts.js");
const { createWorkflowRuntime } = await import(
  "../claustrum/workflow/workflow-runtime.js"
);
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
const { renderCustomerActionAnswer } = await import(
  "../claustrum/customer-action-render.js"
);
const { CATALOG_VERSION, SWAP_FOR_COUPON_WORKFLOW_ID, WORKFLOW_DEFINITIONS } = await import(
  "@ibatexas/catalog"
);
const { adjudicateAndAudit } = await import("@adjudicate/core/kernel");
const { buildLanguageEngineAuditMetadata } = await import(
  "../claustrum/language-engine/audit-metadata.js"
);
const domain = await import("@ibatexas/domain");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CUSTOMER = "cus_le2023_owner";
const CONVERSATION = "conv_le2023";
const CART_ID = "cart_le2023_session";
const REBUILT_CART_ID = "cart_le2023_rebuilt";
const TARGET_ORDER_ID = "order_le2023_target";
const OLDER_ORDER_ID = "order_le2023_older";
const PAYMENT_ID = "pay_le2023";

/** The customer's own sentence, and one of the workflow's authored phrasings. */
const SELECT_UTTERANCE = "cancela meu pedido e faz outro igual com o cupom bemvindo10";
/** The slot value the parser extracts — lower case, as a customer types it. */
const SLOT_CODE = "bemvindo10";
/** The STORE's spelling. The confirm sentence must quote THIS one. */
const STORE_CODE = "BEMVINDO10";

/**
 * R$120 — below the R$1.000 escalate band, so the paid cancel CONFIRMS and the
 * declared coverage is the thing under test. With the fixture's 10% coupon the
 * new total is R$108,00, which is the third grounded number the confirm states.
 */
const TARGET_TOTAL = 12_000;
/** R$1.500 — at/above the band, so the paid cancel ESCALATEs instead. */
const BIG_TOTAL = 150_000;

const TARGET_LINES = [
  { productId: "prod_costela", variantId: "var_costela", title: "Costela bovina defumada", quantity: 2, priceInCentavos: 4500 },
  { productId: "prod_pao", variantId: "var_pao", title: "Pão de alho", quantity: 1, priceInCentavos: 1500 },
];

/**
 * A SECOND, OLDER order with entirely different lines — the decoy for the
 * resequencing scenario. It exists so "the rebuild used the right order" is a
 * claim a wrong implementation could fail, rather than one that passes because
 * there was only ever one order to choose from.
 */
const OLDER_LINES = [
  { productId: "prod_picanha", variantId: "var_picanha", title: "Picanha na brasa", quantity: 5, priceInCentavos: 6000 },
];

function targetOrderRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TARGET_ORDER_ID,
    displayId: 3120,
    customerId: CUSTOMER,
    totalInCentavos: TARGET_TOTAL,
    paymentStatus: "paid",
    paymentMethod: "card",
    fulfillmentStatus: "confirmed",
    itemsJson: TARGET_LINES,
    version: 1,
    medusaCreatedAt: new Date("2026-07-24T18:00:00Z"),
    ...overrides,
  };
}

function olderOrderRow(): Record<string, unknown> {
  return {
    id: OLDER_ORDER_ID,
    displayId: 2990,
    customerId: CUSTOMER,
    totalInCentavos: 30_000,
    paymentStatus: "paid",
    paymentMethod: "card",
    fulfillmentStatus: "delivered",
    itemsJson: OLDER_LINES,
    version: 1,
    medusaCreatedAt: new Date("2026-07-01T18:00:00Z"),
  };
}

function paymentRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: PAYMENT_ID,
    orderId: TARGET_ORDER_ID,
    status: "paid",
    amountInCentavos: TARGET_TOTAL,
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
  process.env.STRIPE_SECRET_KEY = "sk_test_le2023";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/** A usable 10%-off promotion record, as the admin promotions API returns it. */
function promotionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    promotions: [
      {
        id: "promo_le2023",
        code: STORE_CODE,
        status: "active",
        // PRESENT and EMPTY — the only shape `promotionHasTargetingRules`
        // reads as "no rules", which is what unlocks the arithmetic.
        rules: [],
        application_method: { type: "percentage", value: 10 },
        ...overrides,
      },
    ],
  };
}

// ── The Medusa egress this route makes ────────────────────────────────────────

interface SwapMedusaOpts {
  /** The promotion lookup's response body. `null` ⟹ the lookup THROWS. */
  readonly promotion?: Record<string, unknown> | null;
  /** Which order id the reorder's admin read will answer for. */
  readonly reorderableOrderIds?: readonly string[];
}

/**
 * Layered over the harness's base fake, which still throws on anything
 * unrouted: an unexpected egress must fail the test rather than degrade into a
 * swallowed error.
 */
function withSwapRoutes(
  base: ReturnType<typeof makeMedusaFetchFake>,
  opts: SwapMedusaOpts = {},
): ReturnType<typeof makeMedusaFetchFake> {
  const json = (payload: unknown): unknown => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  const reorderable = new Set(opts.reorderableOrderIds ?? [TARGET_ORDER_ID, OLDER_ORDER_ID]);

  return {
    calls: base.calls,
    fetch: async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();

      // The promotion lookup, on the ONE shared `promotionByCodePath`.
      if (path.startsWith("/admin/promotions")) {
        base.calls.push({ method, path });
        if (opts.promotion === null) {
          return { ok: false, status: 500, text: async () => "promotions down" };
        }
        return json(opts.promotion ?? promotionPayload());
      }

      // The reorder's admin order read.
      const orderMatch = /^\/admin\/orders\/([^/]+)$/.exec(path);
      if (method === "GET" && orderMatch !== null) {
        const orderId = orderMatch[1]!;
        base.calls.push({ method, path });
        if (!reorderable.has(orderId)) {
          return { ok: false, status: 404, text: async () => "not found" };
        }
        const row = orderRowsFake.rows.find((r) => r["id"] === orderId);
        const lines = (row?.["itemsJson"] ?? []) as typeof TARGET_LINES;
        return json({
          order: {
            // `withOrderOwnership` re-checks this against ctx.customerId.
            customer_id: CUSTOMER,
            items: lines.map((i) => ({
              variant_id: i.variantId,
              quantity: i.quantity,
              title: i.title,
            })),
          },
        });
      }

      // The Medusa-native cancel `executeOrderCancel` fires and forgets.
      if (method === "POST" && /^\/admin\/orders\/[^/]+\/cancel$/.test(path)) {
        base.calls.push({ method, path });
        return json({ order: { id: TARGET_ORDER_ID, status: "canceled" } });
      }

      // The reorder's cart build.
      if (method === "POST" && path === "/store/carts") {
        base.calls.push({ method, path });
        return json({ cart: { id: REBUILT_CART_ID } });
      }
      if (method === "POST" && /^\/store\/carts\/[^/]+\/line-items$/.test(path)) {
        base.calls.push({ method, path, ...(init?.body ? { body: init.body } : {}) });
        return json({ cart: { id: REBUILT_CART_ID } });
      }

      // The coupon apply.
      if (method === "POST" && /^\/store\/carts\/[^/]+\/promotions$/.test(path)) {
        base.calls.push({ method, path, ...(init?.body ? { body: init.body } : {}) });
        return json({ cart: { id: REBUILT_CART_ID, promotions: [{ code: STORE_CODE }] } });
      }

      return base.fetch(input, init);
    },
  };
}

// ── Projections (the real ones, composed as `buildWorkflowRuntime` composes) ──

/**
 * Project state for one envelope through the REAL `resolveAndAssemble` — the
 * ANCHOR's state, on both the select and the resume shape. See the sibling
 * suite's `projectStateFor` for why the two shapes differ.
 */
async function projectAnchorState(
  kind: string,
  payload: Record<string, unknown>,
  opts: { readonly resume?: boolean; readonly customerId?: string } = {},
): Promise<unknown> {
  const resolved = await resolveAndAssemble({
    kind,
    payload,
    customerId: opts.customerId ?? CUSTOMER,
    channel: "web",
    ...(opts.resume === true ? {} : { sessionId: CONVERSATION }),
  } as never);
  return { ctx: resolved.ctx };
}

interface HarnessOpts {
  readonly realResponder?: boolean;
  /** Seeded order rows. Defaults to the older decoy + the paid target. */
  readonly orders?: readonly Record<string, unknown>[];
  /** Seeded payment rows. Defaults to the settled payment on the target. */
  readonly payments?: readonly Record<string, unknown>[];
  readonly medusa?: SwapMedusaOpts;
  /** Wire the AUT-017-shaped handoff port. Defaults ON. */
  readonly handoff?: boolean;
}

/**
 * The AUT-017-shaped handoff double: it PARKS the full envelope and then
 * PUBLISHES the notification, exactly as `natsHandoff(publish, parkDeps)` does
 * in production, and — like the real one — it never throws.
 */
function makeParkingHandoff(): {
  parked: { envelope: unknown; reason: string }[];
  published: { reason: string; intentKind: string }[];
  queue: (envelope: never, reason: string) => Promise<void>;
} {
  const parked: { envelope: unknown; reason: string }[] = [];
  const published: { reason: string; intentKind: string }[] = [];
  return {
    parked,
    published,
    queue: async (envelope: never, reason: string) => {
      parked.push({ envelope, reason });
      published.push({ reason, intentKind: String((envelope as { kind: unknown }).kind) });
    },
  };
}

function buildHarness(opts: HarnessOpts = {}) {
  orderRowsFake.rows = [...(opts.orders ?? [olderOrderRow(), targetOrderRow()])];
  paymentRowsFake.rows = new Map(
    (opts.payments ?? [paymentRow()]).map((p) => [String(p["id"]), { ...p }]),
  );

  const cart = makeCartFixture({ id: CART_ID });
  const medusa = withSwapRoutes(makeMedusaFetchFake(cart), opts.medusa ?? {});
  vi.stubGlobal("fetch", medusa.fetch);
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();
  const handoff = makeParkingHandoff();

  // The model names the WORKFLOW and fills its ONE declared slot. It never
  // names a capability and never supplies an identifier — the smuggled
  // `orderId` below proves `sanitizeWorkflowSlots` drops what it is not offered.
  const model = scriptedModel([
    {
      id: "tu_le2023",
      name: "start_workflow",
      input: {
        workflow: SWAP_FOR_COUPON_WORKFLOW_ID,
        slots: { code: SLOT_CODE, orderId: "order_MODEL_INVENTED" },
      },
    },
  ]);

  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: async (envelope) =>
      projectAnchorState(
        String(envelope.kind),
        (envelope.payload ?? {}) as Record<string, unknown>,
        { resume: true },
      ) as never,
  });

  // ── The production composition, rebuilt from its EXTRACTED decisions ───────

  /** `buildWorkflowRuntime`'s `activityState`. */
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
      return {
        ctx: await loadOrderCtx(identity as never, identity.customerId ?? "", orderId),
      };
    }
    return {
      ctx: await loadCartCtx(
        identity as never,
        (envelope.payload ?? {}) as never,
        activitySessionArg(envelope as never),
      ),
    };
  };

  /** `buildWorkflowRuntime`'s `workflowFacts`. */
  const workflowFacts = async (
    actor: { customerId?: string; sessionId?: string },
    slots: Record<string, unknown>,
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
    const previousFields = previousOrderCtxFields(previous);
    const code = typeof slots["code"] === "string" ? slots["code"] : "";
    const coupon =
      code === ""
        ? {}
        : await projectCouponForOrder({
            code,
            orderTotalInCentavos: previousFields["previousOrderTotalInCentavos"] as
              | number
              | undefined,
          });
    return projectWorkflowFacts({ ...ctx, ...previousFields, ...coupon });
  };

  /** `buildWorkflowRuntime`'s `resolveActivityPayload`. */
  const resolveActivityPayload = async (args: {
    capability: string;
    payload: Readonly<Record<string, unknown>>;
    actor: { customerId?: string; sessionId?: string };
  }) => {
    if (!ORDER_CTX_ACTIVITY_KINDS.has(args.capability)) return args.payload;
    const identity = actorIdentityBase(
      args.actor,
      currentWorkflowChannel(),
      process.env.KERNEL_TENANT_ID,
    );
    const previous =
      identity.customerId === null ? null : await loadPreviousOrder(identity.customerId);
    return stampOrderActivityPayload({
      capability: args.capability,
      payload: args.payload,
      customerId: identity.customerId,
      orderId: previous?.orderId,
    });
  };

  /** `buildWorkflowRuntime`'s `dispatchOrderCancel` — the REAL money path. */
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
    ...(opts.handoff === false ? {} : { escalationHandoff: handoff as never }),
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
    workflowRuntime: runtime,
    ...(opts.realResponder === true
      ? {
          realResponder: true,
          readAnswer: {
            render: (_turnId: string) => undefined,
            renderAction: (acted: unknown, _turnId: string) =>
              renderCustomerActionAnswer(acted),
          },
        }
      : {}),
  });
  harnessRef.current = harness;
  return { harness, sink, session, runtime, medusa, model, handoff };
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

/** Audit records for a kind, EXECUTE only. */
function executed(
  sink: ReturnType<typeof makeCapturingAuditSink>,
  kind: string,
): number {
  return sink.byKind(kind).filter((r) => r.decision.kind === "EXECUTE").length;
}

/** The customer-facing sentence a decision carries, wherever its shape puts it. */
function userFacingOf(decision: unknown): string {
  const d = decision as {
    prompt?: unknown;
    userFacing?: unknown;
    refusal?: { userFacing?: unknown };
    confirmation?: { prompt?: unknown };
  };
  for (const candidate of [
    d.prompt,
    d.confirmation?.prompt,
    d.refusal?.userFacing,
    d.userFacing,
  ]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return "";
}

/** The stable machine code a REFUSE decision carries, or "" for any other kind. */
function refusalCodeOf(decision: unknown): string {
  const code = (decision as { refusal?: { code?: unknown } }).refusal?.code;
  return typeof code === "string" ? code : "";
}

/**
 * A recorded request body as an object. The wire carries it as a JSON STRING
 * (every egress here goes through `JSON.stringify`), so reading `.variant_id`
 * off the raw value silently yields `undefined` and any assertion over it
 * passes vacuously.
 */
function readBody(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * The MUTATING egress a run made.
 *
 * Not simply "every POST": `getAdminToken` POSTs to `/auth/user/emailpass` to
 * mint a bearer token, which is authentication rather than a mutation, and
 * counting it would make "nothing happened" impossible to assert on any path
 * that reads the store at all.
 */
function mutatingPosts(
  medusa: ReturnType<typeof makeMedusaFetchFake>,
): typeof medusa.calls {
  return medusa.calls.filter(
    (c) => c.method === "POST" && c.path !== "/auth/user/emailpass",
  );
}

/** The variant ids the run actually POSTed as line items, in order. */
function rebuiltVariantIds(
  medusa: ReturnType<typeof makeMedusaFetchFake>,
): string[] {
  return medusa.calls
    .filter((c) => c.method === "POST" && /^\/store\/carts\/[^/]+\/line-items$/.test(c.path))
    .map((c) => String(readBody(c.body)["variant_id"] ?? ""));
}

/** Run the two-turn confirm flow and return both turns. */
async function selectThenAnswer(
  harness: ReturnType<typeof buildHarness>["harness"],
  answer: string,
) {
  const turn1 = await runCustomerTurn(harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: SELECT_UTTERANCE,
  });
  const turn2 = await runCustomerTurn(harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: answer,
  });
  return { turn1, turn2 };
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

// ── 1. Invalid coupon ─────────────────────────────────────────────────────────

describe("LE2-023 — an INVALID coupon is honest and destroys nothing", () => {
  it("renders the coupon-not-usable reason and runs NOTHING", async () => {
    // The store answers the lookup successfully and matches NO promotion —
    // `absent`, which is a fact about the store rather than an absence of
    // knowledge, so `couponIsValid: false` and the pre-check refuses.
    const { harness, sink, session, medusa } = buildHarness({
      realResponder: true,
      medusa: { promotion: { promotions: [] } },
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    // What the CUSTOMER READS is the authored `coupon-not-usable` template.
    expect(turn.response).toContain("Não consegui confirmar esse cupom agora");
    expect(turn.response).toContain("não mexi no seu pedido");

    // NOTHING DESTRUCTIVE — asserted on the sink, which is the only record a
    // shortcut could not fake, and on the egress, which is the only thing the
    // customer could observe.
    expect(executed(sink, "order.cancel")).toBe(0);
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.coupon.apply")).toBe(0);
    expect(executed(sink, "order.coupon.swap.request")).toBe(0);
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
    expect(mutatingPosts(medusa)).toHaveLength(0);
    // The order row is untouched.
    expect(orderRowsFake.rows.find((r) => r["id"] === TARGET_ORDER_ID)?.["fulfillmentStatus"]).toBe(
      "confirmed",
    );
  });

  it("CONTROL — the SAME turn with a usable coupon reaches the confirm", async () => {
    // Without this, the case above could be passing because the workflow is
    // unreachable for some unrelated reason.
    const { harness, session } = buildHarness({ realResponder: true });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);
  });

  it("a coupon lookup that THREW is reported as 'could not check', never as invalid", async () => {
    // Inv 7 — the third state. `projectCouponForOrder` swallows the IO failure
    // and stamps NOTHING, so the pre-check refuses with the same honest
    // sentence rather than telling the customer their coupon is bad.
    const { harness, sink } = buildHarness({
      realResponder: true,
      medusa: { promotion: null },
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn.response).toContain("Não consegui confirmar esse cupom agora");
    expect(executed(sink, "order.cancel")).toBe(0);
  });
});

// ── 2. Past the PONR ──────────────────────────────────────────────────────────

describe("LE2-023 — an order past the PONR is refused with the REASON", () => {
  it("names the point-of-no-return, and nothing runs", async () => {
    const { harness, sink, session, medusa } = buildHarness({
      realResponder: true,
      orders: [olderOrderRow(), targetOrderRow({ fulfillmentStatus: "in_delivery" })],
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    // The AUTHORED `past-ponr` template — a state fact, not a permission frame,
    // and it says who can help.
    expect(turn.response).toContain("já passou do ponto de cancelamento");
    expect(turn.response).toContain("equipe te ajuda");
    // …and specifically NOT the coupon reason. The four pre-checks are ordered,
    // first-failure-wins, and this asserts the route stated the reason that
    // actually applies rather than the next one down the list.
    expect(turn.response).not.toContain("Não consegui confirmar esse cupom");

    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
    expect(executed(sink, "order.cancel")).toBe(0);
    expect(mutatingPosts(medusa)).toHaveLength(0);
  });

  it("CONTROL — the same order BEFORE the PONR reaches the confirm", async () => {
    const { harness } = buildHarness({
      realResponder: true,
      orders: [olderOrderRow(), targetOrderRow({ fulfillmentStatus: "confirmed" })],
    });
    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    expect(turn.decision.kind).toBe("REQUEST_CONFIRMATION");
  });
});

// ── 3. The ONE confirm ────────────────────────────────────────────────────────

describe("LE2-023 — EXACTLY ONE confirm, grounded in projected state", () => {
  it("states the order amount, the refund consequence and the new total", async () => {
    const { harness, sink, session, runtime } = buildHarness({ realResponder: true });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn.decision.kind).toBe("REQUEST_CONFIRMATION");

    // The three declared facts, at the seam the CUSTOMER reads. The unit gate
    // on the guard's own words lives in `packages/pack-orders`
    // (`GATE 2 — the confirm sentence STATES all three declared facts`); this is
    // the other half — that the sentence survives the whole turn intact.
    expect(turn.response).toContain("R$ 120,00"); // orderAmount
    expect(turn.response).toContain("reembolso"); // refundConsequence
    expect(turn.response).toContain("R$ 108,00"); // newTotal
    // The STORE's spelling, never the untrusted slot's.
    expect(turn.response).toContain(STORE_CODE);
    expect(turn.response).not.toContain(SLOT_CODE);
    // The display id a customer recognises.
    expect(turn.response).toContain("#3120");

    // `{confirmation}` ALONE — the template is the kernel's own sentence and
    // nothing else, so the two are EQUAL. Asserting only that the response
    // "contains" the numbers would pass over a second voice added around them.
    expect(turn.response).toBe(userFacingOf(turn.decision));
    expect(runtime.renderConfirm(turn.turnId)).toBe(turn.response);

    // EXACTLY ONE. One park, one confirm-shaped decision on this turn.
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);
    expect(String(session.parksFor(CUSTOMER)[0]!.envelope.kind)).toBe(
      "order.coupon.swap.request",
    );
    expect(
      sink.records.filter((r) => r.decision.kind === "REQUEST_CONFIRMATION"),
    ).toHaveLength(1);

    // NOTHING executed behind it.
    expect(executed(sink, "order.cancel")).toBe(0);
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.coupon.apply")).toBe(0);
  });

  it("the instance PINS the catalog serial and binds ONLY the declared slot", async () => {
    const { harness, runtime } = buildHarness();
    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    const instance = runtime.instanceFor(turn.turnId);
    expect(instance?.workflowId).toBe(SWAP_FOR_COUPON_WORKFLOW_ID);
    expect(instance?.catalogVersion).toBe(CATALOG_VERSION);
    // ONE param, and it is the coupon code. The smuggled `orderId` slot became
    // nothing at all — the workflow declares no such slot, so
    // `sanitizeWorkflowSlots` dropped it.
    expect([...(instance?.params.keys() ?? [])]).toEqual(["code"]);
    expect(instance?.unresolved).toEqual([]);
    expect(instance?.slots["orderId"]).toBeUndefined();
    expect(instance?.slots["code"]).toBe(SLOT_CODE);
  });

  it("the UNPAID order's confirm OMITS the refund clause", async () => {
    // Directional. The clause is conditional on the payment being settled,
    // which is exactly when `gatePaidCancel` asks the covered question — so on
    // this shape there is no refund to promise AND no coverable confirm.
    const { harness } = buildHarness({
      realResponder: true,
      orders: [olderOrderRow(), targetOrderRow({ paymentStatus: "awaiting_payment" })],
      payments: [],
    });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(turn.response).not.toContain("reembolso");
    // …and still states the two facts that ARE true of an unpaid swap.
    expect(turn.response).toContain("R$ 120,00");
    expect(turn.response).toContain("R$ 108,00");
  });

  it("a DECLINE runs nothing and never claims anything happened", async () => {
    const { harness, sink, medusa } = buildHarness({ realResponder: true });
    const { turn2 } = await selectThenAnswer(harness, "não, deixa pra lá");

    expect(turn2.decision.kind).not.toBe("EXECUTE");
    expect(executed(sink, "order.cancel")).toBe(0);
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.coupon.apply")).toBe(0);
    expect(workflowTrace(turn2.turnId)).toBeUndefined();
    expect(mutatingPosts(medusa)).toHaveLength(0);
    expect(turn2.response).not.toContain("Cancelei");
    expect(turn2.response).not.toContain("Pronto!");
    // The order is exactly as it was.
    expect(
      orderRowsFake.rows.find((r) => r["id"] === TARGET_ORDER_ID)?.["fulfillmentStatus"],
    ).toBe("confirmed");
  });
});

// ── 4. Accept ⇒ the governed saga ─────────────────────────────────────────────

describe("LE2-023 — ACCEPT runs the governed saga", () => {
  it("per-activity audit rows, coverage-resolved paid cancel, refund BEFORE cancel", async () => {
    const { harness, sink, medusa } = buildHarness({ realResponder: true });
    const { turn2 } = await selectThenAnswer(harness, "sim");

    expect(turn2.decision.kind).toBe("EXECUTE");

    // EACH ACTIVITY, INDIVIDUALLY — its own envelope, its own adjudication, its
    // own audit row, indistinguishable from a directly-parsed mutation's.
    expect(executed(sink, "order.cancel")).toBe(1);
    expect(executed(sink, "order.reorder")).toBe(1);

    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.catalogVersion).toBe(CATALOG_VERSION);
    expect(trace?.steps.map((s) => s.activityId)).toEqual([
      "cancel",
      "rebuild",
      "apply-coupon",
    ]);
    expect(trace?.run.activitiesTotal).toBe(3);

    // THE COVERAGE, KERNEL-WITNESSED — LE2-023's whole point, and the assertion
    // that would have caught `carriesConfirmationReceipt` reading the wrong
    // basis field (see that function). The cancel's FIRST adjudication asked
    // `paid_cancel_requires_confirmation`; the SECOND — the identical envelope
    // re-submitted with a receipt for its own hash — EXECUTEd. BOTH rows are on
    // the sink, which is what makes "declared coverage" a fact about the audit
    // trail rather than about a private code path.
    const cancelRows = sink.byKind("order.cancel");
    expect(cancelRows.map((r) => r.decision.kind)).toEqual([
      "REQUEST_CONFIRMATION",
      "EXECUTE",
    ]);

    // REFUNDS-THEN-CANCELS, in that order, on the ORDER THE CUSTOMER WAS SHOWN.
    expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["status"]).toBe("refunded");
    expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["refundedAmountCentavos"]).toBe(
      TARGET_TOTAL,
    );
    expect(
      orderRowsFake.rows.find((r) => r["id"] === TARGET_ORDER_ID)?.["fulfillmentStatus"],
    ).toBe("canceled");
    // The DECOY is untouched — the saga cancelled the order it named, not the
    // customer's other one.
    expect(
      orderRowsFake.rows.find((r) => r["id"] === OLDER_ORDER_ID)?.["fulfillmentStatus"],
    ).toBe("delivered");

    // The cart really was rebuilt.
    expect(
      medusa.calls.filter((c) => c.method === "POST" && c.path === "/store/carts"),
    ).toHaveLength(1);
  });

  it("KNOWN DEFECT — `apply-coupon` is REFUSED for a missing cartId, and the run says so honestly", async () => {
    // ── THIS TEST ENCODES A DEFECT, DELIBERATELY, AND MUST GO RED WHEN IT IS
    //    FIXED. Do not "repair" it by relaxing an assertion — update it. ───────
    //
    // MEASURED at the real seam: `requireCartIdForCartOps` (pack-orders) reads
    // `envelope.payload.cartId` for `order.coupon.apply`, the activity's authored
    // payload is `{code}` alone, and `resolveActivityPayload` stamps only
    // `ORDER_CTX_ACTIVITY_KINDS` (= `order.cancel`). So the last step of the
    // route is REFUSED and the swap never completes.
    //
    // It is NOT simply an unstamped field: `reorder` POSTs a FRESH cart and never
    // writes `rk("cart:active:session:<sid>")` (`getOrCreateCart` is that key's
    // only writer), so the session still points at the customer's OLD cart.
    // Stamping the cartId from the session would apply the discount to a basket
    // they are not buying — breaking the very total they approved a cancellation
    // against. Closing this needs an owner decision, so the route ships with the
    // gap VISIBLE rather than papered over.
    //
    // WHAT IS PROVEN HERE IS THE SAFETY PROPERTY, and it holds completely: the
    // customer is never told the swap worked. The two irreversible steps that DID
    // run are reported, the outcome is `stranded`, and the sentence names what was
    // done and what was not.
    const { harness, sink, medusa } = buildHarness({ realResponder: true });
    const { turn2 } = await selectThenAnswer(harness, "sim");

    const applyRows = sink.byKind("order.coupon.apply");
    expect(applyRows.map((r) => r.decision.kind)).toEqual(["REFUSE"]);
    expect(refusalCodeOf(applyRows[0]!.decision)).toBe("order.cart.missing");
    // The payload the activity was submitted with — the whole of the defect.
    expect(applyRows[0]!.envelope.payload).toEqual({ code: SLOT_CODE });

    // The coupon never reached the store.
    expect(
      medusa.calls.filter(
        (c) => c.method === "POST" && /^\/store\/carts\/[^/]+\/promotions$/.test(c.path),
      ),
    ).toHaveLength(0);

    // The run reports the truth: two irreversible steps ran, the third did not.
    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.outcome).toBe("stranded");
    expect(trace?.run.failedActivityId).toBe("apply-coupon");
    expect(trace?.run.activitiesExecuted).toBe(2);

    // AND THE CUSTOMER IS NEVER TOLD IT WORKED — the property that matters.
    expect(turn2.response).not.toContain("cupom aplicado");
    expect(turn2.response).not.toContain("Pronto!");
    expect(turn2.response).toBe(
      "Cancelei seu pedido anterior, mas não consegui montar o novo com o cupom. Já chamei alguém da equipe para resolver isso com você.",
    );
  });

  it("the cancel envelope carries the HOST-RESOLVED orderId and the BKL-103 actorId", async () => {
    // Neither has an admissible `WorkflowParamSource`, so both are stamped
    // composition-side from the owner-scoped previous-order read. An unstamped
    // `actorId` would make an escalated in-saga cancel unapprovable.
    const { harness, sink } = buildHarness();
    await selectThenAnswer(harness, "sim");

    const cancelRow = sink.byKind("order.cancel")[0];
    const payload = cancelRow?.envelope.payload as {
      orderId?: unknown;
      actorId?: unknown;
    };
    expect(payload.orderId).toBe(TARGET_ORDER_ID);
    expect(payload.actorId).toBe(CUSTOMER);
    // And the model's invented id is nowhere in it.
    expect(JSON.stringify(payload)).not.toContain("order_MODEL_INVENTED");
  });

  it("a refund that DOES NOT SETTLE fails the step — never a half-cancelled order", async () => {
    // The one direction `executeOrderCancel` exists to hold: no settled refund
    // ⟹ no cancel. The throw surfaces as a step that did not execute, which
    // stops the run and fires the compensators.
    const { harness, sink, medusa } = buildHarness({
      realResponder: true,
      payments: [paymentRow({ refundDecision: "ESCALATE" })],
    });
    const { turn2 } = await selectThenAnswer(harness, "sim");

    // The kernel said EXECUTE on the cancel — the money path is what refused.
    expect(executed(sink, "order.cancel")).toBe(1);

    // STATE IS WHOLE. No order transition, payment untouched.
    expect(
      orderRowsFake.rows.find((r) => r["id"] === TARGET_ORDER_ID)?.["fulfillmentStatus"],
    ).toBe("confirmed");
    expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["status"]).toBe("paid");
    expect(natsSpy.calls.filter((c) => c.event === "order.canceled")).toHaveLength(0);

    // The run stopped at the first step: nothing rebuilt, no coupon applied.
    const trace = workflowTrace(turn2.turnId);
    expect(trace?.steps.filter((s) => s.role === "activity").map((s) => s.executed)).toEqual([
      false,
    ]);
    expect(trace?.run.failedActivityId).toBe("cancel");
    expect(trace?.run.activitiesExecuted).toBe(0);
    expect(medusa.calls.filter((c) => c.path === "/store/carts")).toHaveLength(0);

    // …and the customer is NEVER told the swap happened.
    expect(turn2.response).not.toContain("Pronto!");
    expect(turn2.response).not.toContain("Cancelei o pedido anterior");
  });
});

// ── 5. Reorder failure after the cancel — the resequencing hazard ─────────────

describe("LE2-023 — the saga's RESEQUENCING hazard", () => {
  it("the rebuild uses the ORDER THAT WAS CANCELLED, not a re-resolved other one", async () => {
    // THE OPEN RISK, made falsifiable. `order.reorder`'s executor re-resolves
    // "the previous order" at DISPATCH time — after step one already cancelled
    // it — so the question is whether that read still means the same order.
    //
    // The fixture seeds TWO orders. If "previous order" ever re-resolved past
    // the cancelled one (a status filter added to `listByCustomer`, a projector
    // that clears `itemsJson` on cancel), the rebuild would silently restore the
    // OLDER basket and this assertion is what would catch it.
    const { harness, medusa } = buildHarness({ realResponder: true });
    await selectThenAnswer(harness, "sim");

    expect(rebuiltVariantIds(medusa)).toEqual(["var_costela", "var_pao"]);
    // Explicitly NOT the decoy's line.
    expect(rebuiltVariantIds(medusa)).not.toContain("var_picanha");
    // And the admin read the rebuild made was for the cancelled order.
    expect(
      medusa.calls.some((c) => c.path === `/admin/orders/${TARGET_ORDER_ID}`),
    ).toBe(true);
    expect(
      medusa.calls.some((c) => c.path === `/admin/orders/${OLDER_ORDER_ID}`),
    ).toBe(false);
  });

  it("a rebuild that FAILS after the cancel STRANDS honestly — never 'nothing happened'", async () => {
    // `cancel` is `terminal: "irreversible"`, so the compensation pass runs and
    // reports that nothing could be undone. The customer is told their order
    // WAS cancelled — the one sentence this outcome exists for.
    const { harness, sink, medusa } = buildHarness({
      realResponder: true,
      // The rebuild's admin read 404s ⟹ `reorder` throws ⟹ the step fails.
      medusa: { reorderableOrderIds: [] },
    });
    const { turn2 } = await selectThenAnswer(harness, "sim");

    // The cancel really happened…
    expect(executed(sink, "order.cancel")).toBe(1);
    expect(
      orderRowsFake.rows.find((r) => r["id"] === TARGET_ORDER_ID)?.["fulfillmentStatus"],
    ).toBe("canceled");
    // …the rebuild did NOT. Asserted on the STEP and on the EGRESS, not on the
    // audit sink: the kernel EXECUTEd the rebuild and its EXECUTOR is what threw,
    // so an `executed(sink, …)` count of 0 here would be false. The distinction
    // is the whole point of the trace's own `executed` flag — a kernel that said
    // yes and a mutation that did not happen are different facts, and only one of
    // them is what the customer got.
    const rebuildStep = workflowTrace(turn2.turnId)?.steps.find(
      (s) => s.activityId === "rebuild",
    );
    expect(rebuildStep?.decision).toBe("EXECUTE");
    expect(rebuildStep?.executed).toBe(false);
    expect(medusa.calls.filter((c) => c.path === "/store/carts")).toHaveLength(0);
    // Nothing after it ran at all.
    expect(sink.byKind("order.coupon.apply")).toHaveLength(0);
    expect(
      medusa.calls.filter(
        (c) => c.method === "POST" && /^\/store\/carts\/[^/]+\/promotions$/.test(c.path),
      ),
    ).toHaveLength(0);

    // THE COMPENSATION MACHINERY RAN and reported what it found.
    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.outcome).toBe("stranded");
    expect(trace?.run.failedActivityId).toBe("rebuild");
    expect(trace?.run.activitiesExecuted).toBe(1);

    // THE SENTENCE. It names what was done, what was not, and who is handling it.
    expect(turn2.response).toBe(
      "Cancelei seu pedido anterior, mas não consegui montar o novo com o cupom. Já chamei alguém da equipe para resolver isso com você.",
    );
    // Directional: it must NOT be the reassuring `compensated` sentence, which
    // would tell a customer with a cancelled order that nothing changed.
    expect(turn2.response).not.toContain("Seu pedido continua como estava");
  });
});

// ── 6. ESCALATE ───────────────────────────────────────────────────────────────

describe("LE2-023 — an at-band cancel ESCALATEs to a human", () => {
  it("parks + publishes on the injected handoff, reaches `escalated`, tells the whole truth", async () => {
    const { harness, sink, handoff, medusa } = buildHarness({
      realResponder: true,
      orders: [
        olderOrderRow(),
        targetOrderRow({ totalInCentavos: BIG_TOTAL }),
      ],
      payments: [paymentRow({ amountInCentavos: BIG_TOTAL })],
    });
    const { turn2 } = await selectThenAnswer(harness, "sim");

    // The kernel ESCALATEd the cancel — the upper band is untouched by the
    // coverage BY CONSTRUCTION (coverage acts on REQUEST_CONFIRMATION alone).
    const cancelRows = sink.byKind("order.cancel");
    expect(cancelRows.map((r) => r.decision.kind)).toEqual(["ESCALATE"]);
    expect(executed(sink, "order.cancel")).toBe(0);

    // STAFF-VISIBLE. The park landed AND the publish fired — before this port,
    // an escalated activity wrote one audit row and surfaced nowhere.
    expect(handoff.parked).toHaveLength(1);
    expect(String((handoff.parked[0]!.envelope as { kind: unknown }).kind)).toBe(
      "order.cancel",
    );
    expect(handoff.published).toHaveLength(1);
    expect(handoff.published[0]!.intentKind).toBe("order.cancel");
    // The parked envelope carries the proposer stamp an approval needs.
    expect(
      (handoff.parked[0]!.envelope as { payload: { actorId?: unknown } }).payload.actorId,
    ).toBe(CUSTOMER);

    // The `escalated` OUTCOME, which outranks every other reading.
    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.outcome).toBe("escalated");

    // THE WHOLE TRUTH — both halves. "someone will review this" alone would
    // leave the customer believing their whole request is pending.
    expect(turn2.response).toContain("precisa da aprovação de um responsável");
    expect(turn2.response).toContain("ainda não mexi no seu pedido");
    expect(turn2.response).toContain("é só me chamar que eu monto o pedido novo");

    // Nothing moved.
    expect(
      orderRowsFake.rows.find((r) => r["id"] === TARGET_ORDER_ID)?.["fulfillmentStatus"],
    ).toBe("confirmed");
    expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["status"]).toBe("paid");
    expect(medusa.calls.filter((c) => c.path === "/store/carts")).toHaveLength(0);
  });

  it("CONTROL — the SUB-band shape on the same fixture EXECUTEs via the coverage", async () => {
    // De-vacuums the case above: the escalation is about the BAND, not about
    // some unrelated reason the cancel could not run.
    const { harness, sink, handoff } = buildHarness();
    await selectThenAnswer(harness, "sim");

    expect(sink.byKind("order.cancel").map((r) => r.decision.kind)).toEqual([
      "REQUEST_CONFIRMATION",
      "EXECUTE",
    ]);
    expect(handoff.parked).toHaveLength(0);
  });

  it("with NO handoff port the escalation still reaches `escalated` — audit-row-only", async () => {
    // The composition that has not wired the port loses the staff surface, and
    // loses it loudly. Behaviour is otherwise identical, which is what makes
    // the port an addition rather than a dependency.
    const { harness, sink } = buildHarness({
      realResponder: true,
      handoff: false,
      orders: [olderOrderRow(), targetOrderRow({ totalInCentavos: BIG_TOTAL })],
      payments: [paymentRow({ amountInCentavos: BIG_TOTAL })],
    });
    const { turn2 } = await selectThenAnswer(harness, "sim");

    expect(sink.byKind("order.cancel").map((r) => r.decision.kind)).toEqual(["ESCALATE"]);
    expect(workflowTrace(turn2.turnId)?.run.outcome).toBe("escalated");
  });
});

// ── 7. The OFF policy switch, and the inert autoresolve guard ────────────────

describe("LE2-023 — the coupon_on_placed_order switch is CLOSED on the route", () => {
  it("a REAL turn never reaches the price-adjust arm", async () => {
    // The force-open fixture in `packages/pack-orders` proves the KERNEL still
    // refuses `order.coupon.adjust`. This proves the other lock: on a real turn
    // the ROUTE never reaches it at all, so the kernel never has to.
    const { harness, sink } = buildHarness();
    const { turn2 } = await selectThenAnswer(harness, "sim");

    const trace = workflowTrace(turn2.turnId);
    // The branch was EVALUATED and recorded as closed — an operator can tell a
    // route that took the closed path from a customer who failed to qualify.
    expect(trace?.run.branches).toEqual([
      {
        stepIndex: 0,
        predicate: "policy coupon_on_placed_order closed",
        held: false,
        taken: "otherwise",
        activityIds: ["cancel", "rebuild", "apply-coupon"],
      },
    ]);
    // The scoped kind never reached the kernel and never reached its handler
    // (which THROWS — reaching it would have failed the run).
    expect(sink.byKind("order.coupon.adjust")).toHaveLength(0);
    expect(trace?.steps.map((s) => s.capability)).not.toContain("order.coupon.adjust");
  });

  it("neither the anchor nor the scoped kinds are ever on the capability wire", async () => {
    const { harness, model } = buildHarness();
    const scripted = model as unknown as { complete: { mock: { calls: unknown[][] } } };

    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    const plannerCall = scripted.complete.mock.calls
      .map((c) => c[0] as { tools?: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }> })
      .find((req) => (req.tools?.length ?? 0) > 0);
    const advertised = (
      (plannerCall?.tools?.find((t) => t.name === "express_intent")
        ?.inputSchema as { properties: { capability: { enum: readonly string[] } } })
    ).properties.capability.enum;

    expect(advertised).not.toContain("order.coupon.swap.request");
    expect(advertised).not.toContain("order.coupon.adjust");
    expect(advertised).not.toContain("order.reorder");
    // The CONTROL: ordinary kinds ARE advertised, so the three above are about
    // the access classes and not about an empty roster.
    expect(advertised).toContain("order.coupon.apply");
    expect(advertised).toContain("order.checkout.create");

    // …and the WORKFLOW is on the wire, with its authored phrasings.
    const startWorkflow = plannerCall?.tools?.find((t) => t.name === "start_workflow");
    expect(String(startWorkflow?.description)).toContain(SWAP_FOR_COUPON_WORKFLOW_ID);
    expect(String(startWorkflow?.description)).toContain(
      '"cancela meu pedido e faz outro igual com o cupom"',
    );
  });
});

describe("LE2-023 — confirmOnAutoResolveGuard stays INERT on the activity path", () => {
  it("the in-saga cancel is NOT gated by it (both host-resolved ids, no autoresolve marker)", async () => {
    // A host-resolved order id must not stamp `autoResolvedMoneyRef`: the
    // activity plane mints its own envelope and projects `loadOrderCtx`, which
    // has no such field. If it ever did, the cancel would meet a SECOND confirm
    // the workflow's coverage does not declare and the saga would stall.
    const { harness, sink } = buildHarness();
    await selectThenAnswer(harness, "sim");

    const cancelRows = sink.byKind("order.cancel");
    // The only confirm the cancel met is `gatePaidCancel`'s, the covered one.
    const confirmRow = cancelRows.find((r) => r.decision.kind === "REQUEST_CONFIRMATION");
    expect(JSON.stringify(confirmRow?.decision)).toContain(
      "paid_cancel_requires_confirmation",
    );
    expect(JSON.stringify(confirmRow?.decision)).not.toContain("autoResolved");
    expect(executed(sink, "order.cancel")).toBe(1);
  });

  it("CONTROL — it is LIVE on the direct plane, where the id IS auto-resolved", async () => {
    // The other direction. A directly-parsed `order.cancel` with no order id
    // auto-resolves to the customer's most recent order, `resolve-and-assemble`
    // stamps `autoResolvedMoneyRef`, and the guard fires. Without this, "inert
    // in the saga" would be indistinguishable from "inert everywhere".
    buildHarness();
    const resolved = await resolveAndAssemble({
      kind: "order.cancel",
      payload: {},
      customerId: CUSTOMER,
      channel: "web",
      sessionId: CONVERSATION,
    } as never);
    expect(resolved.ctx.autoResolvedMoneyRef).toBe(true);
  });
});
