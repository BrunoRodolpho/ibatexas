/**
 * LE2-020 turn-seam e2e — the WORKFLOW RUNTIME driven through a REAL
 * `handleTurn`, with mocks only at the Medusa / Redis / Stripe CLIENT boundary.
 *
 * Structural sibling of `chat-pix-checkout.e2e.test.ts` and built on the same
 * harness, for the reason that file's header gives: a renderer-level or
 * runtime-level test would pass while the feature was dead through the gate
 * (the LE2-002 class). Everything below the model is real — the production
 * planner, the real composed policy router, `adjudicateAndAudit`, the real tool
 * registry, `WebConfirmChannel.matchToParked`.
 *
 * ── THE SHAPE UNDER TEST ─────────────────────────────────────────────────────
 *
 *   turn 1  "quero repetir meu último pedido e finalizar"
 *             → the planner advertises the CLOSED workflow surface
 *             → the model calls `start_workflow`
 *             → the runtime instantiates, PINNING catalog v5
 *             → the ANCHOR envelope (order.checkout.create) is adjudicated
 *             → cart totals R$1.500 ⇒ confirmLargeTicket ⇒ REQUEST_CONFIRMATION
 *             → parked; NOTHING has executed
 *   turn 2  "sim"
 *             → matchToParked ⇒ resume with the receipt ⇒ EXECUTE
 *             → the wrapped anchor tool runs, then the ACTIVITY SEQUENCE:
 *               order.cart.ensure and order.reorder, each adjudicated
 *               INDIVIDUALLY, each writing its own audit row
 *             → the reply is the authored `completed` template
 *
 * and the counterfactual that matters most: turn 2 = "não" ⇒ NOTHING EXECUTES.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./setup.js";

// ── Client-boundary mocks (must be hoisted in the TEST file, not the harness) ──

const { redisFake } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return { redisFake: { strings, hashes } };
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
      confirm: vi.fn().mockResolvedValue({ id: "pi_le2020", status: "succeeded" }),
      update: vi.fn().mockResolvedValue({ id: "pi_le2020" }),
      retrieve: vi.fn().mockResolvedValue({ id: "pi_le2020" }),
    },
  })),
}));

const {
  composeCustomerConductor,
  makeAuditedAdjudicator,
  makeCapturingAuditSink,
  makeCartFixture,
  makeMedusaFetchFake,
  makeStatefulCustomerSession,
  runCustomerTurn,
  scriptedModel,
  throwingModel,
} = await import("./customer-e2e-harness.js");
const { rk } = await import("@ibatexas/tools");
const { loadCartCtx } = await import("../claustrum/resolve-and-assemble.js");
const { createWorkflowRuntime } = await import(
  "../claustrum/workflow/workflow-runtime.js"
);
const { workflowTrace } = await import("../claustrum/workflow/workflow-trace.js");
const { createParseFunnel, renderL0Reply } = await import("../claustrum/funnel-tier.js");
const { CUSTOMER_ROUTER } = await import("./customer-e2e-harness.js");
const { CATALOG_VERSION, FIXTURE_WORKFLOWS, FIXTURE_WORKFLOW_ID } = await import(
  "@ibatexas/catalog"
);
const { adjudicateAndAudit } = await import("@adjudicate/core/kernel");
const { buildLanguageEngineAuditMetadata } = await import(
  "../claustrum/language-engine/audit-metadata.js"
);

const CUSTOMER = "cus_le2020_owner";
const CONVERSATION = "conv_le2020";
const CART_ID = "cart_le2020";
const PREVIOUS_ORDER = "order_le2020_previous";

/** The utterance that selects the fixture workflow. */
const SELECT_UTTERANCE = "quero repetir meu último pedido e finalizar";

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "harness-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_le2020";
  process.env.KERNEL_TENANT_ID = "ibatexas";
}

