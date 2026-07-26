// tool-dispatch-self-readjudication — the BKL-242/243 CLASS gate.
//
// # The class
//
// Every handler in the `IBATEXAS_TOOLS` roster
// (apps/api/src/tools/register-ibatexas-tool-packs.ts) is dispatched by the
// claustrum Conductor AFTER the kernel has already adjudicated that intent and
// claimed its execution-ledger key. A handler that then mints a FRESH envelope
// of the SAME kind and adjudicates it again produces a second decision for one
// customer action:
//
//   - When the inner run is wired with an audit sink, it is a visible DUPLICATE:
//     two EXECUTE rows for one confirm (BKL-232 `reservation.modify`, live
//     intent_audit 6942/6944; BKL-242 `reservation.cancel`, live 6712/6714).
//   - When the inner run is wired WITHOUT one — `createCustomerService()` /
//     `createOrderCommandService()` take no `auditSink` in the tools package —
//     it is worse: the second decision is INVISIBLE. The authorizing decision
//     for the write is ungoverned, and an inner REFUSE silently contradicts the
//     audited EXECUTE (BKL-242 `order.note.add`, live 5278 with no second row;
//     `customer.preferences.update`, live 6172).
//
// The execution ledger structurally cannot absorb either shape: it dedups on
// `intentHash` (`ledger:intent:<hash>`, SET NX), and a re-minted envelope
// carries a fresh `nonce: randomUUID()` and a payload without `customerId`, so
// its hash can never collide with the adjudicated one.
//
// # What this gate does
//
// It drives EVERY registered tool's real `execute` with `buildEnvelope`
// intercepted, and fails if any handler mints an envelope of its own registered
// `intentKind`. Downstream mints are expected and allowed — the cart tools
// legitimately mint `medusa.store.cart.*` / `payment.*` envelopes for genuinely
// distinct mutations, and those show up in `mintedByTool` below. Only a
// SAME-KIND mint is the defect.
//
// The per-ticket end-to-end proofs live in
// `reservation-modify-resume-dedup.e2e.test.ts` (BKL-232) and
// `reservation-cancel-resume-dedup.e2e.test.ts` (BKL-242); they drive the whole
// turn seam through the real audited kernel and COUNT audit rows. This file is
// the complement: it is broad rather than deep, so the class cannot come back
// through a tool nobody wrote an e2e for.
//
// # Why it is not vacuous
//
// A probe that drives a handler which throws at its first input check would pass
// this assertion while proving nothing — the "sampling gate with a structural
// blind spot" failure. Two devices prevent that:
//
//   1. DEPTH IS ASSERTED. Every tool must produce at least one observable effect
//      (mint an envelope, call a domain service, touch Redis, or publish NATS),
//      proving the probe reached at least as deep as the point a mint would sit.
//      Tools that cannot clear that bar must be named in `SHALLOW_PROBE` with a
//      reason, and the test asserts the observed shallow set EQUALS that map —
//      so a blind spot can neither silently appear nor silently persist after
//      being fixed.
//   2. THE DETECTOR IS SELF-TESTED. `mintsOwnKind` is run against a synthetic
//      handler that deliberately re-mints its own kind, and must report it. That
//      pins the interception itself, independently of any real tool — including
//      the fact that it reaches INSIDE the `@ibatexas/tools` dist (visible in the
//      real roster too: `order.cart.ensure` records `medusa.store.cart.create`).
//
// # Mock posture
//
// Only LEAVES are faked, at the client boundary: `redis`, `stripe`, global
// `fetch` (Medusa), `typesense`, plus the `@ibatexas/domain` services. Those are
// the seams that reach into the tools dist (see customer-e2e-harness.ts's
// header). Nothing between the registry and the handler is stubbed — the
// executor under test is the real one the Conductor dispatches.
//
// The Medusa `fetch` double is deliberately PERMISSIVE (unrouted paths return an
// empty body rather than throwing). This gate asserts nothing about Medusa
// responses; its only job is to let each executor run far enough to reach the
// point where a self-mint would happen. The strict, throw-on-unrouted double
// belongs in the behavioral e2e tests, not here.

import { describe, expect, it, vi } from "vitest";
import { listIbatexasToolPacks } from "../tools/register-ibatexas-tool-packs.js";
import { makeCartFixture } from "./customer-e2e-harness.js";

// ── The detector ─────────────────────────────────────────────────────────────

/** Every `kind` passed to `buildEnvelope`, in call order, for the current probe. */
const mintedKinds = vi.hoisted(() => [] as string[]);
/** Every leaf effect a handler produced, for the depth assertion. */
const effects = vi.hoisted(() => [] as string[]);

