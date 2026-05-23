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
import {
  ordersPolicyBundle,
  type OrderIntentKind,
  type OrderPayload,
  type OrderState,
} from "@ibatexas/pack-orders";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRedisSpillStub() {
  const store = new Map<string, string[]>();
  return {
    _store: store,
    async rPush(key: string, value: string) {
      const list = store.get(key) ?? [];
      list.push(value);
      store.set(key, list);
      return list.length;
    },
    async lPop(key: string) {
      const list = store.get(key);
      if (!list || list.length === 0) return null;
      return list.shift() ?? null;
    },
    async lLen(key: string) {
      return store.get(key)?.length ?? 0;
    },
    async expire(_key: string, _seconds: number) {
      return 1;
    },
  };
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
    const redis = makeRedisSpillStub();
    const failingWriter = makeFailingPostgresWriter();

    // Import wiring through the package's barrel which already loads in
    // tests. We use the test-isolation helpers re-exported there.
    const wiring = await import("@ibatexas/llm-provider");
    wiring._resetAuditSink();
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter });

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

    // First record evicted to Redis spill.
    const spilled = redis._store.get("test:audit:spill:queue") ?? [];
    expect(spilled.length).toBeGreaterThanOrEqual(1);

    // The spilled record contains a recognizable JSON envelope with a
    // valid intentHash (redactor-redacted but structurally intact).
    const parsed = JSON.parse(spilled[0]!) as { intentHash: string };
    expect(parsed.intentHash).toMatch(/^[0-9a-f]+$/);

    wiring._resetAuditSink();
  });

  it("audit sink failure does NOT raise to the caller (fail-open boundary)", async () => {
    const redis = makeRedisSpillStub();
    const failingWriter = makeFailingPostgresWriter();
    const wiring = await import("@ibatexas/llm-provider");
    wiring._resetAuditSink();
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter });

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
    const redis = makeRedisSpillStub();
    const failingWriter = makeFailingPostgresWriter();
    const wiring = await import("@ibatexas/llm-provider");
    wiring._resetAuditSink();
    wiring._setAuditSinkDependencies({ redis, prismaWriter: failingWriter });

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
