// Unit tests for the PIX expiry monitor's payment-confirmation check.
//
// BKL-241: the monitor and the `pix:paid:` marker must key on ONE id — the
// Stripe PaymentIntent id of the PIX attempt. The scheduler only ever holds a
// `pi_…` id (at QR-mint time no Medusa order exists yet), so a marker written
// under the order id is a key `isPixPaid` never reads and the customer who just
// paid still gets "O PIX expirou".
//
// The Redis double is KEY-SENSITIVE — the BKL-241 defect is invisible to a `get`
// that resolves the same value for every key. It is now the canonical in-memory
// adapter (`@ibatexas/tools/testing`), INJECTED through the module's own seam
// rather than installed over `getRedisClient`.
//
// PIXPAIDFLAG: isPixPaid() must not rely solely on the best-effort Redis flag
// (set AFTER the DB write and catch-and-ignored on failure, 2h TTL). When the
// flag is absent it falls back to the Payment projection — the billing source of
// truth — so a customer who already paid never receives a spurious reminder.
//
// ── R5 rollout, family 2 — what the migration killed here ───────────────────
//
//   1. `rk` was faked to `ibatexas:${k}` — a prefix production has NEVER
//      written (the real `rk()` under apps/api's vitest resolves to
//      `development:`). Both key assertions in the idempotency block asserted
//      against a keyspace that does not exist.
//   2. The hand-rolled Map double was honest about NX but existed in three
//      DIFFERENT shapes across the file — `{get, set}` here, `{get}` there — so
//      which commands a case could reach depended on which `beforeEach` ran.
//   3. Two whole describes drove `set` from `mockResolvedValue`/`…Once`, so the
//      NX claim's KEYSPACE was never involved: "a retry sends exactly once"
//      was pinned by a scripted `"OK"` then `null`, not by the second SET
//      finding the first one's key. The claim is now real.
//
// Mocks: @ibatexas/tools (getRedisClient TRIPWIRE + medusaAdmin; `rk` is REAL),
//        @ibatexas/domain (createPaymentQueryService),
//        ../../whatsapp/client.js (sendText), ../../lib/logger.js,
//        ../queue.js (BullMQ factories), @sentry/node.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentStatus } from "@ibatexas/types";
// `rk` is the REAL one — the `vi.mock` below spreads the actual module and
// replaces only the client resolver. `vi.mock` is hoisted, so importing here
// binds the mocked namespace either way.
import { rk } from "@ibatexas/tools";
import { createInMemoryRedis, type InMemoryRedis } from "@ibatexas/tools/testing";

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockGetByStripePaymentIntentId = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, getRedisClient: mockGetRedisClient, medusaAdmin: mockMedusaAdmin };
});

vi.mock("@ibatexas/domain", () => ({
  createPaymentQueryService: vi.fn(() => ({
    getByStripePaymentIntentId: mockGetByStripePaymentIntentId,
  })),
}));

vi.mock("../../whatsapp/client.js", () => ({
  sendText: mockSendText,
}));

vi.mock("../../lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Only the BullMQ FACTORIES are replaced; `assertDepsBag` is spread through
// REAL, so `processPixExpiry`'s deps guard is the production one here too.
vi.mock("../queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../queue.js")>();
  return {
    ...actual,
    createQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
    createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
  };
});

vi.mock("@sentry/node", () => ({
  withScope: vi.fn(),
  captureException: vi.fn(),
}));

import {
  isPixPaid,
  markPixPaid,
  processPixExpiry,
  type PixExpiryJobData,
} from "../pix-expiry-monitor.js";
import type { Job } from "../queue.js";

function buildJob(stage: "reminder" | "expired", paymentIntentId: string): Job<PixExpiryJobData> {
  return {
    data: { phone: "+5511999999999", phoneHash: "hash", paymentIntentId, stage },
  } as Job<PixExpiryJobData>;
}

let redis: InMemoryRedis;

