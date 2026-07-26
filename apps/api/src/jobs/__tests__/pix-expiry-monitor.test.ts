// Unit tests for the PIX expiry monitor's payment-confirmation check.
//
// BKL-241: the monitor and the `pix:paid:` marker must key on ONE id — the
// Stripe PaymentIntent id of the PIX attempt. The scheduler only ever holds a
// `pi_…` id (at QR-mint time no Medusa order exists yet), so a marker written
// under the order id is a key `isPixPaid` never reads and the customer who just
// paid still gets "O PIX expirou".
//
// The Redis double here is KEY-SENSITIVE (a real Map, NX honoured) rather than a
// blanket mockResolvedValue: a marker written under one key and read under
// another has to actually miss, or the test cannot see the defect at all. The
// first describe block pins that by driving markPixPaid → processPixExpiry
// through the same store, and includes the revert-to-red case.
//
// PIXPAIDFLAG: isPixPaid() must not rely solely on the best-effort Redis flag
// (set AFTER the DB write and catch-and-ignored on failure, 2h TTL). When the
// flag is absent it falls back to the Payment projection — the billing source of
// truth — so a customer who already paid never receives a spurious reminder.
//
// Mocks: @ibatexas/tools (getRedisClient, rk, medusaAdmin),
//        @ibatexas/domain (createPaymentQueryService),
//        ../../whatsapp/client.js (sendText), ../../lib/logger.js,
//        ../queue.js (BullMQ factories), @sentry/node.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaymentStatus } from "@ibatexas/types";

const mockRedisGet = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockGetByStripePaymentIntentId = vi.hoisted(() => vi.fn());
const mockSendText = vi.hoisted(() => vi.fn());
const mockMedusaAdmin = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getRedisClient: mockGetRedisClient,
  rk: (key: string) => `ibatexas:${key}`,
  medusaAdmin: mockMedusaAdmin,
}));

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

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
  createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));

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

/**
 * A Map-backed Redis double. Distinguishing keys is the whole point: the BKL-241
 * defect is invisible to a `get` that resolves the same value for every key.
 */
function installFakeRedis(): Map<string, string> {
  const store = new Map<string, string>();
  mockGetRedisClient.mockResolvedValue({
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
  });
  return store;
}

describe("BKL-241 — marker and monitor share one canonical id", () => {
  const PI_ID = "pi_3RstubPIXattempt";
  const ORDER_ID = "order_01JRAWMEDUSAID";

  beforeEach(() => {
    vi.clearAllMocks();
    installFakeRedis();
    // No Payment row yet — the unpaid create_checkout PIX case, where the cart
    // is completed only on payment. Isolates the Redis marker as the signal.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
  });

  it("silences the monitor scheduled with the PI id once the webhook marks that PI paid", async () => {
    // Exactly what the Stripe webhook does on payment_intent.succeeded.
    await markPixPaid(PI_ID);

    await processPixExpiry(buildJob("reminder", PI_ID));
    await processPixExpiry(buildJob("expired", PI_ID));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("writes the marker under the PI id the monitor reads", async () => {
    const store = installFakeRedis();
    await markPixPaid(PI_ID);

    expect([...store.keys()]).toEqual([`ibatexas:pix:paid:${PI_ID}`]);
    expect(await isPixPaid(PI_ID)).toBe(true);
  });

  it("reverts to red: a marker written under the ORDER id leaves the paid customer messaged", async () => {
    // The pre-fix behaviour, reproduced: handlePaymentSucceeded called
    // markPixPaid(orderId) while the job had been scheduled with the `pi_…` id.
    // The two sides key on different ids, so the paid flag never matches — this
    // is the live-reproduced defect, and it must still be detectable here.
    await markPixPaid(ORDER_ID);

    await processPixExpiry(buildJob("expired", PI_ID));

    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(await isPixPaid(PI_ID)).toBe(false);
  });

  it("keeps attempts independent — paying attempt #2 does not silence attempt #1", async () => {
    // amend_order / regenerate_pix mint a SECOND PI against the same order and
    // schedule their own monitor pair. Attempt-scoped keys are what make the
    // two monitors separable at all.
    const SECOND_PI = "pi_3RstubPIXretry";
    await markPixPaid(SECOND_PI);

    await processPixExpiry(buildJob("expired", SECOND_PI));
    expect(mockSendText).not.toHaveBeenCalled();

    await processPixExpiry(buildJob("expired", PI_ID));
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("still reads jobs enqueued before the rename (in-flight compat)", async () => {
    await markPixPaid(PI_ID);

    // A delayed job that survived the deploy: the id sits under `orderId` and
    // already held the `pi_…` value.
    const legacyJob = {
      data: { phone: "+5511999999999", phoneHash: "hash", orderId: PI_ID, stage: "expired" },
    } as unknown as Job<PixExpiryJobData>;

    await processPixExpiry(legacyJob);

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("sends nothing when the job carries no id at all (paid-check unanswerable)", async () => {
    const idlessJob = {
      data: { phone: "+5511999999999", phoneHash: "hash", stage: "expired" },
    } as unknown as Job<PixExpiryJobData>;

    await processPixExpiry(idlessJob);

    expect(mockSendText).not.toHaveBeenCalled();
  });
});

describe("isPixPaid — PIXPAIDFLAG DB fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet });
  });

  it("returns true from the Redis flag without consulting the DB", async () => {
    mockRedisGet.mockResolvedValue("1");

    expect(await isPixPaid("pi_1")).toBe(true);
    expect(mockGetByStripePaymentIntentId).not.toHaveBeenCalled();
  });

  it("falls back to the DB and returns true when the PI's Payment is PAID", async () => {
    mockRedisGet.mockResolvedValue(null); // flag absent (SET failed / TTL-evicted / restart)
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAID });

    expect(await isPixPaid("pi_2")).toBe(true);
    // BKL-241: the fallback asks about THIS attempt — a findUnique on the unique
    // stripePaymentIntentId column, not the order's most-recent non-terminal row.
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_2");
  });

  it("returns false when the flag is absent and the PI's Payment is not yet paid", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAYMENT_PENDING });

    expect(await isPixPaid("pi_3")).toBe(false);
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_3");
  });

  it("returns false when the flag is absent and there is no Payment for the PI", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);

    expect(await isPixPaid("pi_4")).toBe(false);
    expect(mockGetByStripePaymentIntentId).toHaveBeenCalledWith("pi_4");
  });

  it("returns false (never throws) when the DB fallback query fails", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetByStripePaymentIntentId.mockRejectedValue(new Error("db unavailable"));

    await expect(isPixPaid("pi_5")).resolves.toBe(false);
  });
});

