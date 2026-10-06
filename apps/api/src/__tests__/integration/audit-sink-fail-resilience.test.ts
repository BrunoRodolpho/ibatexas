// W6-3 — Audit-sink fail-mid-decision resilience test.
//
// Per audit/08-test-coverage-gaps.md item #3 (the "audit sink fails
// mid-decision; decision still completes" gap) and audit/06-reliability-
// fail-open.md §"Postgres outage + Redis spill" cascade D: the kernel
// decision MUST complete even if the audit sink throws. The route handler
// MUST still return its decision-driven status; the audit emission failure
// MUST land in the Redis spill (or in-memory fallback) and surface a
// telemetry signal.
//
// The test composes the same wiring as production but at a high enough
// level that we don't have to bring fastify online — adjudicate() is pure,
// and the wiring layer's contract is "fail-open at the IbateXas boundary".
// We assert:
//   1. adjudicate() returns EXECUTE despite the failing sink.
//   2. The Redis spill captures the record.
//   3. getAuditSink().emit() resolves (does NOT throw) when the inner
//      sink throws.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuditRecord, buildEnvelope } from "@adjudicate/core";
import { adjudicate } from "@adjudicate/core/kernel";
import { createInMemoryRedis } from "@ibatexas/tools/testing";
import {
  ordersPolicyBundle,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "@ibatexas/pack-orders";

// ── Helpers ────────────────────────────────────────────────────────────────

// R5-S9 — the hand-rolled FIFO double is gone; this drives the canonical
// in-memory adapter (`@ibatexas/tools/testing`) instead.
//
// The double it replaces was HONEST about the queue — a Map of arrays with
// `push`/`shift`, genuinely FIFO — which is why this file was the census'
// "deferred, not refused" entry rather than an urgent one. It carried exactly
// ONE fiction, and the adapter kills it: `expire` returned a constant `1` with
// no TTL model behind it, so the storage's documented 7-day backlog window
// (`DEFAULT_TTL_SECONDS`, "enough for any plausible inner-sink outage") was
// asserted into a void — nothing in this file, or anywhere, could tell a 7-day
// EXPIRE from a 7-second one. The adapter models TTL against an injected clock,
// so the window is now a real assertion below.
//
// The clock is frozen so that window lands on an exact number rather than a
// tolerance band around wall time.
const FIXED_NOW_MS = Date.parse("2026-05-23T00:00:00.000Z");
const SEVEN_DAYS_MS = 604_800_000;

function makeSpillRedis() {
  return createInMemoryRedis({ now: () => FIXED_NOW_MS });
}

function makeFailingPostgresWriter() {
  return {
    async $executeRawUnsafe(_sql: string, ..._args: unknown[]) {
      throw new Error("postgres connection refused — audit sink mid-emit failure");
    },
  };
}

function orderEnv(nonce: string) {
  return buildEnvelope<OrderIntentKind, OrderPayload>({
    kind: "order.cart.ensure",
    payload: { cartId: "cart-resilience-01" } as unknown as OrderPayload,
    actor: { principal: "llm", sessionId: "sess_resil_01" },
    taint: "UNTRUSTED",
    nonce,
    createdAt: "2026-05-23T00:00:00.000Z",
  });
}

// Spill-queue key — mirrors the inlined `rk()` in
// `@ibatexas/audit-sink/redis-spill-storage.ts`, which reads `APP_ENV` at CALL
// time (like the canonical `rk` in `packages/tools/src/redis/key.ts`, and for
// the same FE-D26 reason). The leaf resolves its queue key when
// `createRedisSpillStorage` runs — here, inside the `it`, via
// `_setAuditSinkDependencies`, i.e. AFTER `beforeEach` installs
// `vi.stubEnv("APP_ENV", "test")`. So this must be a call-time read too: a
// module-scope `const` would freeze to `"development"` (nothing sets APP_ENV
// before this file loads) and assert against a queue the SUT never writes.
//
// History, because the shape here is easy to get wrong twice (F-23):
//   - Originally this hardcoded `test:audit:spill:queue` and silently read an
//     empty list, because the leaf really did capture APP_ENV at module load
//     and so wrote `development:`.
//   - R5-S9 then froze this const the same way the leaf did. That matched the
//     leaf's behaviour but entrenched its defect: the leaf's own header claimed
//     byte-identity with the canonical `rk`, and on the capture-time axis it
//     was false.
//   - F-23 fixed the leaf instead of the mirror. With the leaf reading at call
//     time, the stub finally means something: APP_ENV=test => `test:` keys.
//
// The adapter rewrites no key, so whatever the leaf's inlined `rk` produces is
// exactly what lands in the keyspace asserted below.
const spillQueueKey = (): string =>
  `${process.env.APP_ENV ?? "development"}:audit:spill:queue`;

function orderState(): OrderState {
  return {
    ctx: {
      channel: "whatsapp",
      customerId: "cust_resil_01",
      cartId: "cart-resilience-01",
      orderId: null,
      items: [{ variantId: "v-1", quantity: 1, priceInCentavos: 5_000 }],
      fulfillment: "delivery",
      paymentMethod: "card",
      paymentStatus: "paid",
      totalInCentavos: 5_000,
      lastAction: null,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Audit-sink fail-mid-decision resilience (W6-3)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("AUDIT_REDACT_SECRET", "test-salt-32-xxxxxxxxxxxxxxxxxxx");
    vi.stubEnv("IBX_AUDIT_POSTGRES_ENABLED", "true");
    // Force capacity=1 so the first failed emit evicts the buffered
    // record into the Redis spill on the second emit.
    vi.stubEnv("IBX_AUDIT_BUFFER_CAPACITY", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kernel decision still completes when audit sink throws", () => {
    // The adjudicate() call MUST NOT depend on the audit sink. We verify
    // by calling adjudicate directly — its return value must not change.
    const env = orderEnv("n-resil-decision-only");
    const decision = adjudicate(env, orderState(), ordersPolicyBundle);
    expect(decision.kind).toBe("EXECUTE");
  });

  it("Redis spill captures the record when Postgres sink throws", async () => {
    const redis = makeSpillRedis();
    const failingWriter = makeFailingPostgresWriter();

    // Import wiring through the @ibatexas/audit-sink barrel. We use the
    // test-isolation helpers (_resetAuditSink / _setAuditSinkDependencies)
    // exported there.
    const wiring = await import("@ibatexas/audit-sink");
    wiring._resetAuditSink();
    wiring._setAuditSinkDependencies({ redis: redis.client, prismaWriter: failingWriter });

    const env = orderEnv("n-resil-spill-01");
    const decision = adjudicate(env, orderState(), ordersPolicyBundle);
    expect(decision.kind).toBe("EXECUTE");

    const record = buildAuditRecord({
      envelope: env,
      decision,
      durationMs: 1,
      at: "2026-05-23T00:00:00.500Z",
    });

    // First emit: fails internally, buffered (capacity=1).
    await wiring.getAuditSink().emit(record);

    // Second emit: triggers eviction of first record into spill.
    const env2 = orderEnv("n-resil-spill-02");
    const record2 = buildAuditRecord({
      envelope: env2,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: "2026-05-23T00:00:00.510Z",
    });
    await wiring.getAuditSink().emit(record2);

    // First record evicted to Redis spill. The spill list is the ONLY key the
    // sink wrote, and it is the one the leaf's real `rk()` derived — nothing
    // rewrote it on the way in.
    expect(redis.keys()).toEqual([spillQueueKey()]);
    expect(await redis.client.lLen(spillQueueKey())).toBeGreaterThanOrEqual(1);

    // The 7-day backlog window, now that EXPIRE is real. Under the constant-`1`
    // stub this assertion could not be written at all.
    expect(redis.ttlMs(spillQueueKey())).toBe(SEVEN_DAYS_MS);

    // Read the head with LPOP — the same command, off the same end, that the
    // storage's own `readAll()` drain uses. RPUSH-tail/LPOP-head is the module's
    // stated FIFO contract, so reading any other way would assert against an
    // order production never serves.
    const head = await redis.client.lPop(spillQueueKey());
    expect(head).not.toBeNull();

    // The spilled record contains a recognizable JSON envelope with a
    // valid intentHash (redactor-redacted but structurally intact).
    const parsed = JSON.parse(head!) as { intentHash: string };
    expect(parsed.intentHash).toMatch(/^[0-9a-f]+$/);

    wiring._resetAuditSink();
  });

  it("audit sink failure does NOT raise to the caller (fail-open boundary)", async () => {
    const redis = makeSpillRedis();
    const failingWriter = makeFailingPostgresWriter();
    const wiring = await import("@ibatexas/audit-sink");
    wiring._resetAuditSink();
    wiring._setAuditSinkDependencies({ redis: redis.client, prismaWriter: failingWriter });

    const env = orderEnv("n-resil-failopen");
    const record = buildAuditRecord({
      envelope: env,
      decision: { kind: "EXECUTE", basis: [] },
      durationMs: 1,
      at: "2026-05-23T00:00:00.500Z",
    });

    // emit() MUST resolve (not reject) despite the inner failure.
    await expect(wiring.getAuditSink().emit(record)).resolves.toBeUndefined();

    wiring._resetAuditSink();
  });

  it("route-handler-style flow: decision → audit emit fail → route still returns 200", async () => {
    const redis = makeSpillRedis();
    const failingWriter = makeFailingPostgresWriter();
    const wiring = await import("@ibatexas/audit-sink");
    wiring._resetAuditSink();
    wiring._setAuditSinkDependencies({ redis: redis.client, prismaWriter: failingWriter });

    // Simulated route handler — adjudicate, decide, emit audit fire-
    // and-forget, return status.
    const env = orderEnv("n-resil-route");
    const decision = adjudicate(env, orderState(), ordersPolicyBundle);
    let status = 500;
    if (decision.kind === "EXECUTE") {
      void wiring
        .getAuditSink()
        .emit(
          buildAuditRecord({
            envelope: env,
            decision,
            durationMs: 1,
            at: "2026-05-23T00:00:00.500Z",
          }),
        )
        .catch(() => {
          /* fail-open at the route boundary */
        });
      status = 200;
    }
    expect(status).toBe(200);

    // Allow the fire-and-forget emit to settle.
    await new Promise((r) => setImmediate(r));

    wiring._resetAuditSink();
  });
});