/**
 * The Medusa egress the two ACTIVITIES make, on top of what the checkout
 * anchor needs. Layered over the harness's fake rather than replacing it, and
 * still throwing on anything unrouted — an unexpected egress must fail the
 * test, never degrade into a swallowed error.
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
      // `order.reorder`'s handler reads the previous order, then re-adds its
      // line items to a fresh cart.
      if (method === "GET" && path === `/admin/orders/${PREVIOUS_ORDER}`) {
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
      // `reorder` creates a FRESH cart, then adds the previous order's items.
      if (method === "POST" && path === "/store/carts") {
        base.calls.push({ method, path });
        return json({ cart: { id: "cart_le2020_reordered" } });
      }
      if (method === "POST" && /^\/store\/carts\/[^/]+\/line-items$/.test(path)) {
        base.calls.push({ method, path });
        return json({ cart: { id: "cart_le2020_reordered" } });
      }
      return base.fetch(input, init);
    },
  };
}

/**
 * A full harness with the workflow runtime wired into all three seams. The
 * runtime's kernel access is the REAL `adjudicateAndAudit` over the REAL
 * composed router and the SAME capturing sink the conductor uses — so an
 * activity's audit row is indistinguishable from a directly-parsed mutation's,
 * which is the point.
 */
function buildHarness(
  opts: { readonly claims?: ReadonlyMap<string, Record<string, unknown>> } = {},
) {
  const cart = makeCartFixture({ id: CART_ID });
  const medusa = withActivityRoutes(makeMedusaFetchFake(cart));
  vi.stubGlobal("fetch", medusa.fetch);
  redisFake.strings.set(rk(`cart:active:session:${CONVERSATION}`), CART_ID);

  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession();

  const model = scriptedModel([
    {
      id: "tu_le2020",
      name: "start_workflow",
      input: {
        workflow: FIXTURE_WORKFLOW_ID,
        slots: {
          note: "sem cebola",
          // The snake_case wire keys the model really produces for the anchor's
          // own required slots; the real resolver renames them.
          payment_method: "pix",
          delivery_type: "pickup",
          // An UNDECLARED slot the model tried to smuggle — the parse seam must
          // drop it by name (`sanitizeWorkflowSlots`).
          orderId: "order_MODEL_INVENTED",
        },
      },
    },
  ]);

  const adjudicator = makeAuditedAdjudicator({
    sink,
    projectResumeState: async (envelope) => {
      const payload = (envelope.payload ?? {}) as Record<string, unknown>;
      const ctx = await loadCartCtx(
        {
          tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
          channel: "web",
          customerId: CUSTOMER,
          staffId: null,
          isAuthenticated: true,
        } as never,
        payload as never,
        { sessionId: CONVERSATION },
      );
      return { ctx } as never;
    },
  });

  // The runtime's own kernel seam: the REAL audited kernel over the REAL router.
  // Per-activity state is projected from the live cart exactly as the resume
  // path does, so an activity meets the same grounded state a direct request
  // would.
  const activityState = async (): Promise<unknown> => {
    const ctx = await loadCartCtx(
      {
        tenantId: process.env.KERNEL_TENANT_ID ?? "ibatexas",
        channel: "web",
        customerId: CUSTOMER,
        staffId: null,
        isAuthenticated: true,
      } as never,
      {} as never,
      { sessionId: CONVERSATION },
    );
    return { ctx };
  };

  // A genuine forward reference, not a stray `let`: the runtime's
  // `dispatchActivity` closure needs the tool registry, the registry comes from
  // `composeCustomerConductor`, and that call needs the runtime. A holder
  // object breaks the cycle without a reassignable binding.
  const harnessRef: {
    current?: ReturnType<typeof composeCustomerConductor>;
  } = {};
  const runtime = createWorkflowRuntime({
    workflows: FIXTURE_WORKFLOWS,
    adjudicateActivity: async (envelope) =>
      (
        await adjudicateAndAudit(
          envelope,
          (await activityState()) as never,
          CUSTOMER_ROUTER as never,
          { sink, metadataProvider: buildLanguageEngineAuditMetadata },
        )
      ).decision,
    dispatchActivity: async (envelope, ctx) => {
      const tool = harnessRef.current?.tools
        .list()
        .find((t) => String(t.capability) === String(envelope.kind));
      if (tool === undefined) {
        throw new Error(`no registered tool for ${String(envelope.kind)}`);
      }
      return tool.execute(envelope.payload, ctx);
    },
    ...(opts.claims === undefined
      ? {}
      : { claimsFor: () => opts.claims as never }),
  });

  const harness = composeCustomerConductor({
    model,
    session,
    adjudicator,
    workflowRuntime: runtime,
  });
  harnessRef.current = harness;
  return { harness, sink, session, runtime, medusa };
}

