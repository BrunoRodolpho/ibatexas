// Unit tests for the escalation park-expiry sweeper — BKL-114.
//
// We drive sweepEscalationParkExpiry() directly (no BullMQ, no network). Redis
// is a tiny in-memory stub implementing BOTH the EscalationRedis surface (so the
// real createEscalationStore runs over it) AND the SweeperRedis surface
// (scanIterator / get / exists). Park "presence" is modeled by the key's
// presence in the kv map — a lapsed/consumed park is simply an absent key, which
// is exactly the real semantic the sweeper keys off.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createInMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import {
  createEscalationStore,
  type EscalationRedis,
  type PendingEscalationIntent,
} from "../../escalation/escalation-store.js";
import {
  sweepEscalationParkExpiry,
  startEscalationParkExpirySweeper,
  stopEscalationParkExpirySweeper,
  type SweeperRedis,
} from "../escalation-park-expiry-sweeper.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mockGetRedisClient = vi.hoisted(() => vi.fn());
const mockSentryWithScope = vi.hoisted(() => vi.fn());
const mockSentryCaptureException = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", async () => {
  // R5-S7 — `rk` was faked here as `test:${key}`, a prefix production never
  // writes. It is spread from the REAL module now, so every key below is the key
  // the sweeper actually scans and the store actually writes.
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools");
  return { ...actual, getRedisClient: mockGetRedisClient };
});

vi.mock("@sentry/node", () => ({
  withScope: mockSentryWithScope,
  captureException: mockSentryCaptureException,
  init: vi.fn(),
}));