describe("processPixExpiry — suppresses messaging on DB-confirmed payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet, set: mockRedisSet });
    // Default: NX claim succeeds (first run for this {paymentIntentId,stage}).
    mockRedisSet.mockResolvedValue("OK");
  });

  it("does NOT send a reminder when the flag is absent but the Payment is PAID", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetByStripePaymentIntentId.mockResolvedValue({ status: PaymentStatus.PAID });

    await processPixExpiry(buildJob("reminder", "pi_paid"));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("sends a reminder when neither the flag nor the Payment indicate payment", async () => {
    mockRedisGet.mockResolvedValue(null);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);

    await processPixExpiry(buildJob("reminder", "pi_unpaid"));

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });
});

describe("processPixExpiry — scheduled-pickup copy resolves PI → order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet, set: mockRedisSet });
    mockRedisSet.mockResolvedValue("OK");
    mockRedisGet.mockResolvedValue(null);
  });

  it("reads the order through the Payment projection, never GET /admin/orders/pi_…", async () => {
    mockGetByStripePaymentIntentId.mockResolvedValue({
      status: PaymentStatus.PAYMENT_PENDING,
      orderId: "order_01JSCHEDULED",
    });
    mockMedusaAdmin.mockResolvedValue({
      order: { metadata: { scheduledPickup: "true" } },
    });

    await processPixExpiry(buildJob("expired", "pi_sched"));

    expect(mockMedusaAdmin).toHaveBeenCalledWith("/admin/orders/order_01JSCHEDULED");
    const [, reply] = mockSendText.mock.calls[0] as [string, { text: string }];
    expect(reply.text).toContain("pedido tá salvo");
    expect(reply.text).toContain("novo pix");
  });

  it("falls through to the generic copy when no Payment row exists for the attempt", async () => {
    // The unpaid create_checkout case: no order was ever created, so there is
    // nothing to resolve and no admin read to make.
    mockGetByStripePaymentIntentId.mockResolvedValue(null);

    await processPixExpiry(buildJob("expired", "pi_no_order"));

    expect(mockMedusaAdmin).not.toHaveBeenCalled();
    const [, reply] = mockSendText.mock.calls[0] as [string, { text: string }];
    expect(reply.text).toContain("Quer que eu gere um novo QR?");
  });
});

describe("processPixExpiry — P3-NET-PIXREMINDER per-stage send idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedisClient.mockResolvedValue({ get: mockRedisGet, set: mockRedisSet });
    // Unpaid in every case here — we are isolating the NX send guard.
    mockRedisGet.mockResolvedValue(null);
    mockGetByStripePaymentIntentId.mockResolvedValue(null);
  });

  it("claims the send with SET NX before messaging (keyed by paymentIntentId+stage)", async () => {
    mockRedisSet.mockResolvedValue("OK");

    await processPixExpiry(buildJob("reminder", "pi_idem"));

    expect(mockRedisSet).toHaveBeenCalledWith(
      "ibatexas:pix:reminder-sent:pi_idem:reminder",
      "1",
      { NX: true, EX: 3600 },
    );
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-send when the NX claim fails (key already set by a prior run)", async () => {
    mockRedisSet.mockResolvedValue(null); // NX → null: another run already sent it

    await processPixExpiry(buildJob("reminder", "pi_dupe"));

    expect(mockSendText).not.toHaveBeenCalled();
  });

  it("a retry of the same {paymentIntentId,stage} sends exactly once across two invocations", async () => {
    // First invocation claims the key; the second sees it already set.
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await processPixExpiry(buildJob("expired", "pi_retry"));
    await processPixExpiry(buildJob("expired", "pi_retry"));

    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it("uses a stage-scoped key so reminder and expired are independent claims", async () => {
    mockRedisSet.mockResolvedValue("OK");

    await processPixExpiry(buildJob("reminder", "pi_two_stage"));
    await processPixExpiry(buildJob("expired", "pi_two_stage"));

    const keys = mockRedisSet.mock.calls.map((c) => c[0]);
    expect(keys).toContain("ibatexas:pix:reminder-sent:pi_two_stage:reminder");
    expect(keys).toContain("ibatexas:pix:reminder-sent:pi_two_stage:expired");
    // Both distinct stages send (the guard is per-stage, not per-order).
    expect(mockSendText).toHaveBeenCalledTimes(2);
  });
});
