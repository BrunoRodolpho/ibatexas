/**
 * LE2-021 turn-seam e2e — the REORDER-LAST workflow, the first customer-facing
 * one, driven through a REAL `handleTurn`.
 *
 * Sibling of `workflow-runtime.e2e.test.ts`, and deliberately a SEPARATE file
 * rather than more cases in it. That suite drives `FIXTURE_WORKFLOWS` — a corpus
 * that is openly an instrument — and its job is to prove the RUNTIME. This one
 * drives `WORKFLOW_DEFINITIONS`, the real authored corpus, and its job is to
 * prove the ROUTE a customer will actually take. If they shared a file the two
 * corpora would be one edit away from being confused for each other.
 *
 * Mocks sit at the client boundary only: Redis, Stripe, Medusa's `fetch`, and
 * `@ibatexas/domain`'s order-query service (there is no Postgres here). Above
 * those, everything is production: the real planner over the real composed
 * capability planners, the real `resolve-and-assemble` RESOLVE stage — so
 * `loadPreviousOrderCtx` genuinely runs and genuinely stamps the ctx the guard
 * reads — the real composed policy router, the real `adjudicateAndAudit`, the
 * real tool registry, and the real `WebConfirmChannel.matchToParked`.
 *
 * ── THE SHAPE UNDER TEST ─────────────────────────────────────────────────────
 *
 *   turn 1  "repete meu último pedido"
 *             → the planner advertises the closed workflow surface
 *             → the model calls `start_workflow` (it never names a capability,
 *               and it never supplies an order id — there is no slot for one)
 *             → the runtime instantiates, PINNING the catalog serial
 *             → the ANCHOR `order.reorder.request` is adjudicated against ctx
 *               the RESOLVER projected from the customer's own last order
 *             → `confirmReorderLast` ⇒ REQUEST_CONFIRMATION naming the real
 *               items and the real total
 *             → parked; NOTHING has executed
 *   turn 2  "sim"
 *             → resume with the receipt ⇒ EXECUTE
 *             → the anchor tool runs, then the `order.reorder` ACTIVITY,
 *               adjudicated on its own and writing its own audit row
 *             → the reply is the authored `completed` template — the CHECKOUT
 *               HANDOFF, since checkout is deliberately not an activity
 *
 * plus the two counterfactuals the ticket names: "não" ⇒ nothing executes, and
 * a customer with NO order history ⇒ an honest refusal with nothing executed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake, orderRowsFake } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    /** The domain `OrderProjection` rows this run's customer owns, newest first. */
    orderRowsFake: { rows: [] as Record<string, unknown>[] },
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
      confirm: vi.fn().mockResolvedValue({ id: "pi_le2021", status: "succeeded" }),
      update: vi.fn().mockResolvedValue({ id: "pi_le2021" }),
      retrieve: vi.fn().mockResolvedValue({ id: "pi_le2021" }),
    },
  })),
}));

// The ONLY domain double: there is no Postgres in this suite, and
// `loadPreviousOrder` reads the projection through this service. Scoping is
// reproduced faithfully — `listByCustomer` filters on `customerId` — so a test
// cannot accidentally prove the happy path against another customer's row.
vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
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
        const owned = orderRowsFake.rows.filter((r) => r["customerId"] === customerId);
        return { orders: owned.slice(0, input?.limit ?? 20), count: owned.length };
      },
      findByDisplayId: async () => [],
      listAll: async () => ({ orders: [...orderRowsFake.rows], count: orderRowsFake.rows.length }),
      getStatusHistory: async () => [],
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
const { loadCartCtx, loadPreviousOrderCtx } = await import(
  "../claustrum/resolve-and-assemble.js"
);
const { createWorkflowRuntime } = await import(
  "../claustrum/workflow/workflow-runtime.js"
);
const { workflowTrace } = await import("../claustrum/workflow/workflow-trace.js");
const { CATALOG_VERSION, REORDER_LAST_WORKFLOW_ID, WORKFLOW_DEFINITIONS } = await import(
  "@ibatexas/catalog"
);
const { adjudicateAndAudit } = await import("@adjudicate/core/kernel");
const { buildLanguageEngineAuditMetadata } = await import(
  "../claustrum/language-engine/audit-metadata.js"
);

const CUSTOMER = "cus_le2021_owner";
const CONVERSATION = "conv_le2021";
const CART_ID = "cart_le2021";
const PREVIOUS_ORDER_ID = "order_le2021_previous";
const REBUILT_CART_ID = "cart_le2021_rebuilt";

/** The genuine production utterance the workflow's [P] phrasing is drawn from. */
const SELECT_UTTERANCE = "repete meu último pedido";