vi.mock("@adjudicate/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@adjudicate/core")>();
  return {
    ...actual,
    // Record then DELEGATE — the real envelope (and its real `intentHash`) is
    // what the handler goes on to use, so nothing downstream behaves differently
    // because it is being watched.
    buildEnvelope: (args: { kind: string }) => {
      mintedKinds.push(args.kind);
      return (actual.buildEnvelope as (a: unknown) => unknown)(args);
    },
  };
});

// ── Leaf fakes ───────────────────────────────────────────────────────────────

const RESERVATION_DTO = {
  id: "res_1",
  customerId: "cus_1",
  status: "confirmed",
  partySize: 2,
  specialRequests: [],
  tableLocation: "indoor",
  timeSlot: { id: "ts_1", date: "2026-08-01", startTime: "20:00" },
  tables: [],
};

const EXPIRED_PIX = {
  id: "pay_1",
  orderId: "order_1",
  customerId: "cus_1",
  method: "pix" as const,
  status: "payment_expired" as const,
  amountInCentavos: 8900,
  stripePaymentIntentId: "pi_1",
  createdAt: new Date("2026-07-25T12:00:00.000Z"),
};

vi.mock("@ibatexas/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/domain")>();
  const note = (name: string) => {
    effects.push(`domain:${name}`);
  };
  return {
    ...actual,
    createReservationService: () => ({
      getById: async () => (note("reservation.getById"), RESERVATION_DTO),
      cancel: async () => (note("reservation.cancel"), { timeSlotId: "ts_1", partySize: 2 }),
      create: async () => (
        note("reservation.create"),
        { reservation: RESERVATION_DTO, tableLocation: "indoor" }
      ),
      modify: async () => (note("reservation.modify"), RESERVATION_DTO),
      joinWaitlist: async () => (
        note("reservation.joinWaitlist"),
        { waitlistId: "wl_1", position: 2 }
      ),
      promoteWaitlist: async () => (note("reservation.promoteWaitlist"), { promoted: null }),
    }),
    createCustomerService: () => ({
      updatePreferences: async () => (
        note("customer.updatePreferences"),
        { allergenExclusions: [], dietaryRestrictions: [], favoriteCategories: [] }
      ),
      submitReview: async () => (
        note("customer.submitReview"),
        { avgRating: 4.5, reviewCount: 3 }
      ),
    }),
    createOrderQueryService: () => ({
      getById: async () => (note("order.getById"), {
        id: "order_1",
        customerId: "cus_1",
        fulfillmentStatus: "preparing",
        paymentStatus: "paid",
        paymentMethod: "pix",
        totalInCentavos: 8900,
      }),
    }),
    createOrderCommandService: () => ({
      writeAdjudicatedNote: async () => (
        note("order.writeAdjudicatedNote"),
        { noteId: "note_1" }
      ),
    }),
    // An EXPIRED PIX payment, so `regenerate_pix` runs its real regeneration
    // body instead of short-circuiting on "no active payment" (which would make
    // the same-kind assertion vacuous for it).
    createPaymentQueryService: () => ({
      getActiveByOrderId: async () => (note("payment.getActiveByOrderId"), EXPIRED_PIX),
      getById: async () => (note("payment.getById"), EXPIRED_PIX),
      listByOrderId: async () => (note("payment.listByOrderId"), { payments: [EXPIRED_PIX] }),
    }),
    createPaymentCommandService: () => ({
      transitionStatusFromEnvelope: async () => (
        note("payment.transitionStatusFromEnvelope"),
        { decision: { kind: "EXECUTE" }, result: { id: "pay_1" } }
      ),
      createFromEnvelope: async () => (
        note("payment.createFromEnvelope"),
        { decision: { kind: "EXECUTE" }, result: { id: "pay_2" } }
      ),
    }),
    prisma: {
      reservation: {
        findUnique: async () => (note("prisma.reservation.findUnique"), {
          id: "res_1",
          customerId: "cus_1",
          status: "confirmed",
          partySize: 2,
          timeSlotId: "ts_1",
        }),
      },
      timeSlot: { findUnique: async () => (note("prisma.timeSlot.findUnique"), null) },
    },
  };
});

vi.mock("@ibatexas/audit-sink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/audit-sink")>();
  return { ...actual, getAuditSink: () => ({ emit: async () => {} }) };
});

vi.mock("@ibatexas/nats-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/nats-client")>();
  return {
    ...actual,
    publishNatsEvent: async (subject: string) => {
      effects.push(`nats:${subject}`);
      return undefined;
    },
  };
});

