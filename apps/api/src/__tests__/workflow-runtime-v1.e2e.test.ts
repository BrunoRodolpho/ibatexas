/**
 * LE2-022 turn-seam e2e — the WORKFLOW RUNTIME v1 (feasibility pre-checks,
 * conditional edges, compensation, pinned-shape resume) driven through a REAL
 * `handleTurn`, with mocks only at the Medusa / Redis / Stripe / Prisma CLIENT
 * boundary.
 *
 * A SIBLING of `workflow-runtime.e2e.test.ts` rather than more cases in it. That
 * file is the LINEAR v0 runtime's witness and must keep proving exactly what it
 * proved before this ticket — a v0 regression has to surface as a v0 failure,
 * not as a diff inside a file that now also exercises branches and rollbacks.
 * Everything below the model is real here too: the production planner, the real
 * composed policy router, `adjudicateAndAudit`, the real tool registry,
 * `WebConfirmChannel.matchToParked`, the real responder.
 *
 * ── WHAT EACH ACCEPTANCE CRITERION IS PROVED WITH ────────────────────────────
 *
 *   AC 1  a failed pre-check → NO confirm parks, and the reply is the
 *         pre-check's OWN authored reason. Directional: the CONTROL is the same
 *         utterance with a previous order present, which parks.
 *   AC 2  both arms of one conditional edge, selected by a GROUNDED fact
 *         (the previous order's total) that is independent of every other knob
 *         in the flow. Each arm's activity is asserted on the AUDIT SINK, and
 *         the other arm's is asserted ABSENT.
 *   AC 3  a mid-run failure the REAL kernel produces — the `finishCheckout`
 *         activity meets `confirmLargeTicket` on its own terms, because a
 *         whole-workflow confirm does not pre-authorize a step's own confirm —
 *         followed by the declared compensator running through full kernel
 *         adjudication, and the `compensated` template reaching the customer.
 *   AC 4  a park that survives a CATALOG BUMP: the corpus is edited and the
 *         serial advanced while the confirm sits parked, and the run executes
 *         the shape it PINNED. Then the other half: a policy change that now
 *         blocks an activity fails the workflow closed with an honest render.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake, previousOrder } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    // MUTABLE, and that is the instrument: the conditional edge branches on the
    // previous order's grounded total, so a test varies THIS and nothing else.
    // A per-case `vi.mock` factory could not do it — the factory is hoisted once
    // per file.
    previousOrder: { totalInCentavos: 8900, exists: true },
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
      confirm: vi.fn().mockResolvedValue({ id: "pi_le2022", status: "succeeded" }),
      update: vi.fn().mockResolvedValue({ id: "pi_le2022" }),
      retrieve: vi.fn().mockResolvedValue({ id: "pi_le2022" }),
    },
  })),
}));

/**
 * The domain double behind BOTH the `order.reorder` handler and the grounded
 * fact projection — the SAME owner-scoped read, which is the point: a workflow
 * branches on the projection its own activities resolve against, never on a
 * second view assembled for the test.
 *
 * `previousOrder.exists` drives AC 1 (no history ⟹ the pre-check refuses) and
 * `previousOrder.totalInCentavos` drives AC 2 (the branch's grounded fact).
 */
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { FIXTURE_PREVIOUS_ORDER_ID } = (await import("@ibatexas/catalog")) as {
    FIXTURE_PREVIOUS_ORDER_ID: string;
  };
  const row = () => ({
    id: FIXTURE_PREVIOUS_ORDER_ID,
    displayId: 1042,
    customerId: "cus_le2022_owner",
    totalInCentavos: previousOrder.totalInCentavos,
    itemsJson: [
      {
        productId: "prod_costela",
        variantId: "variant_costela_500g",
        title: "Costela 500g",
        quantity: 2,
        priceInCentavos: Math.round(previousOrder.totalInCentavos / 2),
      },
    ],
    medusaCreatedAt: new Date("2026-07-20T18:00:00Z"),
  });
  const none = { orders: [], count: 0 };
  return {
    ...actual,
    createOrderQueryService: () => ({
      getById: async (id: string, opts?: { customerId?: string }) =>
        previousOrder.exists &&
        id === row().id &&
        (opts?.customerId ?? row().customerId) === row().customerId
          ? row()
          : null,
      listByCustomer: async (customerId: string) =>
        previousOrder.exists && customerId === row().customerId
          ? { orders: [row()], count: 1 }
          : none,
      findByDisplayId: async () => [],
      listAll: async () =>
        previousOrder.exists ? { orders: [row()], count: 1 } : none,
      getStatusHistory: async () => [],
    }),
  };
});