/**
 * A FROZEN clock, not `Date.now`.
 *
 * The TTL cases below assert an EXACT remaining lifetime (`toBe(7_200_000)`),
 * which is the whole point — a `toBeGreaterThan(0)` cannot tell a 2-hour marker
 * from a 2-second one. Against a wall clock that equality is a flake: under a
 * loaded full-suite run, milliseconds elapse between the module's SET and the
 * test's read, and 7_200_000 becomes 7_199_998. Measured, not theorised — the
 * first draft of the sibling seam suite failed exactly this way at 132ms.
 * Freeze the clock and the exact assertion is both strict and deterministic.
 */
const FROZEN_NOW = 1_700_000_000_000;

/**
 * Arms the singleton TRIPWIRE and returns a fresh keyspace. Every case in this
 * file injects; a resolution means the seam stopped working.
 */
function freshKeyspace(): InMemoryRedis {
  const r = createInMemoryRedis({ now: () => FROZEN_NOW });
  mockGetRedisClient.mockRejectedValue(
    new Error("getRedisClient() resolved — the pix-expiry-monitor seam is unwired"),
  );
  return r;
}

const paid = (pi: string) => isPixPaid(pi, { redis: redis.client });
const mark = (pi: string) => markPixPaid(pi, { redis: redis.client });
const process_ = (job: Job<PixExpiryJobData>) => processPixExpiry(job, { redis: redis.client });