/**
 * The customer's last order, as the domain projection holds it.
 *
 * Three lines against a cap of three, so the confirm sentence lists all of them
 * and the "e mais N itens" summarisation is exercised by its own case rather
 * than smuggled into the main assertion. The total is NOT the sum of the lines
 * on purpose — a real order carries shipping and tips — which is exactly why
 * the guard must quote the projection's `totalInCentavos` instead of adding the
 * lines up itself. If it ever starts computing, this test fails.
 */
const PREVIOUS_ORDER_ROW = {
  id: PREVIOUS_ORDER_ID,
  displayId: 1042,
  customerId: CUSTOMER,
  totalInCentavos: 12500,
  itemsJson: [
    { productId: "prod_costela", variantId: "var_costela", title: "Costela bovina defumada", quantity: 2, priceInCentavos: 4500 },
    { productId: "prod_pao", variantId: "var_pao", title: "Pão de alho", quantity: 1, priceInCentavos: 1500 },
    { productId: "prod_farofa", variantId: "var_farofa", title: "Farofa de bacon", quantity: 1, priceInCentavos: 1000 },
  ],
  medusaCreatedAt: new Date("2026-07-20T18:00:00Z"),
};

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2021";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/**
 * The Medusa egress `order.reorder`'s handler makes: read the previous order,
 * POST a FRESH cart, then re-add its line items there. Layered over the
 * harness's fake, which still throws on anything unrouted — an unexpected
 * egress must fail the test rather than degrade into a swallowed error.
 */
function withReorderRoutes(
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
      if (method === "GET" && path === `/admin/orders/${PREVIOUS_ORDER_ID}`) {
        base.calls.push({ method, path });
        return json({
          order: {
            // `withOrderOwnership` re-checks this against ctx.customerId — a
            // second, INDEPENDENT ownership check downstream of the owner-scoped
            // projection read, which is why `order.reorder.request` needs no
            // kernel ownership gate of its own.
            customer_id: CUSTOMER,
            items: PREVIOUS_ORDER_ROW.itemsJson.map((i) => ({
              variant_id: i.variantId,
              quantity: i.quantity,
              title: i.title,
            })),
          },
        });
      }
      if (method === "POST" && path === "/store/carts") {
        base.calls.push({ method, path });
        return json({ cart: { id: REBUILT_CART_ID } });
      }
      if (method === "POST" && /^\/store\/carts\/[^/]+\/line-items$/.test(path)) {
        base.calls.push({ method, path });
        return json({ cart: { id: REBUILT_CART_ID } });
      }
      return base.fetch(input, init);
    },
  };
}

/** The identity base the harness's own resolver builds, re-created for the two
 *  state projections below so an activity and a resume meet the same shape a
 *  first-pass turn does. */
function identityBase(): Record<string, unknown> {
  return {
    tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
    channel: "web",
    customerId: CUSTOMER,
    staffId: null,
    isAuthenticated: true,
  };
}

/**
 * Project state for one envelope the way `loadCtxForKind` does — the anchor gets
 * the PREVIOUS-order ctx, everything else gets cart ctx.
 *
 * Both branches call the REAL loaders. A hand-built ctx literal here would make
 * every downstream assertion a statement about this file rather than about
 * `resolve-and-assemble.ts`, which is the module actually under test on the AC
 * that says the confirm is grounded.
 */
async function projectStateFor(kind: string): Promise<unknown> {
  if (kind === "order.reorder.request") {
    return { ctx: await loadPreviousOrderCtx(identityBase() as never, CUSTOMER) };
  }
  return {
    ctx: await loadCartCtx(identityBase() as never, {} as never, {
      sessionId: CONVERSATION,
    }),
  };
}

/**
 * A full harness with the REAL corpus wired into all three runtime seams, and
 * with the two corpus-derived tool registrations production performs
 * (`registerWorkflowScopedTools` for the activity, `registerWorkflowAnchorTools`
 * for the anchor) applied in the SAME ORDER — scoped and anchor handlers first,
 * `installWorkflowRuntime` last, because the registry is last-write-wins and
 * that order IS the installation mechanism.
 */
