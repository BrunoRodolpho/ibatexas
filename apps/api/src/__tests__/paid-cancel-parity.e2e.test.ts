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

const { redisFake, orderRowsFake, paymentRowsFake, natsSpy, storeDown } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  return {
    redisFake: { strings, hashes },
    orderRowsFake: { rows: [] as Record<string, unknown>[] },
    paymentRowsFake: { rows: new Map<string, Record<string, unknown>>() },
    natsSpy: { calls: [] as { event: string; payload: Record<string, unknown> }[] },
    /**
     * LE2-024 — make the projection READ THROW, not merely come back empty.
     *
     * A `vi.spyOn(createOrderQueryService(), …)` cannot express this: the factory
     * returns a FRESH object per call, so the spy binds to an instance nothing
     * downstream ever uses and the drive succeeds while the test believes the
     * store is down. The switch has to live inside the double.
     */
    storeDown: { on: false },
  };
});

vi.mock("redis", () => {
  const client = {
    // BKL-282 — the marker the isolation guard below the imports reads back.
    // A literal, not a module const: `vi.mock` factories are hoisted and can
    // run before this module's body, which would put any const in TDZ.
    __ibxRedisDouble: true,
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
    // No `multi()`: M4 measured this file's whole run and it never reaches a
    // production multi() site, so a stub here covers nothing while silently
    // DROPPING any queued write a future path adds (census, M4). Left absent so
    // that path fails loudly instead; real Redis is the home if one needs a
    // transaction's effect (W4 RULE 3 — the adapter does not emulate multi).
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
        if (storeDown.on) throw new Error("projection store unreachable");
        const row = orderRowsFake.rows.find((r) => r["id"] === id) ?? null;
        if (row === null) return null;
        if (opts?.customerId !== undefined && row["customerId"] !== opts.customerId) {
          return null;
        }
        return row;
      },
      listByCustomer: async (customerId: string, input?: { limit?: number }) => {
        if (storeDown.on) throw new Error("projection store unreachable");
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

// ── BKL-282: the doubles above only bind under per-file module isolation ──────
//
// THE FAILURE THIS REPLACES. Under `vitest --no-isolate` the module registry is
// shared across files, so `@ibatexas/tools` — already evaluated by an earlier
// file (e.g. scripted-pipeline, which drives a REAL Redis testcontainer) — keeps
// its binding to the REAL `redis` package and this file's `vi.mock("redis")`
// never reaches it. `getRedisClient()` then builds a REAL client against
// `REDIS_URL` (`seedEnv` points it at localhost:6379, where nothing listens),
// and every Redis touch pays a full bounded-reconnect cycle: 10 attempts with
// exponential backoff capped at 3s, restarted by the NEXT call — per
// `packages/tools/src/redis/client.ts`. Bounded per call, but ~20s × dozens of
// calls, so the run made no progress for as long as anyone let it sit. A hang
// is the worst way to report this: it names nothing and it wedges the session
// that ran it.
//
// WHY A GUARD RATHER THAN A REPAIR. `--no-isolate` breaks module doubles by
// construction — the same leak disarms this file's `@ibatexas/domain`, `stripe`
// and NATS mocks too, and no per-file code can re-bind an import another file
// already resolved. So the honest outcome is to FAIL FAST, naming the flag and
// the mechanism, instead of degrading into a silent reconnect spin.
//
// The probe has to be asked of `@ibatexas/tools`, NOT of `redis`: importing
// `redis` HERE always yields this file's double (vitest binds the mock for the
// importing file), while the leak is entirely about which module instance TOOLS
// resolved. So the guard reads the client tools actually hands out, and it pins
// the client's own fail-fast knobs first — if the double is missing, that call
// reaches a real socket, and these two make it give up at once instead of
// starting the very spin the guard exists to prevent.
//
// This costs a default run one no-op call on the fake and asserts nothing about
// behaviour: it is a statement of the harness contract the file is written
// against.
const { getRedisClient, rk } = await import("@ibatexas/tools");

{
  const saved = {
    url: process.env.REDIS_URL,
    connectTimeout: process.env.REDIS_CONNECT_TIMEOUT_MS,
    reconnects: process.env.REDIS_MAX_RECONNECT_ATTEMPTS,
  };
  process.env.REDIS_URL = saved.url ?? "redis://localhost:6379";
  process.env.REDIS_CONNECT_TIMEOUT_MS = "50";
  process.env.REDIS_MAX_RECONNECT_ATTEMPTS = "0";
  let doubleInstalled = false;
  try {
    const client = (await getRedisClient()) as unknown as {
      __ibxRedisDouble?: unknown;
    };
    doubleInstalled = client.__ibxRedisDouble === true;
  } catch {
    doubleInstalled = false;
  } finally {
    for (const [key, value] of [
      ["REDIS_URL", saved.url],
      ["REDIS_CONNECT_TIMEOUT_MS", saved.connectTimeout],
      ["REDIS_MAX_RECONNECT_ATTEMPTS", saved.reconnects],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (!doubleInstalled) {
    throw new Error(
      "[paid-cancel-parity] the `redis` double is NOT the client `@ibatexas/tools` " +
        "hands out: tools kept its binding to the REAL `redis` package, so every " +
        "Redis touch in this file would open a live socket and reconnect-spin " +
        "instead of reading the in-memory fake. This is what `--no-isolate` does to " +
        "a mock-based suite — a shared module registry keeps the binding an earlier " +
        "file resolved, and the same leak disarms this file's `@ibatexas/domain`, " +
        "`stripe` and NATS doubles too. Run this suite with vitest's default " +
        "per-file isolation. (BKL-282)",
    );
  }
}

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
const { resolveWorkflowName } = await import("../claustrum/workflow/workflow-surface.js");
const {
  buildEscalationParkInput,
  ESCALATION_RESUMABLE_KINDS,
  summarizeEscalation,
} = await import("../escalation/escalation-park-store.js");
type EscalationParkStore = import("../escalation/escalation-park-store.js").EscalationParkStore;
type ParkedEscalationIntent =
  import("../escalation/escalation-park-store.js").ParkedEscalationIntent;
const { createEscalationApprovalEngine } = await import("../escalation/escalation-approval.js");
const { createApprovedOrderCancelExecutor } = await import(
  "../escalation/approved-cancel-executor.js"
);
const { settleApprovedInnerRefund } = await import("../escalation/approved-inner-refund.js");
const { buildOpsRefundResumeState } = await import("../ops/ops-resolver.js");
const { adjudicateAndAudit } = await import("@adjudicate/core/kernel");
const { buildEnvelope } = await import("@adjudicate/core");
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
/**
 * R$1.500 — comfortably ABOVE the band, and the SAME constant
 * `chat-cancel-escalate-approve.e2e.test.ts` and the swap-for-coupon suite both
 * use. Aligned deliberately: the approve/resume cases below are the direct
 * ladder's own scenario re-driven through the workflow, and a different amount
 * would make the two files' escalations incomparable for no reason.
 *
 * {@link EXACTLY_AT} stays the boundary case neither of those files pins.
 */
const BIG_TOTAL = 150_000;

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
      //
      // BKL-281 — this arm answers for MEDUSA and writes NOTHING into
      // `orderRowsFake`, which is the DOMAIN projection's fixture and a
      // different store.
      //
      // Production keeps them separate on purpose: `executeOrderCancel`
      // transitions the domain projection through `createOrderCommandService`
      // (authoritative, awaited) and then mirrors the cancel to Medusa in a
      // DETACHED `void (async () => …)()` — order-actions.ts "finding 29" —
      // so `public."order"` stops reading stale. The mirror updates Medusa's
      // own row, never the projection.
      //
      // The double used to flip `fulfillmentStatus` here too, and that
      // conflation is what made this file order-dependent. The detached call
      // resolves the global `fetch` stub at CALL time, so whenever it lands
      // late it goes through whichever harness is CURRENT: a cancel driven on
      // one arm re-wrote the fixture the NEXT arm had just seeded as pending,
      // and the workflow arm met `already_cancelled` on its own fresh order.
      // It only bit the FIRST cancel of a vitest process (a cold medusa admin
      // token + an unloaded module graph delay the mirror past the re-seed;
      // once warm it lands inside its own arm and is a no-op on an
      // already-canceled row) — which is precisely why the file was green in
      // declaration order and red whenever a cancel test ran first.
      //
      // Nothing is lost by not writing: every `orderStatus` assertion in this
      // file reads a status the DOMAIN transition wrote, in the same arm,
      // synchronously — and the two `not.toBe("canceled")` cases can no longer
      // be falsified by a stray write from a retired arm.
      if (method === "POST" && /^\/admin\/orders\/[^/]+\/cancel$/.test(path)) {
        base.calls.push({ method, path });
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

/** In-memory single-use park store — the production one is Redis-backed. */
function makeFakeParkStore(): EscalationParkStore & {
  size(): number;
  lastToken(): string | undefined;
  all(): ParkedEscalationIntent[];
} {
  const m = new Map<string, ParkedEscalationIntent>();
  let last: string | undefined;
  return {
    async park(input) {
      const token = input.token ?? `park-${m.size + 1}`;
      m.set(token, { ...input, token });
      last = token;
      return { token, ttlSeconds: 86_400 };
    },
    async consume(token) {
      const r = m.get(token) ?? null;
      if (r) m.delete(token);
      return r;
    },
    async get(token) {
      return m.get(token) ?? null;
    },
    size: () => m.size,
    lastToken: () => last,
    all: () => [...m.values()],
  };
}

/**
 * THE REAL PARKING HANDOFF — `natsHandoff(publish, parkDeps)`'s exact shape, and
 * the reason this suite can make a BKL-103 claim at all.
 *
 * ── WHY AN ARRAY DOUBLE WOULD NOT DO ────────────────────────────────────────
 *
 * The swap-for-coupon suite pushes escalated envelopes onto an array, which was
 * right for ITS ticket: the claim there was "an escalated activity reaches a
 * staff surface at all", and an array proves the port was called. Parity needs
 * more. Ticket 24's criterion is that the BKL-103 contract is INTACT, and that
 * contract is not "something was queued" — it is that an OWNER can APPROVE the
 * thing and exactly one cancel happens. An array cannot be approved.
 *
 * So both planes get the real `buildEscalationParkInput` over a real park store,
 * and the same store is handed to the real `createEscalationApprovalEngine`
 * below. The gate is `ESCALATION_RESUMABLE_KINDS` exactly as in production —
 * which is also what makes "the workflow parks the ACTIVITY, not the anchor" a
 * load-bearing property rather than a cosmetic one: an `order.cancel.request`
 * would not pass this gate and nothing would park at all.
 */
function makeParkingHandoff(parkStore: EscalationParkStore): {
  queue: (
    envelope: { readonly kind: unknown; readonly payload?: unknown },
    reason: string,
  ) => Promise<void>;
  reasons: string[];
} {
  const reasons: string[] = [];
  return {
    reasons,
    queue: async (envelope, reason) => {
      reasons.push(reason);
      if (ESCALATION_RESUMABLE_KINDS.has(String(envelope.kind))) {
        await parkStore.park(buildEscalationParkInput(envelope as never));
      }
    },
  };
}

/**
 * The FRESH customer-plane resume projection, built by the SAME production pair
 * the customer branch of `enrichResumeState` composes. Driving the real
 * projector rather than a ctx literal is what makes the state-changed-under-park
 * case mean anything.
 */
async function projectCancelResumeState(envelope: {
  readonly kind: unknown;
  readonly payload?: unknown;
}): Promise<unknown> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const customerId = typeof payload["actorId"] === "string" ? payload["actorId"] : "";
  if (customerId === "") return { ctx: { exists: false } };
  const { ctx } = await resolveAndAssemble({
    kind: String(envelope.kind),
    payload,
    customerId,
    channel: "web",
  } as never);
  return { ctx };
}

/**
 * THE REAL APPROVAL ENGINE, wired exactly as
 * `chat-cancel-escalate-approve.e2e.test.ts` wires it — same executor, same
 * adjudicated inner refund, same router, same sink.
 *
 * Built as a shared factory rather than duplicated per path, because a parity
 * claim about approve/resume is only worth anything if BOTH sides are driven
 * through the SAME engine. Two separately-configured engines could agree by
 * construction while the parks they consume differ.
 */
function buildApprovalEngine(args: {
  readonly parkStore: EscalationParkStore;
  readonly sink: ReturnType<typeof makeCapturingAuditSink>;
  readonly onCancel: (a: { orderId: string; customerId: string }) => void;
}) {
  const { parkStore, sink, onCancel } = args;
  const markSpy = vi.fn(async () => null);
  const engine = createEscalationApprovalEngine({
    get: (t: string) => parkStore.get(t),
    consume: (t: string) => parkStore.consume(t),
    rebuildState: projectCancelResumeState as never,
    policyFor: () => CUSTOMER_ROUTER as never,
    sink,
    executors: {
      "order.cancel": createApprovedOrderCancelExecutor({
        getOrder: async (orderId: string, customerId: string) => {
          const row = orderRowsFake.rows.find((r) => r["id"] === orderId);
          if (row === undefined || row["customerId"] !== customerId) return null;
          return {
            fulfillmentStatus: String(row["fulfillmentStatus"]),
            displayId: Number(row["displayId"]),
          };
        },
        findActivePayment: async (orderId: string) =>
          ([...paymentRowsFake.rows.values()].find(
            (p) => p["orderId"] === orderId && p["status"] === "paid",
          ) as never) ?? null,
        getPayment: async (paymentId: string) =>
          (paymentRowsFake.rows.get(paymentId) as never) ?? null,
        isPaidStatus: (status: string) => status === "paid",
        settleInnerRefund: (a: Parameters<typeof settleApprovedInnerRefund>[1]) =>
          settleApprovedInnerRefund(
            {
              projectPaymentState: async (paymentId: string) => {
                const p = paymentRowsFake.rows.get(paymentId);
                return buildOpsRefundResumeState(
                  p === undefined
                    ? null
                    : ({
                        status: String(p["status"]),
                        amountInCentavos: Number(p["amountInCentavos"]),
                        refundedAmountCentavos: Number(p["refundedAmountCentavos"] ?? 0),
                        method: String(p["method"]),
                        version: Number(p["version"] ?? 1),
                        orderId: String(p["orderId"]),
                      } as never),
                  "ibatexas",
                );
              },
              policyForRefund: () => CUSTOMER_ROUTER,
              adjudicate: async ({
                envelope,
                state,
                policy,
                receipt,
              }: {
                envelope: unknown;
                state: unknown;
                policy: unknown;
                receipt: unknown;
              }) =>
                (
                  await adjudicateAndAudit(envelope as never, state as never, policy as never, {
                    sink,
                    confirmationReceipt: receipt,
                  } as never)
                ).decision,
              writeRefund: async (
                payload: { paymentId: string; refundAmountCentavos?: number },
                approverStaffId: string,
              ) => {
                const p = paymentRowsFake.rows.get(payload.paymentId)!;
                paymentRowsFake.rows.set(payload.paymentId, {
                  ...p,
                  status: "refunded",
                  refundedAmountCentavos: payload.refundAmountCentavos ?? 0,
                  refundApprover: approverStaffId,
                  version: Number(p["version"] ?? 1) + 1,
                });
              },
              now: () => "2026-07-27T13:00:00.000Z",
            } as never,
            a,
          ),
        runCancel: async (a: { orderId: string; customerId: string }) => {
          onCancel(a);
          const row = orderRowsFake.rows.find((r) => r["id"] === a.orderId);
          if (row !== undefined) row["fulfillmentStatus"] = "canceled";
        },
      }) as never,
    },
    markIntentResolved: markSpy as never,
    now: () => "2026-07-27T13:00:00.000Z",
  });
  return { engine, markSpy };
}

// ── The two harnesses, over ONE fixture set ───────────────────────────────────

/** Which path a run drives. The suite's whole vocabulary. */
type Path = "direct" | "workflow";

interface HarnessOpts {
  readonly path: Path;
  /**
   * BKL-275 — the exact string the parse wrote into `start_workflow.workflow`.
   * Defaults to the declared id. Overridden by the BKL-275 block to drive the
   * BARE-SUFFIX form the live engine was measured emitting.
   */
  readonly workflowName?: string;
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
function workflowCall(name: string): ScriptedToolCall {
  return {
    id: "tc-workflow-cancel",
    name: "start_workflow",
    input: { workflow: name, slots: {} },
  };
}

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
  // DEEP-COPIED, not spread. A parity case builds ONE fixture array and drives it
  // down BOTH paths, so sharing the row OBJECTS lets the first arm's cancel
  // mutate the second arm's starting state — which showed up as the workflow
  // arm meeting `already_cancelled` on a fixture the test had just declared
  // pending. The array spread copies the list and not the rows.
  orderRowsFake.rows = (opts.orders ?? [orderRow({ totalInCentavos: total })]).map((r) => ({
    ...r,
  }));
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

  const channel = opts.channel ?? "web";
  const sink = makeCapturingAuditSink();
  const session = makeStatefulCustomerSession(channel);
  // ONE park store, handed to BOTH the conductor's handoff (the direct plane's
  // escalate seam) and — for the workflow path — the runtime's
  // `escalationHandoff`. Production passes the SAME `natsHandoff(publish,
  // escalationHandoffParkDeps)` to both, so sharing it here is fidelity rather
  // than convenience: it is what makes "the two planes park into the same place,
  // in the same shape" a thing this suite can assert instead of assume.
  const parkStore = makeFakeParkStore();
  const handoff = makeParkingHandoff(parkStore);
  const cancels: { orderId: string; customerId: string }[] = [];
  const approval = buildApprovalEngine({
    parkStore,
    sink,
    onCancel: (a) => cancels.push(a),
  });

  const model = scriptedModel([
    opts.path === "direct"
      ? directCall(opts.directOrderId)
      : workflowCall(opts.workflowName ?? PAID_CANCEL_WORKFLOW_ID),
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
    return { harness, sink, session, handoff, medusa, model, parkStore, approval, cancels, runtime: undefined };
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
  return { harness, sink, session, handoff, medusa, model, parkStore, approval, cancels, runtime };
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
  /** The sessionId the Escalações panel and the approve route both match on. */
  readonly parkedSessionIds: readonly string[];
  /** The pt-BR staff summary `summarizeEscalation` authored. */
  readonly parkedSummaries: readonly string[];
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
  parkStore: ReturnType<typeof makeFakeParkStore>,
  renders: readonly string[],
): Observation {
  const parked = parkStore.all();
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
    parkedKinds: parked.map((p) => String(p.intentKind)),
    parkedActorIds: parked.map((p) => p.proposerId),
    parkedSessionIds: parked.map((p) => String(p.sessionId)),
    parkedSummaries: parked.map((p) => String(p.summaryPtBr)),
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
/**
 * THE DIRECT LADDER, driven where it still LIVES — LE2-024's retirement half.
 *
 * Until the retirement this arm sent chat turns and let the planner mint an
 * `order.cancel` envelope. That route is gone: the kind is identity-tier and off
 * the `express_intent` enum, so the planner drops it and a turn-seam direct arm
 * would measure the retirement instead of the ladder.
 *
 * The LADDER is untouched, and a live plane still exercises it — the HTTP cancel
 * routes build exactly this envelope (`{orderId, actorId, reason}` off the
 * authenticated customer, no parse) and adjudicate it against
 * `resolveAndAssemble` state, re-adjudicating with a receipt on the confirm leg.
 * So the parity comparison survives the retirement intact, which is the point:
 * the claim was always about the MONEY LADDER, never about the parse.
 *
 * `renders` on this plane are the DECISION's own sentences — what the route hands
 * back — because an HTTP caller gets no responder prose. That is also why the
 * paid-cancel question is finally VISIBLE here: with an explicit order id nothing
 * stamps `autoResolvedMoneyRef`, so `confirmOnAutoResolvedRef` never parks in
 * front of `gatePaidCancel`.
 */
async function driveDirectKernel(
  opts: HarnessOpts & { readonly answer?: string },
): Promise<Observation & { readonly turnIds: readonly string[] }> {
  const { sink, parkStore, handoff } = buildHarness({ ...opts, path: "direct" });
  const payload = {
    orderId: ORDER_ID,
    actorId: CUSTOMER,
    reason: "Cancelado a pedido do cliente",
  };
  const envelope = buildEnvelope({
    kind: "order.cancel",
    payload,
    actor: { principal: "llm", role: "customer", sessionId: CONVERSATION },
    taint: "UNTRUSTED",
    nonce: `http-${CONVERSATION}`,
  }) as never;

  const project = async () =>
    ({
      ctx: (
        await resolveAndAssemble({
          kind: "order.cancel",
          payload,
          customerId: CUSTOMER,
          channel: opts.channel ?? "web",
        } as never)
      ).ctx,
    }) as never;

  const renders: string[] = [];
  let decision = await adjudicateAndAudit(envelope, await project(), CUSTOMER_ROUTER as never, {
    sink,
    metadataProvider: buildLanguageEngineAuditMetadata,
  } as never).then((r) => r.decision);
  renders.push(promptOf(decision));

  // The CONFIRM leg — the route re-adjudicates the identical envelope with a
  // receipt, which is what the customer's "sim" produces there.
  if (
    opts.answer !== undefined &&
    opts.answer !== "não" &&
    String((decision as { kind?: unknown }).kind) === "REQUEST_CONFIRMATION"
  ) {
    decision = await adjudicateAndAudit(envelope, await project(), CUSTOMER_ROUTER as never, {
      sink,
      metadataProvider: buildLanguageEngineAuditMetadata,
      confirmationReceipt: {
        intentHash: (envelope as { intentHash: string }).intentHash,
        at: "2026-07-27T12:59:00.000Z",
      },
    } as never).then((r) => r.decision);
    renders.push(promptOf(decision));
  }

  const kind = String((decision as { kind?: unknown }).kind);
  if (kind === "ESCALATE") await handoff.queue(envelope as never, "paid cancel above band");
  if (kind === "EXECUTE") {
    const order = (await domain.createOrderQueryService().getById(ORDER_ID, {
      customerId: CUSTOMER,
    })) as unknown as { fulfillmentStatus: string; displayId: number } | null;
    if (order !== null) {
      await executeOrderCancel({
        orderId: ORDER_ID,
        customerId: CUSTOMER,
        reason: payload.reason,
        order,
        orderCmdSvc: domain.createOrderCommandService(),
        paymentCmdSvc: domain.createPaymentCommandService(),
        paymentQuerySvc: domain.createPaymentQueryService(),
        log: console as never,
      });
    }
  }
  return { ...observe(sink, parkStore, renders), turnIds: [] };
}

async function drive(
  opts: HarnessOpts & { readonly answer?: string },
): Promise<Observation & { readonly turnIds: readonly string[] }> {
  if (opts.path === "direct") return driveDirectKernel(opts);
  const { harness, sink, parkStore, runtime } = buildHarness(opts);
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
  return { ...observe(sink, parkStore, renders), turnIds };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  redisFake.strings.clear();
  redisFake.hashes.clear();
  orderRowsFake.rows = [];
  paymentRowsFake.rows = new Map();
  natsSpy.calls = [];
  storeDown.on = false;
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

// ── 0a. THE RETIREMENT — the chat route to `order.cancel` is GONE ────────────

/**
 * WHAT THE RETIREMENT ACTUALLY CUT, asserted rather than described.
 *
 * Before it, a cancel utterance minted an `order.cancel` envelope from the parse
 * and the customer met a ladder that never mentioned their money. The baseline
 * block that used to sit here pinned exactly that, verbatim, including the two
 * things it got WRONG — and those pins did their job: they are the evidence the
 * retirement rests on, and they are recorded in the PR and the tracker.
 *
 * They cannot be pinned as LIVE behaviour any more, because the behaviour is
 * gone. What replaces them is the assertion that it is gone, plus the pins on the
 * route that replaced it (every block below).
 */
describe("LE2-024 retirement — a cancel utterance can no longer reach `order.cancel`", () => {
  it("the model is not offered the capability, and IS offered the workflow", async () => {
    const { harness, model } = buildHarness({ path: "workflow" });
    await runCustomerTurn(harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "quero cancelar meu pedido por favor",
    });

    // The WIRE, not the catalog's opinion of it.
    const plannerCall = (
      model.complete as unknown as { mock: { calls: [{ tools?: { name: string }[] }][] } }
    ).mock.calls.find((c) => (c[0]?.tools?.length ?? 0) > 0)?.[0];
    const expressIntent = JSON.stringify(
      plannerCall?.tools?.find((t) => t.name === "express_intent") ?? {},
    );

    // RETIRED: neither the capability nor the workflow's anchor is nameable.
    expect(expressIntent).not.toContain("order.cancel");
    expect(expressIntent).not.toContain("order.cancel.request");
    // CONTROL — ordinary kinds are still advertised, so the two assertions above
    // are about these kinds and not about an empty roster.
    expect(expressIntent).toContain("order.checkout.create");
    expect(expressIntent).toContain("order.item.add");

    // …and the WORKFLOW carries the language surface instead.
    const startWorkflow = plannerCall?.tools?.find((t) => t.name === "start_workflow");
    const description = String((startWorkflow as { description?: unknown })?.description);
    expect(description).toContain(PAID_CANCEL_WORKFLOW_ID);
    expect(description).toContain("cancela o último pedido");
  });

  it("the capability is still fully ADJUDICABLE — only the parse was retired", async () => {
    // The distinction the whole cut rests on. `order.cancel` remains the
    // workflow's own activity, the HTTP routes' kind and the escalation-resume
    // kind; it is a live, governed intent that simply has no parse in front of it
    // any more. If this ever fails, the retirement removed too much.
    const direct = await drive({ path: "direct", answer: "sim" });
    expect(terminalVerdict(direct)).toBe("EXECUTE/paid_cancel_requires_confirmation");
    expect(direct.paymentStatus).toBe("refunded");
  });
});

/**
 * BKL-275 — THE NAME THE PARSE ACTUALLY WRITES.
 *
 * `start_workflow.workflow` is advertised with a closed `enum`, but this engine
 * does not bind enums at decode (LE2-004), so what arrives is whatever the model
 * wrote. Measured on epoch 54cf4353d5a32564 across 50 drives: of the 12
 * `start_workflow` calls, 8 carried the full declared id, 2 carried the BARE
 * SUFFIX `orders.paid-cancel`, and 2 omitted the property entirely. The
 * bare-suffix form was rejected by the closed-surface check, so a customer
 * asking to cancel a paid order reached NO route — the money-adjacent hole this
 * row was re-pointed at.
 *
 * These cases drive the REAL turn seam and assert the CONFIRM SENTENCE, not an
 * envelope: a selection that mints an anchor but never reaches the customer's
 * money question would satisfy an envelope assertion and still be the defect.
 */
describe("BKL-275 — a workflow named by its unambiguous suffix still reaches the confirm", () => {
  it("the BARE SUFFIX reaches the SAME confirm sentence as the declared id", async () => {
    const declared = await drive({ path: "workflow" });
    const suffix = await drive({ path: "workflow", workflowName: "orders.paid-cancel" });

    // The money question the customer actually reads — byte-identical.
    expect(declared.renders[0]).toBe(paidCancelConfirmText(SUB_BAND));
    expect(suffix.renders[0]).toBe(paidCancelConfirmText(SUB_BAND));
  });

  it("and the money still moves on the customer's `sim`", async () => {
    // Reaching the question is not the claim; reaching the REFUND is.
    const suffix = await drive({
      path: "workflow",
      workflowName: "orders.paid-cancel",
      answer: "sim",
    });
    expect(terminalVerdict(suffix)).toBe("EXECUTE/paid_cancel_requires_confirmation");
    expect(suffix.orderStatus).toBe("canceled");
    expect(suffix.paymentStatus).toBe("refunded");
  });

  it("an UNKNOWN workflow name is still REFUSED — the closed surface is not weakened", async () => {
    // The direction that matters: leniency about SPELLING must not become
    // leniency about WHAT MAY RUN. This name resolves to nothing, so it must
    // reach no confirm and touch no money.
    const unknown = await drive({ path: "workflow", workflowName: "workflow.orders.free-money" });
    expect(unknown.renders[0]).not.toBe(paidCancelConfirmText(SUB_BAND));
    expect(unknown.orderStatus).not.toBe("canceled");
    expect(unknown.paymentStatus).not.toBe("refunded");
  });

  it("a name that is only a PARTIAL WORD of a declared id is refused", async () => {
    // `cancel` is a substring of `workflow.orders.paid-cancel` but not a
    // dot-bounded suffix of it. If the rule ever loosens to a bare `endsWith`,
    // this reddens.
    const partial = await drive({ path: "workflow", workflowName: "cancel" });
    expect(partial.renders[0]).not.toBe(paidCancelConfirmText(SUB_BAND));
    expect(partial.orderStatus).not.toBe("canceled");
  });
});

describe("BKL-275 — resolveWorkflowName, the pure rule", () => {
  const DECLARED = WORKFLOW_DEFINITIONS.map((w) => w.id);

  it("resolves the measured bare-suffix emission to the declared id", () => {
    expect(resolveWorkflowName("orders.paid-cancel", DECLARED)).toEqual({
      id: PAID_CANCEL_WORKFLOW_ID,
      normalizedFrom: "orders.paid-cancel",
    });
  });

  it("EXACT wins — a declared id resolves to itself and is not marked normalized", () => {
    expect(resolveWorkflowName(PAID_CANCEL_WORKFLOW_ID, DECLARED)).toEqual({
      id: PAID_CANCEL_WORKFLOW_ID,
    });
  });

  it("AMBIGUITY refuses — two declared ids sharing a suffix resolve to neither", () => {
    // An ambiguous cancel is the coin flip LE2-024 retired the direct route to
    // remove; it must never be resolved by picking one.
    const ambiguous = ["workflow.orders.paid-cancel", "workflow.reservations.paid-cancel"];
    expect(resolveWorkflowName("paid-cancel", ambiguous)).toEqual({ id: "paid-cancel" });
  });

  it("the match is DOT-BOUNDED, so a partial word never selects a route", () => {
    expect(resolveWorkflowName("cancel", DECLARED)).toEqual({ id: "cancel" });
  });

  it("a non-string or empty name resolves to nothing", () => {
    // The other measured malformed shape: the model omitted `workflow` entirely.
    expect(resolveWorkflowName(undefined, DECLARED)).toEqual({ id: "" });
    expect(resolveWorkflowName("", DECLARED)).toEqual({ id: "" });
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

// ── 6. THE DIVERGENCES THE RETIREMENT CLOSED ─────────────────────────────────

/**
 * The first LE2-024 PR measured four divergences between the workflow and the
 * ad-hoc chat ladder. THREE OF THEM WERE DEFECTS IN THAT LADDER, and this PR is
 * what closes them — not by fixing that route, but by removing it.
 *
 * These cases assert the closure, and they are deliberately phrased as "every
 * remaining route does X" rather than "the workflow does X": after a retirement
 * the claim that matters is about the SET of routes that are left.
 */
describe("LE2-024 — every remaining cancel route states the money and returns it", () => {
  it("BOTH live routes REFUND a settled paid cancel", async () => {
    // Divergence 2, CLOSED. The chat ladder dispatched `cancelOrder`, whose
    // `cancelActivePaymentForOrder` returns early for a settled payment — it
    // cancelled the order and left the money. That route is gone, and the two
    // that remain are both refund-first: the workflow through
    // `dispatchOrderCancel`, the HTTP plane directly, each reaching
    // `executeOrderCancel`, which adjudicates a `payment.refund.issue` BEFORE any
    // order transition and throws if it does not settle.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    expect(terminalVerdict(direct)).toBe(terminalVerdict(workflow));
    for (const o of [direct, workflow]) {
      expect(o.paymentStatus).toBe("refunded");
      expect(o.refundedCentavos).toBe(SUB_BAND);
    }
  });

  it("BOTH live routes STATE the refund consequence before acting", async () => {
    // Divergence 1, CLOSED. On the retired route the composed router's
    // auto-resolve confirm parked first and one receipt then satisfied
    // `gatePaidCancel` too, so its sentence was authored, audited and NEVER
    // SHOWN. Neither remaining route has that shape: the workflow quotes the
    // sentence through `{confirmation}`, and the HTTP plane names the order
    // explicitly so nothing stamps `autoResolvedMoneyRef` in front of it.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });

    for (const o of [direct, workflow]) {
      expect(o.renders.some((r) => r.startsWith("Esse pedido já foi pago"))).toBe(true);
      expect(o.renders.some((r) => r.includes("reembolso"))).toBe(true);
      expect(o.renders.some((r) => r.includes(AUTO_RESOLVE_PROMPT))).toBe(false);
    }
    // BYTE-IDENTICAL between them, and equal to the pack's own function — the
    // original parity claim, now stated over the routes that survive.
    expect(direct.renders.find((r) => r.startsWith("Esse pedido já foi pago"))).toBe(
      paidCancelConfirmText(SUB_BAND),
    );
    expect(workflow.renders[0]).toBe(paidCancelConfirmText(SUB_BAND));
  });

  it("BOTH live routes write the DOMAIN order projection", async () => {
    // Divergence 3, closed for the same reason as divergence 2: the projection
    // was only ever skipped by `cancelOrder`, which no longer has a caller.
    const direct = await drive({ path: "direct", answer: "sim" });
    const workflow = await drive({ path: "workflow", answer: "sim" });
    expect(direct.orderStatus).toBe("canceled");
    expect(workflow.orderStatus).toBe("canceled");
  });

  it("the workflow's success sentence is an AUTHORED template, not model prose", async () => {
    // Divergence 4 is the one the retirement does NOT fix, and it is now moot on
    // the customer plane: the route whose reply the model authored is gone, and
    // the only customer-facing cancel reply left is this template. (The HTTP
    // plane returns JSON — it has no prose to author.)
    const workflow = await drive({ path: "workflow", answer: "sim" });
    expect(workflow.renders[workflow.turns - 1]).toBe(
      "Pronto, cancelei seu pedido. O reembolso já foi solicitado e o valor volta pra você pelo mesmo meio de pagamento.",
    );
  });
});


// ── 8. THE BKL-103 CONTRACT — a workflow-created park must be APPROVABLE ──────

/**
 * Drive a path to its ESCALATE and hand back everything the approve half needs.
 *
 * The park is produced by the REAL `buildEscalationParkInput` over the REAL
 * store on both paths, so what the engine consumes below is the same artifact
 * production's Escalações panel would show.
 */
async function escalateAndPark(path: Path) {
  const built = buildHarness({ path, total: BIG_TOTAL });
  if (path === "direct") {
    // The HTTP plane, where the direct ladder still lives — the same envelope
    // that plane builds, adjudicated against fresh state, its ESCALATE handed to
    // the parking handoff exactly as `publishPaidCancelEscalation` does.
    const payload = {
      orderId: ORDER_ID,
      actorId: CUSTOMER,
      reason: "Cancelado a pedido do cliente",
    };
    const envelope = buildEnvelope({
      kind: "order.cancel",
      payload,
      actor: { principal: "llm", role: "customer", sessionId: CONVERSATION },
      taint: "UNTRUSTED",
      nonce: `http-${CONVERSATION}`,
    }) as never;
    const state = {
      ctx: (
        await resolveAndAssemble({
          kind: "order.cancel",
          payload,
          customerId: CUSTOMER,
          channel: "web",
        } as never)
      ).ctx,
    } as never;
    const decision = (
      await adjudicateAndAudit(envelope, state, CUSTOMER_ROUTER as never, {
        sink: built.sink,
        metadataProvider: buildLanguageEngineAuditMetadata,
      } as never)
    ).decision;
    if (String((decision as { kind?: unknown }).kind) === "ESCALATE") {
      await built.handoff.queue(envelope as never, "paid cancel above band");
    }
  } else {
    await runCustomerTurn(built.harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "quero cancelar meu pedido por favor",
    });
    await runCustomerTurn(built.harness, {
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      text: "sim",
    });
  }
  const parked = built.parkStore.all();
  return { ...built, parked, token: built.parkStore.lastToken() };
}

describe("LE2-024 parity — a WORKFLOW-created escalation park is approvable, identically", () => {
  it.each(["direct", "workflow"] as const)(
    "%s: the park carries the three fields the approve route matches on",
    async (path) => {
      // Same sessionId (the Escalações row's key AND the FIX-6 resolve binding),
      // same proposer stamp (`ESCALATION_PROPOSER_STAMPS` reads `payload.actorId`),
      // same pt-BR summary. A park missing any of these is staff-visible and
      // unapprovable — the exact shape of the hole BKL-103 closed.
      const { parked } = await escalateAndPark(path);

      expect(parked).toHaveLength(1);
      expect(String(parked[0]!.intentKind)).toBe("order.cancel");
      expect(parked[0]!.sessionId).toBe(CONVERSATION);
      expect(parked[0]!.proposerId).toBe(CUSTOMER);
      expect(parked[0]!.summaryPtBr).toBe(`cancelamento do pedido ${ORDER_ID}`);
      // The summary is the KIND-AWARE one, not the bare kind string that leaked
      // to staff before BKL-103's fix. Re-derived from the park's own stored
      // envelope fields so this compares the writer against the reader.
      expect(
        summarizeEscalation({
          kind: parked[0]!.envelopeKind,
          payload: parked[0]!.payload,
        } as never),
      ).toBe(parked[0]!.summaryPtBr);
      expect(parked[0]!.summaryPtBr).not.toBe("order.cancel");
    },
  );

  it.each(["direct", "workflow"] as const)(
    "%s: a DIFFERENT owner's approval runs EXACTLY ONE cancel and settles the refund",
    async (path) => {
      // THE CLAIM THE TICKET'S "BKL-103 CONTRACT INTACT" ACTUALLY MAKES. Driven
      // through the REAL `createEscalationApprovalEngine` and the REAL
      // `createApprovedOrderCancelExecutor`, over the park each path produced.
      const { approval, parkStore, cancels, token } = await escalateAndPark(path);

      const result = await approval.engine.resolve({
        token: token!,
        accept: true,
        approver: { id: "owner_approver", role: "OWNER" },
        expectedSessionId: CONVERSATION,
      } as never);

      expect(result.status).toBe("approved");
      expect(result.decision?.kind).toBe("EXECUTE");

      // EXACTLY ONE cancel — not zero (the approval did nothing) and not two
      // (the same-kind double-execute class).
      expect(cancels).toHaveLength(1);
      expect(cancels[0]?.orderId).toBe(ORDER_ID);
      expect(cancels[0]?.customerId).toBe(CUSTOMER);

      // The approver-authored inner refund settled, and for the whole amount.
      expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["status"]).toBe("refunded");
      expect(
        paymentRowsFake.rows.get(PAYMENT_ID)?.["refundedAmountCentavos"],
      ).toBe(BIG_TOTAL);

      // The order really is cancelled, and the token is burnt.
      expect(
        orderRowsFake.rows.find((r) => r["id"] === ORDER_ID)?.["fulfillmentStatus"],
      ).toBe("canceled");
      expect(parkStore.size()).toBe(0);

      // Separation of duty is a REAL inequality: the customer proposed, the
      // owner approved, and the refund is stamped to the APPROVER.
      expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["refundApprover"]).toBe(
        "owner_approver",
      );
    },
  );

  it.each(["direct", "workflow"] as const)(
    "%s: SELF-APPROVE is refused WITHOUT burning the token",
    async (path) => {
      const { approval, parkStore, cancels, token } = await escalateAndPark(path);

      const selfApprove = await approval.engine.resolve({
        token: token!,
        accept: true,
        // The proposer IS the customer, so approving as them is self-approval.
        approver: { id: CUSTOMER, role: "OWNER" },
        expectedSessionId: CONVERSATION,
      } as never);

      expect(selfApprove.status).toBe("self_approve");
      expect(cancels).toHaveLength(0);
      // NOT consumed — a refused self-approval must leave the escalation open
      // for somebody who may actually decide it.
      expect(parkStore.size()).toBe(1);
      expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["status"]).toBe("paid");
    },
  );

  it.each(["direct", "workflow"] as const)(
    "%s: a DENIED approval runs nothing and CONSUMES the park",
    async (path) => {
      const { approval, parkStore, cancels, token } = await escalateAndPark(path);

      const denied = await approval.engine.resolve({
        token: token!,
        accept: false,
        approver: { id: "owner_approver", role: "OWNER" },
        expectedSessionId: CONVERSATION,
      } as never);

      expect(denied.status).toBe("rejected");
      expect(cancels).toHaveLength(0);
      expect(parkStore.size()).toBe(0);
      expect(
        orderRowsFake.rows.find((r) => r["id"] === ORDER_ID)?.["fulfillmentStatus"],
      ).toBe("confirmed");
      expect(paymentRowsFake.rows.get(PAYMENT_ID)?.["status"]).toBe("paid");
    },
  );

  it.each(["direct", "workflow"] as const)(
    "%s: a REPLAYED approval is `missing` and cancels nothing a second time",
    async (path) => {
      const { approval, cancels, token } = await escalateAndPark(path);

      const first = await approval.engine.resolve({
        token: token!,
        accept: true,
        approver: { id: "owner_approver", role: "OWNER" },
        expectedSessionId: CONVERSATION,
      } as never);
      expect(first.status).toBe("approved");

      const replay = await approval.engine.resolve({
        token: token!,
        accept: true,
        approver: { id: "owner_approver", role: "OWNER" },
        expectedSessionId: CONVERSATION,
      } as never);

      // Single-use by construction — the store consumed it on the first pass.
      expect(replay.status).toBe("missing");
      expect(cancels).toHaveLength(1);
    },
  );

  it.each(["direct", "workflow"] as const)(
    "%s: a WRONG sessionId is `missing` and does NOT burn the token (FIX-6)",
    async (path) => {
      const { approval, parkStore, cancels, token } = await escalateAndPark(path);

      const wrongSession = await approval.engine.resolve({
        token: token!,
        accept: true,
        approver: { id: "owner_approver", role: "OWNER" },
        expectedSessionId: "conv_someone_else",
      } as never);

      expect(wrongSession.status).toBe("missing");
      expect(cancels).toHaveLength(0);
      // The token survives — a mis-addressed approval must not destroy a real
      // customer's pending escalation.
      expect(parkStore.size()).toBe(1);
    },
  );
});


// ── 9. THE RETIREMENT'S "AGAINST" CASE, MITIGATED ────────────────────────────

/**
 * THE ARGUMENT AGAINST RETIRING, ANSWERED WITH TESTS.
 *
 * The case for waiting was: retirement removes the fallback for cancel
 * utterances the workflow's pre-checks refuse. Before it, such a customer at
 * least met the direct capability and got a kernel refusal; after it, if the
 * workflow ever answers with silence or a dead end, they get nothing at all.
 *
 * Every pre-check refusal path is driven here and asserted to render its own
 * AUTHORED pt-BR sentence — never an empty reply, never a generic "não permitida",
 * never the model's fallback. The last case is the one the governor asked for
 * specifically and the one that actually worried me: a FAILED PROJECTION READ,
 * where the store is unreachable rather than merely empty.
 */
describe("LE2-024 retirement — no cancel ask reaches a dead end", () => {
  const honest = (render: string | undefined): void => {
    expect(render).toBeDefined();
    expect(render!.trim().length).toBeGreaterThan(0);
    // Not the scripted model's fallback, and not the kernel's generic deny —
    // both of which would mean the authored sentence never reached the customer.
    expect(render).not.toBe("Ok.");
    expect(render).not.toContain("não permitida");
    expect(render).not.toContain("decision=");
  };

  it("NO PREVIOUS ORDER — the authored no-order sentence, and nothing runs", async () => {
    const o = await drive({ path: "workflow", orders: [], payments: [] });
    honest(o.renders[0]);
    expect(o.renders[0]).toContain("Ainda não encontrei nenhum pedido seu pra cancelar");
    expect(o.cancelDecisions).toEqual([]);
  });

  it("PAST THE PONR — the authored past-ponr sentence, and nothing runs", async () => {
    const o = await drive({
      path: "workflow",
      orders: [orderRow({ fulfillmentStatus: "delivered" })],
    });
    honest(o.renders[0]);
    expect(o.renders[0]).toContain("ponto de cancelamento");
    expect(o.cancelDecisions).not.toContain("EXECUTE");
  });

  it("AMOUNT UNKNOWN — the authored amount-unknown sentence, and nothing runs", async () => {
    // The pre-check that keeps `confirm.statesFacts` honest: without a grounded
    // total the confirm would ask about a refund it could not size.
    const o = await drive({
      path: "workflow",
      orders: [orderRow({ totalInCentavos: null })],
    });
    honest(o.renders[0]);
    expect(o.renders[0]).toContain("Não consegui confirmar o valor desse pedido");
    expect(o.cancelDecisions).not.toContain("EXECUTE");
  });

  it("THE STORE IS DOWN — a FAILED projection read degrades to an honest reply", async () => {
    // THE GOVERNOR'S CASE, and materially different from the three above: those
    // are ABSENCES the projection reports successfully. This one is the read
    // THROWING — the order service unreachable — which is the shape that could
    // plausibly produce an unhandled rejection and a silent turn.
    //
    // The fact projection is fail-closed (an absent fact makes `isTrue` false),
    // so a throwing read must surface as the FIRST pre-check's authored sentence
    // rather than as a crash or an empty reply. That is what makes retirement
    // safe for a customer whose store read fails: they are told something true
    // and actionable, not left with nothing.
    storeDown.on = true;
    try {
      const o = await drive({ path: "workflow" });
      honest(o.renders[0]);
      expect(o.renders[0]).toContain("Ainda não encontrei nenhum pedido seu pra cancelar");
      // AND NOTHING RAN — a failed read must never reach the money path.
      expect(o.cancelDecisions).toEqual([]);
      expect(o.paymentStatus).toBe("paid");
      expect(o.refundedCentavos).toBe(0);
    } finally {
      storeDown.on = false;
    }
  });
});