/** The claims the claims kernel VALIDATED this turn, in the runtime's shape. */
function validatedClaims(): ReadonlyMap<string, Record<string, unknown>> {
  return new Map([["order-placed", { orderId: PREVIOUS_ORDER }]]);
}

/** Audit records for a kind, EXECUTE only. */
function executed(
  sink: ReturnType<typeof makeCapturingAuditSink>,
  kind: string,
): number {
  return sink
    .byKind(kind)
    .filter((r) => r.decision.kind === "EXECUTE").length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  seedEnv();
});

describe("LE2-020 turn seam — a catalog-declared workflow, selected, confirmed and run", () => {
  it("selects from the closed surface, confirms the WHOLE workflow with a grounded amount, then adjudicates each activity individually", async () => {
    const { harness, sink, session, runtime } = buildHarness({
      claims: validatedClaims(),
    });

    // ── Turn 1 — SELECT. The anchor's money band parks the whole workflow ─────
    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });

    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");

    // The instance exists and PINS the catalog version it started under.
    const instance = runtime.instanceFor(turn1.turnId);
    expect(instance?.workflowId).toBe(FIXTURE_WORKFLOW_ID);
    expect(instance?.catalogVersion).toBe(CATALOG_VERSION);

    // The undeclared slot the model tried to smuggle never became a param.
    expect(instance?.params.has("orderId")).toBe(false);
    expect(instance?.params.get("note")).toEqual({ resolved: true, value: "sem cebola" });
    // The claim-sourced param came from the VALIDATED claim, not the model.
    expect(instance?.params.get("previousOrderId")).toEqual({
      resolved: true,
      value: PREVIOUS_ORDER,
    });

    // The whole-workflow confirm QUOTES the kernel's grounded sentence — the
    // R$1.500 in it is the guard's own number, never one the workflow computed.
    // The number is the guard's own formatting, asserted verbatim: if the
    // workflow layer ever starts formatting money itself, this stops matching.
    const confirm = runtime.renderConfirm(turn1.turnId);
    expect(confirm).toContain("Esse pedido soma R$ 1500,00.");
    expect(confirm).toContain("sem cebola");

    // NOTHING has executed yet — the park is the whole point.
    const parked = session.parksFor(CUSTOMER);
    expect(parked).toHaveLength(1);
    expect(String(parked[0]!.envelope.kind)).toBe("order.checkout.create");
    expect(executed(sink, "order.cart.ensure")).toBe(0);
    expect(executed(sink, "order.reorder")).toBe(0);

    // ── Turn 2 — CONFIRM. The activities run, each on its own audit row ───────
    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });

    expect(turn2.decision.kind).toBe("EXECUTE");

    // EACH ACTIVITY, INDIVIDUALLY ADJUDICATED, EACH WITH ITS OWN AUDIT ROW.
    expect(executed(sink, "order.cart.ensure")).toBe(1);
    expect(executed(sink, "order.reorder")).toBe(1);

    // The trace: per-workflow identity + per-step outcomes, with the pin visible.
    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.outcome).toBe("completed");
    expect(trace?.run.catalogVersion).toBe(CATALOG_VERSION);
    expect(trace?.run.activitiesExecuted).toBe(2);
    expect(trace?.run.activitiesTotal).toBe(2);
    expect(trace?.steps.map((s) => s.activityId)).toEqual(["ensure", "reorder"]);
    expect(trace?.steps.map((s) => s.decision)).toEqual(["EXECUTE", "EXECUTE"]);
    expect(trace?.steps.every((s) => s.executed)).toBe(true);

    // The reply is the AUTHORED template for the outcome reached.
    const acted = turn2.acted as {
      kind?: string;
      result?: { message?: string; workflow?: { outcome?: string; catalogVersion?: number } };
    };
    expect(acted.kind).toBe("executed");
    expect(acted.result?.message).toBe("Pronto! Concluí todas as etapas do seu pedido.");
    expect(acted.result?.workflow?.outcome).toBe("completed");
    // AC 5 — the PIN is visible on the executed action, not only in the log.
    expect(acted.result?.workflow?.catalogVersion).toBe(CATALOG_VERSION);
  });

  it("CONFIRM DECLINED ⇒ nothing executes", async () => {
    const { harness, sink, session } = buildHarness({ claims: validatedClaims() });

    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);

    // The customer says no.
    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "não, deixa pra lá",
    });

    // The whole point: NOT ONE activity ran, and the anchor did not execute
    // either. Asserted on the AUDIT SINK rather than on a spy, because the
    // audit trail is what an operator would actually be able to check.
    expect(turn2.decision.kind).not.toBe("EXECUTE");
    expect(executed(sink, "order.cart.ensure")).toBe(0);
    expect(executed(sink, "order.reorder")).toBe(0);
    expect(executed(sink, "order.checkout.create")).toBe(0);
    expect(workflowTrace(turn2.turnId)).toBeUndefined();
  });

  it("a param that no VALIDATED claim supplies fails the run closed — nothing is submitted", async () => {
    // No claims wired at all: `previousOrderId` cannot resolve. The workflow
    // must refuse to submit an activity rather than fill the hole.
    const { harness, sink } = buildHarness();

    const turn1 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    expect(turn1.decision.kind).toBe("REQUEST_CONFIRMATION");

    const turn2 = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });

    const trace = workflowTrace(turn2.turnId);
    expect(trace?.run.outcome).toBe("failed");
    expect(trace?.steps).toHaveLength(0);
    // Not one activity envelope reached the kernel — the run stopped BEFORE
    // submitting anything, which is the difference between "refused" and
    // "executed against a value nobody authored".
    expect(sink.byKind("order.cart.ensure")).toHaveLength(0);
    expect(sink.byKind("order.reorder")).toHaveLength(0);

    const acted = turn2.acted as { result?: { message?: string } };
    expect(acted.result?.message).toBe(
      "Não consegui concluir todas as etapas. Já chamei alguém da equipe para te ajudar.",
    );
  });
});