function buildHarness(opts: { readonly withHistory?: boolean } = {}) {
  orderRowsFake.rows = opts.withHistory === false ? [] : [PREVIOUS_ORDER_ROW];

  const cart = makeCartFixture({ id: CART_ID });
  const medusa = withReorderRoutes(makeMedusaFetchFake(cart));
  vi.stubGlobal("fetch", medusa.fetch);
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();

  // The model NEVER names a capability and NEVER supplies an identifier. The
  // workflow declares no slots, so `sanitizeWorkflowSlots` has nothing to keep —
  // and the smuggled key below proves it drops what it is not offered.
  const model = scriptedModel([
    {
      id: "tu_le2021",
      name: "start_workflow",
      input: {
        workflow: REORDER_LAST_WORKFLOW_ID,
        slots: { orderId: "order_MODEL_INVENTED" },
      },
    },
  ]);

  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: async (envelope) => projectStateFor(String(envelope.kind)) as never,
  });

  const harnessRef: { current?: ReturnType<typeof composeCustomerConductor> } = {};
  const runtime = createWorkflowRuntime({
    workflows: WORKFLOW_DEFINITIONS,
    adjudicateActivity: async (envelope) =>
      (
        await adjudicateAndAudit(
          envelope,
          (await projectStateFor(String(envelope.kind))) as never,
          CUSTOMER_ROUTER as never,
          { sink, metadataProvider: buildLanguageEngineAuditMetadata },
        )
      ).decision,
    dispatchActivity: async (envelope, ctx) => {
      const registry = harnessRef.current?.tools;
      if (registry === undefined) {
        throw new Error(`no tool registry for ${String(envelope.kind)}`);
      }
      const tool = registry.resolveTool(envelope.kind as never, ctx);
      return tool.execute(envelope.payload, ctx);
    },
  });

  // The harness's own `buildHarnessTools` performs production's composition —
  // scoped handlers, then anchor handlers, then `installWorkflowRuntime`, in
  // that order because the registry is last-write-wins. Reproducing it here
  // would be a second, drifting copy of the thing under test.
  const harness = composeCustomerConductor({
    model,
    session,
    adjudicator,
    workflowRuntime: runtime,
  });
  harnessRef.current = harness;
  return { harness, sink, session, runtime, medusa, model };
}

/** Audit records for a kind, EXECUTE only. */
function executed(
  sink: ReturnType<typeof makeCapturingAuditSink>,
  kind: string,
): number {
  return sink.byKind(kind).filter((r) => r.decision.kind === "EXECUTE").length;
}

/**
 * The customer-facing sentence a decision carries, wherever its shape puts it.
 *
 * A CONFIRM carries it as the prompt; a REFUSE carries it on the `Refusal`
 * (`{kind, code, userFacing, detail}`). Read structurally rather than by
 * decision kind so one helper serves both assertions and neither can silently
 * return "" and pass a `toContain` against an empty expectation.
 */
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  orderRowsFake.rows = [];
  seedEnv();
});