vi.mock("../queue.js", () => ({
  createQueue: vi.fn(() => ({
    upsertJobScheduler: vi.fn(),
    close: vi.fn(),
  })),
  createWorker: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// R5-S7 — the canonical in-memory adapter replaces a hand-rolled stub whose
// sAdd/sRem answered a constant 1 whether or not membership actually changed,
// and which modelled no TTL for the park keys this sweeper is entirely about.
type RedisStub = ReturnType<typeof createInMemoryRedis>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  } as unknown as import("fastify").FastifyBaseLogger;
}

const FIXED_NOW = "2026-07-04T13:00:00.000Z";

const BASE_INTENT: Omit<PendingEscalationIntent, "token" | "intentHash" | "status"> = {
  intentKind: "payment.refund.issue",
  summaryPtBr: "reembolso de R$ 1.500,00",
  requestedAt: "2026-07-04T12:00:00.000Z",
};

/**
 * Seed an escalation record carrying one intent, optionally with a live park
 * key. `resolved: true` first resolves the record (mirrors a resolved record
 * that STILL holds a pending intent — the escalation:open-incompleteness case).
 */
async function seed(
  stub: RedisStub,
  opts: {
    sessionId: string;
    token: string;
    intentHash: string;
    status?: PendingEscalationIntent["status"];
    parkPresent: boolean;
    resolved?: boolean;
  },
): Promise<void> {
  const store = createEscalationStore(stub.client as unknown as EscalationRedis);
  await store.recordHandoff({ sessionId: opts.sessionId, at: "2026-07-04T12:00:00.000Z" });
  await store.appendPendingIntent(opts.sessionId, {
    ...BASE_INTENT,
    token: opts.token,
    intentHash: opts.intentHash,
    status: opts.status ?? "pending",
  });
  if (opts.resolved) {
    await store.resolve(opts.sessionId, "staff:owner", "2026-07-04T12:30:00.000Z");
  }
  if (opts.parkPresent) {
    await stub.client.set(rk(`escalation:park:${opts.token}`), JSON.stringify({ token: opts.token }));
  }
}

function runSweep(stub: RedisStub, log = makeLogger()) {
  const store = createEscalationStore(stub.client as unknown as EscalationRedis);
  return sweepEscalationParkExpiry(log, {
    redis: stub.client as unknown as SweeperRedis,
    store,
    nowIso: () => FIXED_NOW,
  });
}

async function readIntent(
  stub: RedisStub,
  sessionId: string,
): Promise<PendingEscalationIntent | undefined> {
  const store = createEscalationStore(stub.client as unknown as EscalationRedis);
  return (await store.get(sessionId))?.pendingIntents?.[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("sweepEscalationParkExpiry (BKL-114)", () => {
  let stub: RedisStub;

  beforeEach(() => {
    vi.clearAllMocks();
    stub = createInMemoryRedis();
    mockGetRedisClient.mockImplementation(async () => stub.client);
    mockSentryWithScope.mockImplementation((cb: (s: unknown) => void) =>
      cb({ setTag: vi.fn(), setContext: vi.fn() }),
    );
  });

  afterEach(async () => {
    await stopEscalationParkExpirySweeper();
  });

  // (a) pending intent + park ABSENT → marked expired (resolvedBy=system).
  it("marks a pending intent expired when its backing park is absent", async () => {
    await seed(stub, {
      sessionId: "s_lapsed",
      token: "tok-a",
      intentHash: "ih_a",
      parkPresent: false,
    });

    const result = await runSweep(stub);

    expect(result).toEqual({ scanned: 1, expired: 1 });
    const intent = await readIntent(stub, "s_lapsed");
    expect(intent?.status).toBe("expired");
    expect(intent?.resolvedBy).toBe("system");
    expect(intent?.resolvedAt).toBe(FIXED_NOW);
  });

  // (b) pending intent + park PRESENT → untouched.
  it("leaves a pending intent alone when its backing park is still alive", async () => {
    await seed(stub, {
      sessionId: "s_live",
      token: "tok-b",
      intentHash: "ih_b",
      parkPresent: true,
    });

    const result = await runSweep(stub);

    expect(result).toEqual({ scanned: 1, expired: 0 });
    expect((await readIntent(stub, "s_live"))?.status).toBe("pending");
  });

  // (c) intent already "approved" + park absent → NOT overwritten (CAS guard).
  it("does NOT overwrite an already-approved intent whose park is absent (consumed on resolve)", async () => {
    await seed(stub, {
      sessionId: "s_approved",
      token: "tok-c",
      intentHash: "ih_c",
      status: "approved",
      parkPresent: false,
    });

    const result = await runSweep(stub);

    // Non-pending rows are filtered out before markIntentExpired is ever reached;
    // the CAS guard in markIntentExpired is the second line of defense (see the
    // store test). Either way: the approved row is preserved.
    expect(result).toEqual({ scanned: 1, expired: 0 });
    expect((await readIntent(stub, "s_approved"))?.status).toBe("approved");
  });

  // (d) a RESOLVED record still holding a pending+park-absent intent → still
  // swept. Proves the full-namespace SCAN (not enumeration from escalation:open,
  // which resolve() emptied).
  it("sweeps a pending intent on a RESOLVED record — proving the full escalation:rec:* scan", async () => {
    await seed(stub, {
      sessionId: "s_resolved",
      token: "tok-d",
      intentHash: "ih_d",
      parkPresent: false,
      resolved: true,
    });
    // Precondition: resolve() removed the session from escalation:open, so an
    // open-set enumeration would MISS this record entirely.
    expect(await stub.client.sMembers(rk("escalation:open"))).not.toContain("s_resolved");

    const result = await runSweep(stub);

    expect(result).toEqual({ scanned: 1, expired: 1 });
    expect((await readIntent(stub, "s_resolved"))?.status).toBe("expired");
  });

  // (e) malformed record JSON → skipped, sweep continues, other records still
  // processed.
  it("skips a malformed record and continues sweeping the rest of the batch", async () => {
    await seed(stub, {
      sessionId: "s_good",
      token: "tok-e",
      intentHash: "ih_e",
      parkPresent: false,
    });
    // Plant a malformed record in the same namespace.
    await stub.client.set(rk("escalation:rec:s_bad"), "{ not valid json");

    const log = makeLogger();
    const result = await sweepEscalationParkExpiry(log, {
      redis: stub.client as unknown as SweeperRedis,
      store: createEscalationStore(stub.client as unknown as EscalationRedis),
      nowIso: () => FIXED_NOW,
    });

    // Both keys were scanned; only the good one expired. No throw.
    expect(result.scanned).toBe(2);
    expect(result.expired).toBe(1);
    expect((await readIntent(stub, "s_good"))?.status).toBe("expired");
    // The malformed record surfaced a warn (containment), not a crash.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: rk("escalation:rec:s_bad") }),
      expect.stringContaining("error processing record"),
    );
  });

  // (f) Redis-down → 0, no throw.
  it("returns zero and does not throw when Redis is unavailable", async () => {
    mockGetRedisClient.mockRejectedValueOnce(new Error("redis down"));
    const log = makeLogger();

    // No deps injected → the sweeper reaches for getRedisClient, which rejects.
    const result = await sweepEscalationParkExpiry(log);

    expect(result).toEqual({ scanned: 0, expired: 0 });
    expect(log.error).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("Redis unavailable"),
    );
  });

  // Mixed batch sanity: several records, only the lapsed pending ones flip.
  it("sweeps only the lapsed pending intents in a mixed batch", async () => {
    await seed(stub, { sessionId: "s1", token: "t1", intentHash: "ih1", parkPresent: false });
    await seed(stub, { sessionId: "s2", token: "t2", intentHash: "ih2", parkPresent: true });
    await seed(stub, {
      sessionId: "s3",
      token: "t3",
      intentHash: "ih3",
      status: "rejected",
      parkPresent: false,
    });

    const result = await runSweep(stub);

    expect(result.scanned).toBe(3);
    expect(result.expired).toBe(1);
    expect((await readIntent(stub, "s1"))?.status).toBe("expired");
    expect((await readIntent(stub, "s2"))?.status).toBe("pending");
    expect((await readIntent(stub, "s3"))?.status).toBe("rejected");
  });

  // Idempotency: a second sweep is a no-op (the row is already expired).
  it("is idempotent — a second sweep does not re-touch an already-expired row", async () => {
    await seed(stub, { sessionId: "s_idem", token: "t", intentHash: "ih", parkPresent: false });

    const first = await runSweep(stub);
    expect(first.expired).toBe(1);

    const second = await runSweep(stub);
    expect(second).toEqual({ scanned: 1, expired: 0 });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("startEscalationParkExpirySweeper starts without throwing", () => {
    expect(() => startEscalationParkExpirySweeper()).not.toThrow();
  });

  it("stopEscalationParkExpirySweeper resolves when not started", async () => {
    await expect(stopEscalationParkExpirySweeper()).resolves.toBeUndefined();
  });
});