describe("BKL-241 — marker and monitor share one canonical id", () => {
  const PI_ID = "pi_3RstubPIXattempt";
  const ORDER_ID = "order_01JRAWMEDUSAID";

  beforeEach(() => {
    vi.clearAllMocks();
    redis = freshKeyspace();
    // No Payment row yet — the unpaid create_checkout PIX case, where the cart
    // is completed only on payment. Isolates the Redis marker as the signal.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
  });

  it("silences the monitor scheduled with the PI id once the webhook marks that PI paid", async () => {
    // Exactly what the Stripe webhook does on payment_intent.succeeded.
    await mark(PI_ID);

    await process_(buildJob("reminder", PI_ID));
    await process_(buildJob("expired", PI_ID));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("writes the marker under the PI id the monitor reads, through the REAL rk()", async () => {
    await mark(PI_ID);

    // `development:pix:paid:pi_…` — the key production writes. The retired
    // double asserted an `ibatexas:` prefix nothing has ever written.
    expect(redis.keys()).toEqual([rk(`pix:paid:${PI_ID}`)]);
    expect(await paid(PI_ID)).toBe(true);
  });

  it("gives the paid marker a 2h TTL (the window pending jobs have to check)", async () => {
    await mark(PI_ID);

    // An exact remaining lifetime, not an echo of the EX argument the module
    // passed in — the double could only ever have re-asserted its own input.
    expect(redis.ttlMs(rk(`pix:paid:${PI_ID}`))).toBe(7_200_000);
  });

  it("reverts to red: a marker written under the ORDER id leaves the paid customer messaged", async () => {
    // The pre-fix behaviour, reproduced: handlePaymentSucceeded called
    // markPixPaid(orderId) while the job had been scheduled with the `pi_…` id.
    // The two sides key on different ids, so the paid flag never matches — this
    // is the live-reproduced defect, and it must still be detectable here.
    await mark(ORDER_ID);

    await process_(buildJob("expired", PI_ID));

    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(await paid(PI_ID)).toBe(false);
  });

  it("keeps attempts independent — paying attempt #2 does not silence attempt #1", async () => {
    // amend_order / regenerate_pix mint a SECOND PI against the same order and
    // schedule their own monitor pair. Attempt-scoped keys are what make the
    // two monitors separable at all.
    const SECOND_PI = "pi_3RstubPIXretry";
    await mark(SECOND_PI);

    await process_(buildJob("expired", SECOND_PI));
    expect(mockSendText).not.toHaveBeenCalled();

    await process_(buildJob("expired", PI_ID));
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("still reads jobs enqueued before the rename (in-flight compat)", async () => {
    await mark(PI_ID);

    // A delayed job that survived the deploy: the id sits under `orderId` and
    // already held the `pi_…` value.
    const legacyJob = {
      data: { phone: "+5511999999999", phoneHash: "hash", orderId: PI_ID, stage: "expired" },
    } as unknown as Job<PixExpiryJobData>;

    await process_(legacyJob);

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("sends nothing when the job carries no id at all (paid-check unanswerable)", async () => {
    const idlessJob = {
      data: { phone: "+5511999999999", phoneHash: "hash", stage: "expired" },
    } as unknown as Job<PixExpiryJobData>;

    await process_(idlessJob);

    expect(mockSendText).not.toHaveBeenCalled();
    // The guard short-circuits BEFORE any client is touched.
    expect(redis.calls).toHaveLength(0);
  });
});

describe("isPixPaid — PIXPAIDFLAG DB fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis = freshKeyspace();
  });

  it("returns true from the Redis flag without consulting the DB", async () => {
    await redis.client.set(rk("pix:paid:pi_1"), "1");

    expect(await paid("pi_1")).toBe(true);
    expect(mockGetByStripePaymentIntentId).not.toHaveBeenCalled();
  });

  it("falls back to the DB and returns true when the PI's Payment is PAID", async () => {
    // Flag absent — SET failed / TTL-evicted / restart. An EMPTY keyspace is the
    // honest expression of that; the retired double stubbed `get → null`.
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAID });

    expect(await paid("pi_2")).toBe(true);
    // BKL-241: the fallback asks about THIS attempt — a findUnique on the unique
    // stripePaymentIntentId column, not the order's most-recent non-terminal row.
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_2");
  });

  it("falls back once the flag's own TTL has really lapsed", async () => {
    let clock = 1_700_000_000_000;
    redis = createInMemoryRedis({ now: () => clock });
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAID });

    await mark("pi_ttl");
    expect(await paid("pi_ttl")).toBe(true);
    expect(mockGetByStripePaymentIntentId).not.toHaveBeenCalled();

    // Past the 2h marker window: the flag is gone and the DB is consulted.
    clock += 7_200_001;
    expect(await paid("pi_ttl")).toBe(true);
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_ttl");
  });

  it("returns false when the flag is absent and the PI's Payment is not yet paid", async () => {
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAYMENT_PENDING });

    expect(await paid("pi_3")).toBe(false);
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_3");
  });

  it("returns false when the flag is absent and there is no Payment for the PI", async () => {
    mockGetByStripePaymentIntentId.mockResolvedValue(null);

    expect(await paid("pi_4")).toBe(false);
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_4");
  });

  it("returns false (never throws) when the DB fallback query fails", async () => {
    mockGetByStripePaymentIntentId.mockRejectedValue(new Error("db unavailable"));

    await expect(paid("pi_5")).resolves.toBe(false);
  });

  it("uses the singleton when NO client is threaded (the default is preserved)", async () => {
    // The fallback control for every injected case above: without it, the
    // tripwire is compatible with a module that resolves nothing at all.
    const singleton = createInMemoryRedis();
    mockGetRedisClient.mockResolvedValue(singleton.client);
    await singleton.client.set(rk("pix:paid:pi_default"), "1");

    expect(await isPixPaid("pi_default")).toBe(true);
    expect(mockGetByStripePaymentIntentId).not.toHaveBeenCalled();
    expect(redis.calls).toHaveLength(0);
  });
});

describe("processPixExpiry — suppresses messaging on DB-confirmed payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis = freshKeyspace();
  });

  it("does NOT send a reminder when the flag is absent but the Payment is PAID", async () => {
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAID });

    await process_(buildJob("reminder", "pi_paid"));

    expect(mockSendText).not.toHaveBeenCalled();
    // A suppressed send never claims the NX key either — so a later run that
    // legitimately needs to message is not locked out by this one.
    expect(redis.keys()).toEqual([]);
  });

  it("sends a reminder when neither the flag nor the Payment indicate payment", async () => {
    mockGetByStripePaymentIntentId.mockResolvedValue(null);

    await process_(buildJob("reminder", "pi_unpaid"));

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });
});