vi.mock("typesense", () => ({
  default: class {
    collections() {
      return { documents: () => ({ update: async () => ({}) }) };
    }
  },
}));

const redisFake = vi.hoisted(() => ({
  strings: new Map<string, string>(),
  hashes: new Map<string, Record<string, string>>(),
}));

vi.mock("redis", () => {
  const touch = (op: string) => {
    effects.push(`redis:${op}`);
  };
  const client: Record<string, unknown> = {
    isOpen: true,
    on: () => client,
    connect: async () => client,
    quit: async () => undefined,
    get: async (key: string) => (touch("get"), redisFake.strings.get(key) ?? null),
    set: async (key: string, value: string) => {
      touch("set");
      redisFake.strings.set(key, String(value));
      return "OK";
    },
    del: async (key: string) => (touch("del"), redisFake.strings.delete(key) ? 1 : 0),
    hGetAll: async (key: string) => (touch("hGetAll"), redisFake.hashes.get(key) ?? {}),
    hSet: async (key: string, field: string, value: string) => {
      touch("hSet");
      const h = redisFake.hashes.get(key) ?? {};
      h[field] = String(value);
      redisFake.hashes.set(key, h);
      return 1;
    },
    hDel: async () => (touch("hDel"), 1),
    // The Lua seams: `atomicIncr` (rate limit) and `withLock`'s ownership-checked
    // release both go through `eval`. Returning 1 = "first hit / lock is yours",
    // which is what lets `regenerate_pix` run its real body rather than dying at
    // the rate limiter.
    eval: async () => (touch("eval"), 1),
    evalSha: async () => (touch("evalSha"), 1),
    scriptLoad: async () => (touch("scriptLoad"), "sha_1"),
    expire: async () => (touch("expire"), 1),
    multi: () => {
      touch("multi");
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
      confirm: vi.fn(async () => ({ id: "pi_1", status: "requires_action" })),
      update: vi.fn(async () => ({ id: "pi_1" })),
      retrieve: vi.fn(async () => ({ id: "pi_1", status: "requires_action" })),
      create: vi.fn(async () => ({ id: "pi_1", status: "requires_action" })),
      cancel: vi.fn(async () => ({ id: "pi_1", status: "canceled" })),
    },
  })),
}));

// ── Probe fixtures ───────────────────────────────────────────────────────────

/**
 * One input per registered `intentKind`. These exist only to get each executor
 * PAST its input validation and down to its work — they are not behavioral
 * fixtures and nothing below asserts on the values they produce. The test fails
 * loudly if the roster ever carries a kind with no entry here, so a newly
 * registered tool cannot skip the gate.
 */
const PROBE_INPUTS: Readonly<Record<string, unknown>> = {
  "order.cart.ensure": {},
  "order.item.add": { cartId: "cart_1", variantId: "var_1", quantity: 1 },
  "order.item.update": { cartId: "cart_1", itemId: "li_1", quantity: 2 },
  "order.item.remove": { cartId: "cart_1", itemId: "li_1" },
  "order.coupon.apply": { cartId: "cart_1", code: "PROMO" },
  "order.checkout.create": {
    cartId: "cart_1",
    paymentMethod: "cash",
    fulfillmentType: "pickup",
  },
  "order.cancel": { orderId: "order_1" },
  "order.amend.add_item": { orderId: "order_1", variantId: "var_1", quantity: 1 },
  "order.amend.update_qty": { orderId: "order_1", itemId: "li_1", quantity: 2 },
  "order.amend.remove_item": { orderId: "order_1", itemId: "li_1" },
  "order.note.add": { orderId: "order_1", content: "sem cebola, por favor" },
  "order.review.submit": { productId: "prod_1", orderId: "order_1", rating: 5 },
  "reservation.create": { customerId: "cus_1", timeSlotId: "ts_1", partySize: 2 },
  "reservation.modify": { customerId: "cus_1", reservationId: "res_1", newPartySize: 4 },
  "reservation.cancel": { customerId: "cus_1", reservationId: "res_1" },
  "reservation.waitlist.join": { customerId: "cus_1", timeSlotId: "ts_1", partySize: 2 },
  "customer.preferences.update": { allergenExclusions: [] },
  "customer.pix.details.save": { name: "Ana Souza", email: "ana@ex.com", cpf: "11144477735" },
  "payment.pix.regenerate": { orderId: "order_1" },
  "whatsapp.handoff.request": { reason: "quero falar com um atendente" },
};