describe("LE2-020 — the WORKFLOW-SCOPED access class, at the real parse seam", () => {
  it("NEGATIVE: the parser cannot emit a workflow-scoped kind — not advertised, not accepted", async () => {
    // Called for its FIXTURE SETUP and its sink — the composed harness it
    // returns is deliberately discarded. The rogue composition below wires NO
    // workflow runtime, which makes this the stronger claim: the access class
    // holds even in a composition that never loaded a workflow, because the
    // subtraction is unconditional rather than a service the runtime provides.
    const { sink } = buildHarness({ claims: validatedClaims() });
    // A model that tries to propose the workflow-scoped kind DIRECTLY, as a
    // free verb. This is the attack the access class exists for: a
    // hallucination, a stale cached parse, or a prompt injection.
    const rogue = scriptedModel([
      {
        id: "tu_rogue",
        name: "express_intent",
        input: { capability: "order.reorder", payload: { orderId: PREVIOUS_ORDER } },
      },
    ]);
    const rogueHarness = composeCustomerConductor({
      model: rogue,
      session: makeStatefulCustomerSession(),
      adjudicator: makeAuditedAdjudicator({ sink }),
    });

    const turn = await runCustomerTurn(rogueHarness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "repete meu último pedido",
    });

    // The envelope was never built, so the kernel never saw it and there is no
    // audit row at all — the parse seam dropped it, which is stronger than a
    // refusal (a refusal would mean the kind reached adjudication).
    expect(sink.byKind("order.reorder")).toHaveLength(0);
    expect(turn.decision.kind).not.toBe("EXECUTE");

    // And it is not on the wire either: the advertised capability enum, which is
    // what the model is shown, does not contain it.
    const complete = (rogue as unknown as { complete: { mock: { calls: unknown[][] } } })
      .complete;
    const plannerCall = complete.mock.calls
      .map((c) => c[0] as { tools?: ReadonlyArray<{ name: string; inputSchema: unknown }> })
      .find((req) => (req.tools?.length ?? 0) > 0);
    const expressIntent = plannerCall?.tools?.find((t) => t.name === "express_intent");
    const advertised = (
      expressIntent?.inputSchema as {
        properties: { capability: { enum: readonly string[] } };
      }
    ).properties.capability.enum;
    expect(advertised).not.toContain("order.reorder");
    // The control: an ordinary chat kind IS advertised, so the assertion above
    // is about the access class and not about an empty roster.
    expect(advertised).toContain("order.checkout.create");
  });

  it("POSITIVE: an instantiated workflow's executor CAN invoke it, through full kernel adjudication", async () => {
    const { harness, sink } = buildHarness({ claims: validatedClaims() });

    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });

    // The same kind the parser could not emit reached the kernel and EXECUTEd —
    // and it did so through a real adjudication with a real audit row, not
    // through a bypass.
    const rows = sink.byKind("order.reorder");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision.kind).toBe("EXECUTE");
  });
});