describe("processPixExpiry — scheduled-pickup copy resolves PI → order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis = freshKeyspace();
  });

  it("reads the order through the Payment projection, never GET /admin/orders/pi_…", async () => {
    mockGetByStripePaymentIntentId.mockResolvedValue({
      status: PaymentStatus.PAYMENT_PENDING,
      orderId: "order_01JSCHEDULED",
    });
    mockMedusaAdmin.mockResolvedValue({
      order: { metadata: { scheduledPickup: "true" } },
    });

    await process_(buildJob("expired", "pi_sched"));

    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_01JSCHEDULED");
    const [, reply] = mockSendText.mock.calls[0] as [string, { text: string }];
    expect(reply.text).toContain("pedido tá salvo");
    expect(reply.text).toContain("novo pix");
  });

  it("falls through to the generic copy when no Payment row exists for the attempt", async () => {
    // The unpaid create_checkout case: no order was ever created, so there is
    // nothing to resolve and no admin read to make.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);

    await process_(buildJob("expired", "pi_no_order"));

    expect(mockMedusaAdmin).not.toHaveBeenCalled();
    const [, reply] = mockSendText.mock.calls[0] as [string, { text: string }];
    expect(reply.text).toContain("Quer que eu gere um novo QR?");
  });
});

describe("processPixExpiry — P3-NET-PIXREMINDER per-stage send idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis = freshKeyspace();
    // Unpaid in every case here — we are isolating the NX send guard.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
  });

  it("claims the send with SET NX before messaging (keyed by paymentIntentId+stage)", async () => {
    await process_(buildJob("reminder", "pi_idem"));

    const sets = redis.calls.filter((c) => c.command === "set");
    expect(sets.map((c) => c.args)).toContainEqual([
      rk("pix:reminder-sent:pi_idem:reminder"),
      "1",
      { NX: true, EX: 3600 },
    ]);
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(redis.ttlMs(rk("pix:reminder-sent:pi_idem:reminder"))).toBe(3_600_000);
  });

  it("does NOT re-send when the claim key is already present (a prior run sent it)", async () => {
    // Seeded the way a prior run would have left it, not by scripting `set` to
    // answer null.
    await redis.client.set(rk("pix:reminder-sent:pi_dupe:reminder"), "1");

    await process_(buildJob("reminder", "pi_dupe"));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("a retry of the same {paymentIntentId,stage} sends exactly once across two invocations", async () => {
    // The SECOND invocation's NX genuinely finds the FIRST one's key — the
    // retired version scripted "OK" then null and never connected them.
    await process_(buildJob("expired", "pi_retry"));
    await process_(buildJob("expired", "pi_retry"));

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("uses a stage-scoped key so reminder and expired are independent claims", async () => {
    await process_(buildJob("reminder", "pi_two_stage"));
    await process_(buildJob("expired", "pi_two_stage"));

    expect(redis.keys()).toEqual([
      rk("pix:reminder-sent:pi_two_stage:expired"),
      rk("pix:reminder-sent:pi_two_stage:reminder"),
    ]);
    // Both distinct stages send (the guard is per-stage, not per-order).
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });

  it("the claim expires with its own TTL, so a much later retry can send again", async () => {
    let clock = 1_700_000_000_000;
    redis = createInMemoryRedis({ now: () => clock });

    await process_(buildJob("reminder", "pi_lapse"));
    clock += 3_600_001; // past PIX_REMINDER_SENT_TTL_SECONDS
    await process_(buildJob("reminder", "pi_lapse"));

    expect(mockSendText).toHaveBeenCalledTimes(2);
  });
});