/**
 * Tools whose probe cannot reach a leaf effect, with the reason. MUST stay
 * empty-or-justified: the test asserts the OBSERVED shallow set equals this map
 * exactly, so an entry that becomes drivable has to be deleted here, and a tool
 * that regresses into shallowness has to be added (and justified) rather than
 * quietly passing a vacuous assertion.
 */
const SHALLOW_PROBE: Readonly<Record<string, string>> = {};

/** The Capsule shape `makeTool` adapts via `agentCtxFromCapsule`. */
const CAPSULE = {
  customerId: "cus_1",
  channel: "web",
  conversationId: "web:cus_1",
  turnId: "turn_1",
  actor: { principal: "user", role: "customer", sessionId: "web:cus_1" },
};

/** A syntactically-real JWT — `getAdminToken` base64url-decodes segment 2 for `exp`. */
const FAKE_JWT = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.sig`;
})();

function seedEnv(): void {
  process.env.APP_ENV = "test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.MEDUSA_URL = "http://medusa.test";
  process.env.MEDUSA_ADMIN_EMAIL = "admin@test.local";
  process.env.MEDUSA_ADMIN_PASSWORD = "probe-password";
  process.env.STRIPE_SECRET_KEY = "sk_test_probe";
  process.env.KERNEL_TENANT_ID = "ibatexas";
  process.env.TYPESENSE_HOST = "localhost";
  process.env.TYPESENSE_API_KEY = "probe-key";
}

function installMedusaFake(): void {
  const cart = makeCartFixture({ id: "cart_1" });
  const order = {
    id: "order_1",
    customer_id: "cus_1",
    email: "ana@ex.com",
    status: "pending",
    fulfillment_status: "not_fulfilled",
    payment_status: "awaiting",
    total: 100,
    currency_code: "brl",
    items: [
      { id: "li_1", variant_id: "var_1", title: "Costela", quantity: 1, unit_price: 100 },
    ],
    payment_collections: [],
    metadata: {},
  };
  const body = (path: string): unknown => {
    if (path.includes("/auth/")) return { token: FAKE_JWT };
    if (path.includes("/admin/api-keys")) {
      return { api_keys: [{ id: "apk_1", token: "pk_test_probe" }] };
    }
    if (path.includes("/admin/orders")) return { order, orders: [order] };
    if (path.includes("/store/carts")) return { cart: { ...cart, items: [...cart.items] } };
    if (path.includes("payment-providers")) {
      return { payment_providers: [{ id: "pp_stripe_stripe", is_enabled: true }] };
    }
    return {};
  };
  vi.stubGlobal("fetch", async (input: unknown) => {
    const path = String(input);
    return {
      ok: true,
      status: 200,
      json: async () => body(path),
      text: async () => JSON.stringify(body(path)),
    };
  });
}

interface ProbeResult {
  readonly intentKind: string;
  readonly selfMints: ReadonlyArray<string>;
  readonly minted: ReadonlyArray<string>;
  readonly effects: ReadonlyArray<string>;
  readonly threw: string | null;
}

/**
 * Drive one handler and report what it minted and how deep it got.
 *
 * A throw is RECORDED, not rethrown: several executors legitimately reject the
 * synthetic fixture, and the question this gate asks — "did it mint its own
 * kind?" — is answered either way. The depth assertion is what stops a throw
 * from turning into a free pass.
 */
async function probe(
  tool: { intentKind: unknown; execute: (i: unknown, c: unknown) => Promise<unknown> },
  input: unknown,
): Promise<ProbeResult> {
  const intentKind = String(tool.intentKind);
  mintedKinds.length = 0;
  effects.length = 0;
  let threw: string | null = null;
  try {
    await tool.execute(input, CAPSULE as never);
  } catch (err) {
    threw = (err as Error).message;
  }
  return {
    intentKind,
    selfMints: mintedKinds.filter((k) => k === intentKind),
    minted: [...new Set(mintedKinds)],
    effects: [...new Set(effects)],
    threw,
  };
}

/**
 * Tools that perform NO I/O by design, so "produced a leaf effect" is the wrong
 * depth signal for them. `set_pix_details` is a pure extraction VALIDATOR: it
 * parses and validates the customer's PIX identity and returns an `event` for
 * its caller to act on — it writes nothing itself. Running to a non-throwing
 * completion IS full depth for such a tool, since the whole body executed.
 */
const PURE_VALIDATORS: ReadonlySet<string> = new Set(["customer.pix.details.save"]);

/**
 * Did this probe reach far enough for a self-mint to have been observable?
 *
 * A throw means the executor stopped early, so nothing downstream of that point
 * was exercised — never depth. Otherwise an observable leaf effect (or, for a
 * pure validator, simply running to completion) proves the body ran past where
 * a mint would sit: in every instance of this class the mint was built at the
 * TOP of the handler, before any service call.
 */
const reachedDepth = (r: ProbeResult): boolean =>
  r.threw === null &&
  (r.minted.length > 0 || r.effects.length > 0 || PURE_VALIDATORS.has(r.intentKind));

async function probeAll(): Promise<ProbeResult[]> {
  // Each run starts from an empty cache. Otherwise the cart the FIRST run
  // created is still there for the second, and `order.cart.ensure` returns it
  // instead of minting `medusa.store.cart.create` — a probe that silently
  // shallows out on every run after the first.
  redisFake.strings.clear();
  redisFake.hashes.clear();
  const results: ProbeResult[] = [];
  for (const tool of listIbatexasToolPacks()) {
    const kind = String(tool.intentKind);
    const input = PROBE_INPUTS[kind];
    expect(
      input,
      `No PROBE_INPUTS entry for newly registered tool "${kind}" — add one so it cannot skip this gate.`,
    ).toBeDefined();
    results.push(
      await probe(
        tool as unknown as Parameters<typeof probe>[0],
        input,
      ),
    );
  }
  return results;
}

describe("BKL-242/243 — no dispatched tool re-adjudicates its own intent kind", () => {
  it("no IBATEXAS_TOOLS handler mints an envelope of its own registered intentKind", async () => {
    seedEnv();
    installMedusaFake();

    const results = await probeAll();

    const offenders = results
      .filter((r) => r.selfMints.length > 0)
      .map((r) => `${r.intentKind} (minted its own kind ${r.selfMints.length}x)`);

    expect(
      offenders,
      "A dispatched executor minted an envelope of the kind the Conductor already " +
        "adjudicated. That is a SECOND decision for one customer action — the " +
        "BKL-232/242/243 class. Fix it the way those did: give the tool a " +
        "`*PreAdjudicated` entry point that executes under the Conductor's " +
        "decision (or convert it in place when the registry is its only caller), " +
        "and keep the self-adjudicating original for the REST route.",
    ).toEqual([]);
  });

  // Anti-vacuity #1 — the probes are deep enough for the assertion above to mean
  // something. A tool that throws at its first input check would pass the
  // same-kind check while proving nothing.
  it("every probed tool reaches a leaf effect (no vacuous passes)", async () => {
    seedEnv();
    installMedusaFake();

    const results = await probeAll();
    const shallow = results
      .filter((r) => !reachedDepth(r))
      .map((r) => r.intentKind)
      .sort();

    expect(
      shallow,
      "These tools produced no envelope, no domain call, no Redis touch and no " +
        "NATS publish, so the same-kind assertion is vacuous for them. Either " +
        "deepen their PROBE_INPUTS fixture or record them in SHALLOW_PROBE with " +
        "a reason.",
    ).toEqual(Object.keys(SHALLOW_PROBE).sort());
  });

  // Anti-vacuity #2 — the detector itself works, independently of any real tool.
  // If `buildEnvelope` interception silently stopped reaching handler code, every
  // assertion above would pass for the wrong reason.
  it("the detector reports a handler that DOES re-mint its own kind", async () => {
    const { buildEnvelope } = await import("@adjudicate/core");

    const reMinting = {
      intentKind: "reservation.cancel",
      execute: async (input: unknown) => {
        buildEnvelope({
          kind: "reservation.cancel",
          payload: input as never,
          nonce: "n-synthetic",
          actor: { principal: "llm", sessionId: "customer:cus_1" },
          taint: "UNTRUSTED",
        } as never);
        return { success: true };
      },
    };

    const result = await probe(reMinting, { reservationId: "res_1" });

    expect(result.selfMints).toEqual(["reservation.cancel"]);
    expect(reachedDepth(result)).toBe(true);
  });

  // The complement of the main assertion: downstream mints are EXPECTED, and
  // pinning a few proves the interception genuinely reaches inside the
  // `@ibatexas/tools` dist rather than only seeing apps/api-side calls.
  it("still observes the legitimate DOWNSTREAM mints the cart tools make", async () => {
    seedEnv();
    installMedusaFake();

    const results = await probeAll();
    const byKind = new Map(results.map((r) => [r.intentKind, r]));

    expect(byKind.get("order.cart.ensure")?.minted).toContain("medusa.store.cart.create");
    expect(byKind.get("order.item.add")?.minted).toContain(
      "medusa.store.cart.line_item.add",
    );
    expect(byKind.get("order.cancel")?.minted).toContain("medusa.admin.order.cancel");
  });
});