describe("LE2-020 — the workflow confirm rides the EXISTING park machinery", () => {
  it("a parked workflow confirm blocks L0 exactly like any other park (FE-D32)", async () => {
    // The whole-workflow confirm is an ordinary REQUEST_CONFIRMATION park, so
    // every rule about open confirm windows applies to it unchanged — including
    // the ratified one that L0 must not fire while a window is open. If a warm
    // greeting template could land here, it would answer past a pending
    // multi-step money decision.
    //
    // Asserted on the REPLY TEXT, not on `funnelStage`: `runCustomerTurn`'s
    // `finally` calls `closeFunnelTurn`, which drops the stage record, so the
    // stage is unreadable by the time a caller sees the result. The L0 template
    // is the tier's whole deliverable anyway.
    const funnel = createParseFunnel();
    const greeting = renderL0Reply("greeting");
    const { harness, session } = buildHarness({ claims: validatedClaims() });

    // CONTROL — a social utterance with NO park open: L0 answers from its
    // template. `throwingModel` makes it a genuine zero-model-call proof: if L0
    // stood down here the turn would throw instead of quietly costing a call.
    const control = await runCustomerTurn(
      composeCustomerConductor({
        model: throwingModel("L0 control"),
        session: makeStatefulCustomerSession(),
        adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
        funnel,
        realResponder: true,
      }),
      { customerId: CUSTOMER, conversationId: CONVERSATION, text: "oi" },
    );
    expect(control.response).toBe(greeting);

    // Now park a workflow confirm, then send the SAME social utterance.
    const selecting = await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: SELECT_UTTERANCE,
    });
    expect(selecting.decision.kind).toBe("REQUEST_CONFIRMATION");
    expect(session.parksFor(CUSTOMER)).toHaveLength(1);

    const blocked = await runCustomerTurn(
      composeCustomerConductor({
        model: scriptedModel([], { responderText: "resposta do modelo" }),
        session,
        adjudicator: makeAuditedAdjudicator({ sink: makeCapturingAuditSink() }),
        funnel,
        realResponder: true,
      }),
      { customerId: CUSTOMER, conversationId: CONVERSATION, text: "oi" },
    );

    // L0 stood down — the greeting template did NOT land on a turn with an open
    // workflow confirm window, so the restate-then-confirm path still owns it.
    expect(blocked.response).not.toBe(greeting);
  });
});