const {
  composeCustomerConductor,
  CUSTOMER_ROUTER,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeCartFixture,
  makeMedusaFetchFake,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
} = await import("./customer-e2e-harness.js");
const { rk } = await import("@ibatexas/tools");
const { loadCartCtx, previousOrderCtxFields } = await import(
  "../claustrum/resolve-and-assemble.js"
);
const { loadPreviousOrder } = await import("../claustrum/previous-order.js");
const { createWorkflowRuntime } = await import(
  "../claustrum/workflow/workflow-runtime.js"
);
const { projectWorkflowFacts } = await import("../claustrum/workflow/workflow-facts.js");
const { workflowTrace } = await import("../claustrum/workflow/workflow-trace.js");
const {
  CATALOG_VERSION,
  FIXTURE_BRANCH_THRESHOLD_CENTAVOS,
  FIXTURE_CART_ID,
  FIXTURE_CONDITIONAL_WORKFLOW,
  FIXTURE_CONDITIONAL_WORKFLOW_ID,
  FIXTURE_PREVIOUS_ORDER_ID,
} = await import("@ibatexas/catalog");
const { adjudicateAndAudit } = await import("@adjudicate/core/kernel");
const { buildLanguageEngineAuditMetadata } = await import(
  "../claustrum/language-engine/audit-metadata.js"
);
const { composePolicyRouter } = await import("../claustrum/capability-policy.js");
const { buildIbatexasPolicyPacks } = await import(
  "../claustrum/compose-policy-packs.js"
);
const { IBATEXAS_COMPOSED_PACKS } = await import("@ibatexas/packs-composed");
const { renderCustomerActionAnswer } = await import(
  "../claustrum/customer-action-render.js"
);

const CUSTOMER = "cus_le2022_owner";
const CONVERSATION = "conv_le2022";
/** The cart every projection in this suite reads — the FIXTURE's own constant,
 *  so the seeded Redis binding, the Medusa fake and the checkout activity's
 *  authored payload cannot drift apart. */
const CART_ID = FIXTURE_CART_ID;

/** The utterance that selects the conditional fixture workflow. */
const SELECT_UTTERANCE = "quero repetir meu último pedido e finalizar";

/** A cart ABOVE the money band, so the anchor parks a confirm. */
const EXPENSIVE_CART_TOTAL = 1500;
/** A cart BELOW it, so the anchor executes in one turn and the run completes. */
const CHEAP_CART_TOTAL = 100;

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2022";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/**
 * The Medusa egress the activities make on top of the checkout anchor's. Layered
 * over the harness's fake and still throwing on anything unrouted — an
 * unexpected egress must fail the test, never degrade into a swallowed error.
 */
function withActivityRoutes(
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
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && path === `/admin/orders/${FIXTURE_PREVIOUS_ORDER_ID}`) {
        base.calls.push({ method, path });
        return json({
          order: {
            customer_id: CUSTOMER,
            items: [
              { variant_id: "variant_costela_500g", quantity: 2, title: "Costela 500g" },
            ],
          },
        });
      }
      if (method === "POST" && path === "/store/carts") {
        base.calls.push({ method, path });
        return json({ cart: { id: "cart_le2022_reordered" } });
      }
      if (method === "POST" && /^\/store\/carts\/[^/]+\/line-items$/.test(path)) {
        base.calls.push({ method, path });
        return json({ cart: { id: "cart_le2022_reordered" } });
      }
      return base.fetch(input, init);
    },
  };
}

/** The identity every projection in this suite runs under. */
const IDENTITY = {
  tenantId: "ibatexas",
  channel: "web",
  customerId: CUSTOMER,
  staffId: null,
  isAuthenticated: true,
};

/**
 * A POLICY that no longer owns `order.reorder` — AC 4's second half.
 *
 * Composed from the real pack list MINUS `pack-orders`, so the capability is
 * genuinely unowned and the router's own unknown-kind branch default-REFUSEs it.
 * That is a real policy change of the shape a deploy produces, not a stubbed
 * decision: the kernel is the same kernel and it refuses because the policy in
 * force no longer covers the act.
 */
function routerWithoutOrders(): unknown {
  return composePolicyRouter(
    buildIbatexasPolicyPacks(
      (IBATEXAS_COMPOSED_PACKS as ReadonlyArray<{ id: string }>).filter(
        (pack) => pack.id !== "ibatexas/pack-orders",
      ) as never,
    ) as never,
  );
}

