// tool-dispatch-self-readjudication — the BKL-242/243/260 CLASS gate.
//
// TWO planes, one class. The first half of this file gates the CUSTOMER registry
// (`IBATEXAS_TOOLS`, BKL-242/243); the second half gates the OPS registry
// (`listOpsToolDefinitions`, BKL-260). Same defect, same rule: an executor the
// Conductor dispatches on a kernel decision must not produce a SECOND decision
// for that one action.
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
import { listOpsToolDefinitions } from "../ops/ops-tool-registry.js";
import type { OpsToolRegistryDeps } from "../ops/ops-tool-registry.js";
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
    // M4 — the ONE file in the redisFake cluster that actually reaches a
    // production `multi()`. Measured, not assumed: across all 13 copies of this
    // double, `multi()` is invoked exactly 3 times and every one is
    // `updatePreferences` (packages/tools/src/intelligence/update-preferences.ts)
    // queuing hSet+expire on the customer profile hash — from this file's three
    // `probeAll()` runs.
    //
    // The queued commands APPLY here rather than being dropped. The old chain
    // returned itself for hSet/expire and `[]` from exec, so the profile write
    // vanished while the identical direct `hSet` landed — the census's
    // silent-drop shape. Nothing read it back, so it was a latent fiction
    // rather than a live defect, but it is a fiction this file no longer tells.
    //
    // This makes NO atomicity claim, and does not need to: every production
    // `multi()` in this repo is a batching PIPELINE — there is no `WATCH`
    // anywhere in the tree — and nothing in this file asserts a transaction's
    // all-or-nothing property. What the site must issue (this key, this field,
    // this TTL) is pinned by its own suite,
    // `packages/tools/src/intelligence/__tests__/update-preferences.test.ts`.
    // A case that genuinely needs atomicity belongs on the real-Redis harness;
    // the canonical in-memory adapter still refuses `multi` (W4 RULE 3).
    //
    // `multi` is load-bearing in this file for a second reason: `reachedDepth()`
    // requires the probe not to throw, so removing it would make
    // `customer.preferences.update` read as a shallow probe.
    multi: () => {
      touch("multi");
      const queued: Array<() => Promise<unknown>> = [];
      const chain: Record<string, unknown> = {
        hSet: (key: string, field: string, value: string) => {
          queued.push(() =>
            (client.hSet as (k: string, f: string, v: string) => Promise<number>)(
              key,
              field,
              value,
            ),
          );
          return chain;
        },
        expire: (key: string, seconds: number) => {
          queued.push(() =>
            (client.expire as (k: string, s: number) => Promise<number>)(key, seconds),
          );
          return chain;
        },
        // Real EXEC returns one reply per queued command; the old `[]` gave zero
        // replies for N commands, so any positional read got `undefined`.
        exec: async () => {
          const replies: unknown[] = [];
          for (const run of queued) replies.push(await run());
          return replies;
        },
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
  ctx: unknown = CAPSULE,
): Promise<ProbeResult> {
  const intentKind = String(tool.intentKind);
  mintedKinds.length = 0;
  effects.length = 0;
  let threw: string | null = null;
  try {
    await tool.execute(input, ctx as never);
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

  // Anti-vacuity #1b — the double does not silently swallow a TRANSACTIONAL
  // write (M4).
  //
  // `updatePreferences` is the only production path any of these probes takes
  // through `redis.multi()`, and it writes the customer profile hash through
  // the pipeline rather than directly. While the chain returned itself and
  // `exec` answered `[]`, that write went nowhere: the probe still "reached a
  // leaf effect" (the `touch("multi")` above fires either way), so the gate
  // above stayed green over a store that never changed. This pins the write
  // landing, which is what makes the queued commands worth queuing.
  //
  // The KEY's exact composition is deliberately not asserted here — that is
  // `packages/tools/src/intelligence/__tests__/update-preferences.test.ts`'s
  // job, which pins `rk()`, the field and PROFILE_TTL_SECONDS at the site.
  it("a pipelined profile write LANDS in the same keyspace as a direct write", async () => {
    seedEnv();
    installMedusaFake();

    await probeAll();

    const profileHashes = [...redisFake.hashes.entries()].filter(([k]) =>
      k.endsWith("customer:profile:cus_1"),
    );

    expect(
      profileHashes.map(([k]) => k),
      "`customer.preferences.update` ran, so its multi()-queued hSet on the " +
        "profile hash must be observable in the SAME backing store a direct " +
        "hSet writes to. An empty list means the transaction path dropped the " +
        "write — the census's silent-drop shape, asserted green.",
    ).toHaveLength(1);

    expect(profileHashes[0]?.[1]).toHaveProperty("preferences");
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
    // LE2-024 — `order.cancel` left this roster with the ad-hoc paid-cancel
    // retirement, so `probeAll()` no longer yields a row for it. The downstream
    // mints it used to witness are unchanged and now exercised through the
    // workflow's own dispatch (`executeOrderCancel`), not the tool registry.
    // The two cart pins above already prove the interception reaches inside the
    // `@ibatexas/tools` dist, which is what this case is for.
    expect(byKind.has("order.cancel")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BKL-260 — the SAME class on the OPS registry.
// ═════════════════════════════════════════════════════════════════════════════
//
// The ops registry (apps/api/src/ops/ops-tool-registry.ts) is a SEPARATE
// `@claustrum/core` ToolRegistry, dispatched by the ops Conductor on a kernel
// EXECUTE the composed ops router already produced at SUBMIT. The BKL-243 audit
// that closed the class on the customer registry never scoped it, and two of its
// nine executors had re-grown the defect:
//
//   - `ops.alert.resolve.staff` BUILT a SYSTEM `ops.alert.resolve` envelope and
//     ran it through `resolveAlertFromEnvelope` → `withAdjudicate`.
//   - `incident.ticket.close.staff` did the same for `incident.ticket.close`.
//
// # Why the customer arm's same-kind rule does not catch it
//
// The re-minted kind is not IDENTICAL to the dispatched one — it is the base kind
// under the `.staff` suffix. `selfMints` (kind === intentKind) is therefore blind
// to it. The rule this arm enforces is stronger and does not depend on the naming
// relationship: an ops executor may mint NO envelope at all unless that mint is
// DECLARED in `OPS_DECLARED_MINTS` with a reason, and the observed map must EQUAL
// the declared one. A new mint cannot silently appear, and a declared entry that
// gets fixed cannot silently persist.
//
// # Why deleting the inner adjudication strictly TIGHTENS
//
// Measured against dev @ fd55a6cc, the inner runs adjudicated a strict guard
// SUBSET of the outer decision:
//
//   - `opsAlertPolicyBundle` / `incidentPolicyBundle` both carry
//     `stateGuards: []` and `authGuards: []`. Their only guards are a SYSTEM
//     taint floor and a frozen-cause check scoped to the `.open` kind, then a
//     blanket `executeAll`.
//   - The taint floor is satisfied BY CONSTRUCTION: the executor itself built the
//     envelope with `taint: "SYSTEM"` one line earlier. It cannot fail.
//   - The state argument was `{}` — no guard reads it, but nothing structural
//     said so.
//
// So the inner decision was a CONSTANT EXECUTE, while the outer decision carried
// `adminSessionOnlyGuard` + `staffRoleGuard` {OWNER,MANAGER} + the actionability
// guard against REAL resolver-projected state. Removing the inner run removes a
// vacuous decision, not a check.
//
// # Mock posture
//
// The ops registry takes every side effect as an INJECTED dep, so this arm needs
// none of the leaf fakes above — it drives the REAL `listOpsToolDefinitions` with
// recording spies. The `@adjudicate/core` interception at the top of this file is
// what makes a mint visible: `buildSystemEnvelope` (apps/api) calls the same
// `buildEnvelope`.

/**
 * Envelope kinds each OPS executor is permitted to mint ITSELF, with the reason.
 *
 * EMPTY BY DESIGN. Every ops verb reaches its executor on a decision the composed
 * ops router already produced, so there is nothing left to adjudicate. The one
 * legitimate SECOND governance layer on this plane — the D10 Medusa admin egress
 * (`medusa.admin.product.update`) — is performed by the INJECTED
 * `medusaAdjudicated` wrapper over a different system, not by an inline mint, and
 * is asserted separately below so removing it cannot go unnoticed.
 *
 * An entry added here is a design decision that must be argued in review; an
 * entry that becomes obsolete must be deleted or this gate fails.
 */
const OPS_DECLARED_MINTS: Readonly<Record<string, readonly string[]>> = {};

/** One probe input per ops `intentKind` — enough to get past input handling. */
const OPS_PROBE_INPUTS: Readonly<Record<string, unknown>> = {
  "product.availability.set": { productId: "prod_1", available: false },
  "product.price.set": { productId: "prod_1", priceCentavos: 8900 },
  "menu.special.set": { productId: "prod_1", date: "2026-08-01" },
  "order.note.add": { orderId: "order_1", content: "sem cebola" },
  "order.status.transition": { orderId: "order_1", newStatus: "ready" },
  "payment.refund.issue": {
    paymentId: "pay_1",
    refundAmountCentavos: 5_000,
    reason: "produto errado",
  },
  "ops.alert.resolve.staff": { alertId: "alert_1" },
  "incident.ticket.close.staff": { incidentId: "inc_1" },
  "schedule.override.set": { date: "2026-08-01", isOpen: false },
};

/** The ops Capsule shape — `actor.staffId` is the AUTHORITATIVE staff identity. */
const OPS_CAPSULE = {
  channel: "ops-whatsapp",
  conversationId: "ops:staff_9",
  turnId: "turn_ops_1",
  actor: {
    principal: "staff",
    role: "MANAGER",
    sessionId: "admin:staff_9",
    staffId: "staff_9",
  },
};

/** Every `intentKind` the injected D10 egress wrapper was asked to adjudicate. */
const opsEgressKinds: string[] = [];

/**
 * Recording deps for the whole ops registry. Every method pushes into `effects`
 * so the depth assertion is real, exactly as the customer arm's leaf fakes do.
 */
function makeRecordingOpsDeps(): OpsToolRegistryDeps {
  const note = (name: string) => {
    effects.push(`ops:${name}`);
  };
  return {
    medusaAdjudicated: (async (args: { intentKind?: string }) => {
      note("medusaAdjudicated");
      opsEgressKinds.push(String(args.intentKind));
      return { product: { id: "prod_1" } };
    }) as never,
    auditSink: { emit: async () => {} } as never,
    readProductBrlVariantIds: async () => (
      note("readProductBrlVariantIds"), ["variant_1"]
    ),
    orderCmdSvc: {
      writeAdjudicatedNote: async () => (
        note("writeAdjudicatedNote"), { noteId: "note_1", orderId: "order_1" }
      ),
      writeAdjudicatedStatusTransition: async () => (
        note("writeAdjudicatedStatusTransition"),
        {
          version: 3,
          previousStatus: "preparing",
          newStatus: "ready",
          displayId: 4242,
          customerId: "cus_1",
        }
      ),
    },
    dailySpecialSvc: {
      list: async () => (note("dailySpecial.list"), []),
      create: async () => (note("dailySpecial.create"), { id: "special_1" }),
      update: async () => (note("dailySpecial.update"), { id: "special_1" }),
    },
    paymentCmdSvc: {
      writeAdjudicatedRefund: async () => (
        note("writeAdjudicatedRefund"),
        {
          version: 5,
          previousStatus: "paid",
          newStatus: "refunded",
          totalRefundedCentavos: 5_000,
          refundAmountCentavos: 5_000,
          orderId: "order_1",
          method: "pix",
        }
      ),
    },
    // BKL-260 — the POST-adjudication writes. These deliberately expose ONLY the
    // non-adjudicating methods: an executor that reaches back for a
    // `*FromEnvelope` entry point throws here, and a throw is never depth, so the
    // "no vacuous passes" arm turns red even before the mint arm does.
    opsAlertSvc: {
      writeAdjudicatedAlertResolve: async () => (
        note("writeAdjudicatedAlertResolve"), { status: "RESOLVED" }
      ),
    } as never,
    incidentSvc: {
      writeAdjudicatedIncidentClose: async () => (
        note("writeAdjudicatedIncidentClose"), { status: "RESOLVED" }
      ),
    } as never,
    scheduleSvc: {
      upsertOverride: async (date: string, data: { isOpen: boolean }) => (
        note("upsertOverride"), { date, isOpen: data.isOpen }
      ),
    } as never,
    invalidateScheduleCache: async () => (
      note("invalidateScheduleCache"), { ok: true }
    ),
    publishPaymentStatusChanged: async () => {
      note("publishPaymentStatusChanged");
    },
    appendRefundEventLog: async () => {
      note("appendRefundEventLog");
    },
    publishOrderStatusChanged: async () => {
      note("publishOrderStatusChanged");
    },
  } as OpsToolRegistryDeps;
}

async function opsProbeAll(): Promise<ProbeResult[]> {
  opsEgressKinds.length = 0;
  const deps = makeRecordingOpsDeps();
  const results: ProbeResult[] = [];
  for (const tool of listOpsToolDefinitions(deps)) {
    const kind = String(tool.intentKind);
    const input = OPS_PROBE_INPUTS[kind];
    expect(
      input,
      `No OPS_PROBE_INPUTS entry for newly registered ops tool "${kind}" — add one so it cannot skip this gate.`,
    ).toBeDefined();
    results.push(
      await probe(
        tool as unknown as Parameters<typeof probe>[0],
        input,
        OPS_CAPSULE,
      ),
    );
  }
  return results;
}

describe("BKL-260 — no dispatched OPS executor adjudicates a second time", () => {
  it("mints exactly the DECLARED set of envelopes and nothing more", async () => {
    const results = await opsProbeAll();

    const observed: Record<string, readonly string[]> = {};
    for (const r of results) {
      if (r.minted.length > 0) observed[r.intentKind] = [...r.minted].sort();
    }

    expect(
      observed,
      "An ops executor MINTED an envelope. Every ops verb arrives on a decision " +
        "the composed ops router already produced, so a mint here is a SECOND " +
        "decision for one staff action — the BKL-232/242/243/260 class. Note the " +
        "re-minted kind need not equal the dispatched one: `ops.alert.resolve" +
        ".staff` re-minted the BASE kind `ops.alert.resolve`, which the same-kind " +
        "rule above is blind to. Fix it the way BKL-260 did: call a " +
        "`writeAdjudicated*` domain write under the Conductor's decision, and " +
        "leave the self-adjudicating `*FromEnvelope` entry point for the admin " +
        "HTTP routes and watchdog jobs that have no decision behind them.",
    ).toEqual(OPS_DECLARED_MINTS);
  });

  it("no ops executor mints an envelope of its own registered intentKind", async () => {
    const results = await opsProbeAll();
    const offenders = results
      .filter((r) => r.selfMints.length > 0)
      .map((r) => `${r.intentKind} (minted its own kind ${r.selfMints.length}x)`);

    expect(offenders).toEqual([]);
  });

  // Anti-vacuity — the probes reach a leaf effect, so the mint assertion is not
  // passing because nine executors died at their first input check.
  it("every probed ops tool reaches a leaf effect (no vacuous passes)", async () => {
    const results = await opsProbeAll();
    const shallow = results
      .filter((r) => !reachedDepth(r))
      .map((r) => `${r.intentKind}${r.threw ? ` (threw: ${r.threw})` : ""}`)
      .sort();

    expect(shallow).toEqual([]);
  });

  // The roster this arm covers, pinned. A tool deleted from the ops registry
  // would otherwise shrink the gate's coverage silently.
  it("covers all nine governed ops executors", async () => {
    const results = await opsProbeAll();
    expect(results.map((r) => r.intentKind).sort()).toEqual([
      "incident.ticket.close.staff",
      "menu.special.set",
      "ops.alert.resolve.staff",
      "order.note.add",
      "order.status.transition",
      "payment.refund.issue",
      "product.availability.set",
      "product.price.set",
      "schedule.override.set",
    ]);
  });

  // The complement: the D10 Medusa admin egress is a DISTINCT governance layer
  // over a different system and must survive. Pinning it here means "no ops
  // executor mints" can never be satisfied by deleting the egress instead.
  it("still routes the D10 Medusa admin egress for the two catalog verbs", async () => {
    await opsProbeAll();
    expect(opsEgressKinds).toEqual([
      "medusa.admin.product.update",
      "medusa.admin.product.update",
    ]);
  });

  // The detector reaches ops-side code specifically — `buildSystemEnvelope` is an
  // apps/api module, a different import path from the `@ibatexas/tools` dist the
  // customer arm exercises. If interception stopped covering it, every ops
  // assertion above would pass for the wrong reason.
  it("the detector reports an ops-shaped handler that DOES adjudicate again", async () => {
    const { buildSystemEnvelope } = await import(
      "../subscribers/__shared__/system-actor-envelope.js"
    );

    const reAdjudicating = {
      intentKind: "ops.alert.resolve.staff",
      execute: async (input: { alertId: string }) => {
        buildSystemEnvelope({
          kind: "ops.alert.resolve",
          payload: { id: input.alertId, resolvedBy: "staff:1", resolutionType: "STAFF" },
          sourceSubject: "ops.alert.ops_staff_resolve",
          eventId: `${input.alertId}:resolve:synthetic`,
        });
        return { alertId: input.alertId };
      },
    };

    const result = await probe(
      reAdjudicating as unknown as Parameters<typeof probe>[0],
      { alertId: "alert_1" },
      OPS_CAPSULE,
    );

    // The same-kind rule misses it (base kind ≠ `.staff` kind) — which is exactly
    // why the declared-mint rule above is the one that carries this plane.
    expect(result.selfMints).toEqual([]);
    expect(result.minted).toEqual(["ops.alert.resolve"]);
    expect(reachedDepth(result)).toBe(true);
  });
});