describe("LE2-021 — reorder-last, selected and confirmed against the real projection", () => {
  it("AC 1+2: the utterance selects the workflow and the confirm quotes the REAL projected items and total", async () => {
    const { harness, sink, session, runtime } = buildHarness();

    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");

    // AC 6 — the instance PINS the catalog serial it started under.
    const instance = runtime.instanceFor(turn1.turnId);
    expect(instance?.workflowId).toBe(REORDER_LAST_WORKFLOW_ID);
    expect(instance?.catalogVersion).toBe(CATALOG_VERSION);
    // The workflow declares NO params, so there is nothing for a model-supplied
    // value to bind to — and the smuggled `orderId` slot became nothing at all.
    expect(instance?.params.size).toBe(0);
    expect(instance?.unresolved).toEqual([]);

    // AC 2 — the sentence names the REAL lines and the REAL total, both read
    // from the projection by the resolver. Asserted VERBATIM: the guard owns the
    // money formatting, and if the workflow layer ever starts formatting for
    // itself this stops matching.
    const kernelSentence = userFacingOf(turn1.decision);
    expect(kernelSentence).toBe(
      "Vou repetir seu último pedido: 2x Costela bovina defumada, 1x Pão de alho, " +
        "1x Farofa de bacon, total R$ 125,00. Confirma?",
    );
    // The total is the projection's, NOT the sum of the lines (10500) — proof
    // the guard quotes rather than computes.
    expect(kernelSentence).toContain("R$ 125,00");
    expect(kernelSentence).not.toContain("105,00");

    // …and the workflow's confirm template quotes that sentence VERBATIM and
    // alone. `{confirmation}` is the whole template, so the two are equal —
    // there is no second voice in the confirmation.
    expect(runtime.renderConfirm(turn1.turnId)).toBe(kernelSentence);

    // AC 3 (first half) — parked, and NOTHING has executed.
    const parked = session.parksFor(CUSTOMER);
    expect(parked).toHaveLength(1);
    expect(String(parked[0]!.envelope.kind)).toBe("order.reorder.request");
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.reorder.request")).toBe(0);
  });

  it("AC 3+5: accept ⇒ the reorder runs via the workflow-scoped class, per-activity audit, checkout handoff", async () => {
    const { harness, sink, medusa } = buildHarness();

    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });

    expect(turn2.decision.kind).toBe("EXECUTE");

    // The ACTIVITY was adjudicated on its own and wrote its own audit row —
    // indistinguishable from a directly-parsed mutation's.
    const activityRows = sink.byKind("order.reorder");
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]!.decision.kind).toBe("EXECUTE");

    // The trace: one activity, executed, with the pin visible.
    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.outcome).toBe("completed");
    expect(trace?.run.catalogVersion).toBe(CATALOG_VERSION);
    expect(trace?.run.activitiesExecuted).toBe(1);
    expect(trace?.run.activitiesTotal).toBe(1);
    expect(trace?.steps.map((s) => s.activityId)).toEqual(["reorder"]);
    expect(trace?.steps.map((s) => s.decision)).toEqual(["EXECUTE"]);

    // The cart really was rebuilt: a FRESH cart, then one line-item POST per
    // line of the previous order. Asserted on the egress rather than on the
    // handler's return value, because the egress is what the customer gets.
    const posts = medusa.calls.filter((c) => c.method === "POST");
    expect(posts.filter((c) => c.path === "/store/carts")).toHaveLength(1);
    expect(
      posts.filter((c) => /^\/store\/carts\/[^/]+\/line-items$/.test(c.path)),
    ).toHaveLength(PREVIOUS_ORDER_ROW.itemsJson.length);

    // AC 5 — the CHECKOUT HANDOFF. Checkout is deliberately not an activity, so
    // the run ends with a rebuilt cart and the authored template invites the
    // customer into the ordinary checkout flow.
    const acted = turn2.acted as {
      kind?: string;
      result?: { message?: string; workflow?: { outcome?: string; catalogVersion?: number } };
    };
    expect(acted.kind).toBe("executed");
    expect(acted.result?.message).toBe(
      "Pronto! Montei um carrinho novo com os itens do seu último pedido. Quer finalizar?",
    );
    expect(acted.result?.workflow?.outcome).toBe("completed");
    expect(acted.result?.workflow?.catalogVersion).toBe(CATALOG_VERSION);
    // No checkout was created behind the one confirmation the customer gave.
    expect(executed(sink, "order.checkout.create")).toBe(0);
  });

  it("AC 3: decline ⇒ ZERO executions, asserted on the audit sink", async () => {
    const { harness, sink, session, medusa } = buildHarness();

    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);

    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "não, deixa pra lá",
    });

    expect(turn2.decision.kind).not.toBe("EXECUTE");
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.reorder.request")).toBe(0);
    expect(workflowTrace(turn2.turnId)).toBeUndefined();
    // Nothing reached Medusa either — the strongest form of "nothing executed",
    // since an egress is the only thing the customer could actually observe.
    expect(medusa.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("AC 4: no order history ⇒ an honest refusal, and nothing executes", async () => {
    const { harness, sink, session, medusa } = buildHarness({ withHistory: false });

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn.decision.kind).toBe("REFUSE");
    // HONEST — a state fact ("there is nothing to repeat"), never a permission
    // frame. `refuseDefault()`'s "Operação não permitida" would tell a
    // first-time customer they lack permission for something they are perfectly
    // entitled to do, which is exactly the plausible-but-wrong sentence this
    // whole runtime exists to prevent.
    expect(userFacingOf(turn.decision)).toBe(
      "Ainda não encontrei nenhum pedido anterior seu pra repetir. Quer montar um novo?",
    );
    // The stable machine code too, not only the prose: the sentence is
    // reviewable copy and may be reworded, but the code is what an operator
    // filters `intent_audit` on, and it is declared in `ordersPack.basisCodes`
    // where the AaC drift gate can see it.
    expect(refusalCodeOf(turn.decision)).toBe("order.reorder.no_history");

    // No park, no execution, no egress — the route stopped at the anchor.
    expect(session.parksFor(CUSTOMER)).toHaveLength(0);
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.reorder.request")).toBe(0);
    expect(medusa.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("summarises past the cap instead of listing every line", async () => {
    const { harness } = buildHarness();
    orderRowsFake.rows = [
      {
        ...PREVIOUS_ORDER_ROW,
        itemsJson: [
          ...PREVIOUS_ORDER_ROW.itemsJson,
          { productId: "p4", variantId: "v4", title: "Vinagrete", quantity: 1, priceInCentavos: 500 },
          { productId: "p5", variantId: "v5", title: "Guaraná", quantity: 3, priceInCentavos: 700 },
        ],
      },
    ];

    const turn = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    // Three named, the remainder counted — a confirmation the customer has to
    // scroll is one they approve without reading.
    expect(userFacingOf(turn.decision)).toBe(
      "Vou repetir seu último pedido: 2x Costela bovina defumada, 1x Pão de alho, " +
        "1x Farofa de bacon e mais 2 itens, total R$ 125,00. Confirma?",
    );
  });

  it("the workflow is offered to the OWNER only — another customer's order is not reachable", async () => {
    // The projection row belongs to CUSTOMER; this turn is driven as someone
    // else. `listByCustomer` filters in the query, so the read returns nothing
    // and the route refuses honestly — the same path a first-time customer
    // takes. This is the de-vacuuming control for the owner-scoping claim: the
    // fixture DOES hold an order, it just is not this customer's.
    const { harness, sink } = buildHarness();
    const turn = await runCustomerTurn(harness, {
      customerId: "cus_le2021_stranger",
      conversationId: "conv_le2021_stranger",
      text: SELECT_UTTERANCE,
    });

    expect(turn.decision.kind).toBe("REFUSE");
    expect(userFacingOf(turn.decision)).toContain("Ainda não encontrei nenhum pedido anterior");
    expect(executed(sink, "order.reorder")).toBe(0);
  });

  it("is NOT offered to a GUEST — the authentication matcher is load-bearing", async () => {
    // The workflow's matchers are conjunctive: `order.cart.ensure` (the
    // always-proposable cart floor) AND `order.checkout.create` (the orders
    // planner's `if (isAuthenticated)` branch). Without the second conjunct a
    // guest would be offered a route whose anchor must REFUSE at
    // `requireAuthenticated`, which teaches a customer the system offers things
    // it will not do.
    //
    // Asserted on the WIRE rather than on the outcome: an unoffered workflow
    // and a refused one look the same from the reply, and only one of them is
    // what this matcher buys.
    const { harness, model } = buildHarness();
    const scripted = model as unknown as { complete: { mock: { calls: unknown[][] } } };

    await runCustomerTurn(harness, {
      customerId: "guest:le2021-anon",
      conversationId: "conv_le2021_guest",
      text: SELECT_UTTERANCE,
    });

    const plannerCall = scripted.complete.mock.calls
      .map(
        (c) =>
          c[0] as {
            tools?: ReadonlyArray<{
              name: string;
              description: string;
              inputSchema: unknown;
            }>;
          },
      )
      .find((req) => (req.tools?.length ?? 0) > 0);

    expect(plannerCall).toBeDefined();
    expect(plannerCall?.tools?.some((t) => t.name === "start_workflow")).toBe(false);
    // The control: the guest DOES get a surface, so the assertion above is
    // about the matcher and not about an empty tool array.
    expect(plannerCall?.tools?.some((t) => t.name === "express_intent")).toBe(true);
  });
});

describe("LE2-021 — the reorder-last anchor is never on the capability wire", () => {
  it("neither the anchor nor the activity is advertised, while the workflow IS offered", async () => {
    const { harness, model } = buildHarness();
    const scripted = model as unknown as { complete: { mock: { calls: unknown[][] } } };

    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    const plannerCall = scripted.complete.mock.calls
      .map(
        (c) =>
          c[0] as {
            tools?: ReadonlyArray<{
              name: string;
              description: string;
              inputSchema: unknown;
            }>;
          },
      )
      .find((req) => (req.tools?.length ?? 0) > 0);

    const expressIntent = plannerCall?.tools?.find((t) => t.name === "express_intent");
    const advertised = (
      expressIntent?.inputSchema as {
        properties: { capability: { enum: readonly string[] } };
      }
    ).properties.capability.enum;

    // The ASK and the ACT are both off the capability enum — the ask because it
    // is identity-tier, the act because it is workflow-scoped.
    expect(advertised).not.toContain("order.reorder.request");
    expect(advertised).not.toContain("order.reorder");
    // The control: an ordinary chat kind IS advertised, so the two assertions
    // above are about the access classes and not about an empty roster.
    expect(advertised).toContain("order.checkout.create");

    // …and the WORKFLOW is on the wire, with its authored phrasings composed
    // into the description. That is the surface the live drive measures.
    const startWorkflow = plannerCall?.tools?.find((t) => t.name === "start_workflow");
    expect(startWorkflow).toBeDefined();
    expect(String(startWorkflow?.description)).toContain(REORDER_LAST_WORKFLOW_ID);
    expect(String(startWorkflow?.description)).toContain('"repete meu último pedido"');
    expect(String(startWorkflow?.description)).toContain('"manda o de sempre"');
  });
});