/** The step record for one activity id, or `undefined`. */
function stepFor(
  trace: ReturnType<typeof workflowTrace>,
  activityId: string,
): { readonly decision: string; readonly executed: boolean } | undefined {
  return trace?.steps.find((s) => s.activityId === activityId);
}

/**
 * A full harness with the v1 runtime wired into all three seams, over a MUTABLE
 * corpus, a MUTABLE catalog serial and a SWAPPABLE activity router.
 *
 * All three are mutable for one reason: AC 4 is a statement about what happens
 * BETWEEN two turns, and the only honest way to test "the catalog moved while
 * the confirm was parked" is to move it between the two `runCustomerTurn` calls.
 */
function buildHarness(
  opts: {
    readonly cartTotal?: number;
  } = {},
) {
  const cart = makeCartFixture({
    id: CART_ID,
    total: opts.cartTotal ?? EXPENSIVE_CART_TOTAL,
  });
  const medusa = withActivityRoutes(makeMedusaFetchFake(cart));
  vi.stubGlobal("fetch", medusa.fetch);
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();

  const model = scriptedModel([
    {
      id: "tu_le2022",
      name: "start_workflow",
      input: {
        workflow: FIXTURE_CONDITIONAL_WORKFLOW_ID,
        slots: { payment_method: "pix", delivery_type: "pickup" },
      },
    },
  ]);

  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: async (envelope) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const ctx = await loadCartCtx(IDENTITY as never, payload as never, {
        sessionId: CONVERSATION,
      });
      return { ctx } as never;
    },
  });

  /**
   * The per-activity state, projected exactly as the COMPOSITION ROOT projects
   * it — including the activity's OWN payload, which is what lets the checkout
   * guards see the payment method and fulfillment the activity is asking for.
   * A `{}` here would quietly make this harness measure a different state from
   * the one production adjudicates against.
   */
  const activityState = async (envelope: { payload?: unknown }): Promise<unknown> => {
    const ctx = await loadCartCtx(
      IDENTITY as never,
      (envelope.payload ?? {}) as never,
      { sessionId: CONVERSATION },
    );
    return { ctx };
  };

  // MUTABLE by design — see the function doc. Held in a box rather than as
  // `let`s so the closures below read the CURRENT value on every turn instead of
  // capturing whatever it was at composition time, which is the difference
  // between testing a bump and testing nothing.
  const live = {
    workflows: [FIXTURE_CONDITIONAL_WORKFLOW] as unknown[],
    catalogVersion: CATALOG_VERSION,
    router: CUSTOMER_ROUTER as unknown,
  };

  const harnessRef: {
    current?: ReturnType<typeof composeCustomerConductor>;
  } = {};
  const runtime = createWorkflowRuntime({
    workflows: live.workflows as never,
    currentCatalogVersion: () => live.catalogVersion,
    // THE GROUNDED FACT PROJECTION, composed from the SAME two reads the
    // composition root composes it from: the cart ctx the money guards read, and
    // the owner-scoped previous-order projection `confirmReorderLast` reads. A
    // test-local shortcut here would prove the runtime branches on something,
    // but not that it branches on what the guards see.
    projectFacts: async () => {
      const ctx = (await loadCartCtx(IDENTITY as never, {} as never, {
        sessionId: CONVERSATION,
      })) as Record<string, unknown>;
      const previous = await loadPreviousOrder(CUSTOMER);
      return projectWorkflowFacts({ ...ctx, ...previousOrderCtxFields(previous) });
    },
    adjudicateActivity: async (envelope) =>
      (
        await adjudicateAndAudit(
          envelope,
          (await activityState(envelope)) as never,
          live.router as never,
          { sink, metadataProvider: buildLanguageEngineAuditMetadata },
        )
      ).decision,
    dispatchActivity: async (envelope, ctx) => {
      const registry = harnessRef.current?.tools;
      if (registry === undefined) {
        throw new Error(`no tool registry for ${String(envelope.kind)}`);
      }
      return registry
        .resolveTool(envelope.kind as never, ctx)
        .execute(envelope.payload, ctx);
    },
  });

  const harness = composeCustomerConductor({
    model,
    session,
    adjudicator,
    workflowRuntime: runtime,
    realResponder: true,
    // PRODUCTION PARITY — `claustrum-bootstrap.ts` wires exactly this pair into
    // the customer responder. Without it an EXECUTE turn's reply comes from the
    // model, and every assertion about a customer-visible outcome sentence would
    // be measuring `scriptedModel`'s filler instead of the authored template.
    // Customer reads flow through the claims pipeline, not this port, so
    // `render` is `undefined` here exactly as it is in production.
    readAnswer: {
      render: () => undefined,
      renderAction: (acted: unknown) => renderCustomerActionAnswer(acted),
    },
  });
  harnessRef.current = harness;
  return { harness, sink, session, runtime, medusa, live };
}

/** Audit records for a kind, EXECUTE only. */
function executed(
  sink: ReturnType<typeof makeCapturingAuditSink>,
  kind: string,
): number {
  return sink.byKind(kind).filter((r) => r.decision.kind === "EXECUTE").length;
}

/** Drive the two turns of a confirm flow, with an optional edit in between. */
async function selectThenConfirm(
  harness: ReturnType<typeof buildHarness>,
  between?: () => void,
) {
  const select = await runCustomerTurn(harness.harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: SELECT_UTTERANCE,
  });
  between?.();
  const confirm = await runCustomerTurn(harness.harness, {
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    text: "sim",
  });
  return { select, confirm };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  previousOrder.totalInCentavos = 8900;
  previousOrder.exists = true;
  seedEnv();
});

describe("LE2-022 AC 1 — a failed feasibility pre-check shows NO confirm", () => {
  it("renders the pre-check's OWN authored reason and parks nothing", async () => {
    // The customer has no order history, so `customerHasPreviousOrder` is ABSENT
    // and the declared pre-check does not hold.
    previousOrder.exists = false;
    const h = buildHarness();

    const turn = await runCustomerTurn(h.harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    // NO CONFIRM. Not "a confirm that was later refused" — the anchor envelope
    // was never minted, so the kernel never saw it, nothing parked, and there is
    // no audit row anywhere. That ordering is the whole acceptance criterion.
    expect(turn.decision.kind).not.toBe("REQUEST_CONFIRMATION");
    expect(h.session.parksFor(CUSTOMER)).toHaveLength(0);
    expect(h.sink.byKind("order.checkout.create")).toHaveLength(0);
    expect(h.sink.byKind("order.reorder")).toHaveLength(0);

    // The reply is the pre-check's AUTHORED template, at `turn.response` — the
    // customer-visible string, through the real responder, not a renderer-level
    // read of `renderNotice`.
    expect(turn.response).toContain("Ainda não encontrei nenhum pedido anterior seu");

    // The trace records it as its OWN outcome. `infeasible` is not `failed`:
    // nothing was attempted, so bucketing it as a failure would make the
    // workflow's failure rate a measure of who asked rather than of the system.
    const trace = workflowTrace(turn.turnId);
    expect(trace?.run.outcome).toBe("infeasible");
    expect(trace?.run.precheckFailedId).toBe("previous-order-present");
    expect(trace?.steps).toHaveLength(0);
  });

  it("CONTROL — the SAME utterance with a previous order present DOES park a confirm", async () => {
    // The directional half. Without it the assertions above are satisfied by any
    // composition that never starts this workflow at all — a workflow nobody can
    // select passes every "no confirm was shown" test ever written.
    const h = buildHarness();

    const turn = await runCustomerTurn(h.harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(h.session.parksFor(CUSTOMER)).toHaveLength(1);
    expect(workflowTrace(turn.turnId)?.run.outcome).toBeUndefined();
  });
});

describe("LE2-022 AC 2 — a conditional edge routes by declared predicate truth", () => {
  it("THEN arm — a previous order at or above the band routes to `order.reorder`", async () => {
    previousOrder.totalInCentavos = FIXTURE_BRANCH_THRESHOLD_CENTAVOS + 1;
    const h = buildHarness({ cartTotal: CHEAP_CART_TOTAL });

    const turn = await runCustomerTurn(h.harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    const trace = workflowTrace(turn.turnId);
    expect(trace?.run.outcome).toBe("completed");
    expect(trace?.steps.map((s) => s.activityId)).toEqual(["reorder", "finishCheckout"]);
    // The arm's activity reached the KERNEL and executed — asserted on the audit
    // sink, which is what an operator could actually check.
    expect(executed(h.sink, "order.reorder")).toBe(1);
    // …and the OTHER arm's activity never ran. A branch proven only by what DID
    // happen is half a proof: the same trace would appear if both arms ran.
    expect(h.sink.byKind("order.cart.ensure")).toHaveLength(0);

    // The branch record — the operator's answer to "which way did it go, and
    // why". Without it a false predicate and a never-evaluated one look the same.
    expect(trace?.run.branches).toEqual([
      {
        stepIndex: 0,
        predicate: `previousOrderTotalInCentavos atLeast ${FIXTURE_BRANCH_THRESHOLD_CENTAVOS}`,
        held: true,
        taken: "then",
        activityIds: ["reorder"],
      },
    ]);
  });

  it("OTHERWISE arm — a previous order below the band routes to `order.cart.ensure`", async () => {
    // ONE knob changed from the case above, and it is a GROUNDED fact: the
    // previous order's total, read through the same owner-scoped projection the
    // guards read. Nothing else about the flow differs.
    previousOrder.totalInCentavos = FIXTURE_BRANCH_THRESHOLD_CENTAVOS - 1;
    const h = buildHarness({ cartTotal: CHEAP_CART_TOTAL });

    const turn = await runCustomerTurn(h.harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    const trace = workflowTrace(turn.turnId);
    expect(trace?.steps.map((s) => s.activityId)).toEqual([
      "ensureCart",
      "finishCheckout",
    ]);
    expect(executed(h.sink, "order.cart.ensure")).toBe(1);
    // The workflow-scoped kind was never submitted — the strong half.
    expect(h.sink.byKind("order.reorder")).toHaveLength(0);

    expect(trace?.run.branches?.[0]).toMatchObject({
      held: false,
      taken: "otherwise",
      activityIds: ["ensureCart"],
    });
  });
});

describe("LE2-022 AC 3 — a mid-run failure runs the declared compensators", () => {
  it("undoes the executed step through FULL kernel adjudication and says so honestly", async () => {
    // The failure is the REAL kernel's, not a stub: with an expensive cart the
    // `finishCheckout` ACTIVITY meets `confirmLargeTicket` on its own terms and
    // returns REQUEST_CONFIRMATION rather than EXECUTE. Under LE2-023's refined
    // rule this activity declares NO `confirmCoveredBy`, so it is an UNCOVERED
    // confirm and the LE2-022 behaviour is unchanged byte-for-byte — which is
    // what this case now also pins: coverage is the declared exception, never
    // the default. So the run stops after `reorder`
    // has already rebuilt the cart, which is exactly the shape compensation
    // exists for.
    const h = buildHarness({ cartTotal: EXPENSIVE_CART_TOTAL });
    const { confirm } = await selectThenConfirm(h);

    const trace = workflowTrace(confirm.turnId);
    expect(trace?.run.outcome).toBe("compensated");
    expect(trace?.run.failedActivityId).toBe("finishCheckout");
    expect(trace?.run.compensationsExecuted).toBe(1);

    // THE DRILL-IN the owner's operator view asks for: which step, what the
    // kernel said, and whether compensation executed.
    expect(
      trace?.steps.map((s) => ({
        activityId: s.activityId,
        role: s.role,
        executed: s.executed,
        ...(s.compensates === undefined ? {} : { compensates: s.compensates }),
      })),
    ).toEqual([
      { activityId: "reorder", role: "activity", executed: true },
      { activityId: "finishCheckout", role: "activity", executed: false },
      {
        activityId: "undoReorder",
        role: "compensation",
        executed: true,
        compensates: "reorder",
      },
    ]);
    // The step the kernel stopped carries WHY, not just that it stopped.
    expect(trace?.steps[1]?.decision).toBe("REQUEST_CONFIRMATION");

    // THE COMPENSATOR IS AN ACTIVITY IN EVERY SENSE — its own envelope, its own
    // adjudication, its own audit row. Asserted on the sink because "the
    // rollback went through the kernel" is exactly the claim a shortcut would
    // break while every in-memory assertion above still passed.
    expect(executed(h.sink, "order.cart.ensure")).toBe(1);

    // …and the customer is told the truth: not "done", not "nothing happened",
    // but the authored sentence for a run that was undone. At `turn.response`,
    // through the real responder.
    expect(confirm.response).toContain("desfiz o que já tinha feito");
    expect(confirm.response).not.toContain("Pronto!");
  });

  it("a run where NOTHING executed is `failed`, not `compensated`", async () => {
    // The directional control for the outcome derivation. `compensated` must
    // mean "something ran and was undone"; if it also covered "nothing ran" the
    // customer would be told a rollback happened over an empty run, and the
    // assertions above would pass for the wrong reason.
    //
    // The policy no longer owns `order.reorder`, so the FIRST planned step is
    // refused and there is nothing to compensate.
    const h = buildHarness({ cartTotal: EXPENSIVE_CART_TOTAL });
    const { confirm } = await selectThenConfirm(h, () => {
      h.live.router = routerWithoutOrders();
    });

    const trace = workflowTrace(confirm.turnId);
    expect(trace?.run.outcome).toBe("failed");
    expect(trace?.run.activitiesExecuted).toBe(0);
    expect(trace?.run.compensationsExecuted).toBe(0);
    expect(trace?.steps.every((s) => s.role === "activity")).toBe(true);
  });
});

describe("LE2-022 AC 4 — park/resume across a CATALOG VERSION bump", () => {
  it("resumes on its PINNED shape while the corpus and the serial move on", async () => {
    // EXPENSIVE, because this AC is about a PARK: the anchor has to cross the
    // money band so the confirm survives into a second turn, which is the only
    // window a catalog bump can land in.
    const h = buildHarness({ cartTotal: EXPENSIVE_CART_TOTAL });

    const { select, confirm } = await selectThenConfirm(h, () => {
      // THE BUMP, taken while the confirm sits parked — a deploy between the
      // question and the answer. The corpus is REPLACED with a definition under
      // the same id whose route runs something else entirely, and the serial
      // advances.
      h.live.catalogVersion = CATALOG_VERSION + 1;
      h.live.workflows.length = 0;
      h.live.workflows.push({
        ...FIXTURE_CONDITIONAL_WORKFLOW,
        route: [{ activity: "ensureCart" }],
      });
    });

    expect(select.decision.kind).toBe("REQUEST_CONFIRMATION");
    const trace = workflowTrace(confirm.turnId);

    // THE PIN HELD. The instance ran the shape it was instantiated with — the
    // `reorder` arm followed by the checkout step — not the single-step
    // `ensureCart` route the corpus now declares. Read from the FORWARD steps
    // rather than from the instance, because the instance holding the old object
    // proves only that a reference was kept; the steps prove the run used it.
    expect(
      trace?.steps.filter((s) => s.role === "activity").map((s) => s.activityId),
    ).toEqual(["reorder", "finishCheckout"]);
    expect(executed(h.sink, "order.reorder")).toBe(1);
    // …and the route the corpus now declares was NOT taken: `ensureCart` is the
    // only activity the replacement definition routes, and it never ran.
    expect(stepFor(trace, "ensureCart")).toBeUndefined();

    // …and the drift is VISIBLE, which is the other half. One field could not
    // show both: `catalogVersion` is what the run executed, `catalogVersionAtRun`
    // is what the catalog had become.
    expect(trace?.run.catalogVersion).toBe(CATALOG_VERSION);
    expect(trace?.run.catalogVersionAtRun).toBe(CATALOG_VERSION + 1);
  });

  it("a policy that NOW blocks an activity fails the workflow closed, with an honest render", async () => {
    // The other half of "pin shape, adjudicate fresh" (LE2 Implementation
    // Decision 17): the SHAPE is pinned, the POLICY is not. `pack-orders` is
    // gone from the router by the time the customer says "sim", so
    // `order.reorder` is a capability no installed pack owns and the kernel's
    // own unknown-kind branch refuses it. Nothing about the instance changed.
    const h = buildHarness({ cartTotal: EXPENSIVE_CART_TOTAL });

    const { select, confirm } = await selectThenConfirm(h, () => {
      h.live.router = routerWithoutOrders();
    });

    expect(select.decision.kind).toBe("REQUEST_CONFIRMATION");

    const trace = workflowTrace(confirm.turnId);
    expect(trace?.run.outcome).toBe("failed");
    expect(trace?.run.failedActivityId).toBe("reorder");
    // FAILED CLOSED: the kernel refused, and the runtime did NOT dispatch.
    expect(trace?.steps[0]?.decision).not.toBe("EXECUTE");
    expect(trace?.steps[0]?.executed).toBe(false);
    expect(executed(h.sink, "order.reorder")).toBe(0);
    // The run STOPPED there — the later step was never submitted at all, which
    // is the fail-closed rule rather than a consequence of it. Asserted on the
    // absence of a step record: `order.checkout.create` has anchor rows on the
    // sink from the select and the resume, so counting audit rows by kind cannot
    // tell the anchor apart from the activity.
    expect(stepFor(trace, "finishCheckout")).toBeUndefined();
    expect(trace?.steps).toHaveLength(1);

    // The customer gets the AUTHORED failure sentence, not silence and not prose.
    expect(confirm.response).toContain("Não consegui concluir todas as etapas");
  });
});
