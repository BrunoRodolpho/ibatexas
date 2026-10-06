// Tests for the Redis-backed escalation store + bot-pause (D2). Fake-redis;
// no live Redis. Validates the open/resolved lifecycle, the pause flag, the
// idempotent handoff, and the open-queue self-heal.

import { describe, it, expect, beforeEach } from "vitest";
import { createInMemoryRedis } from "@ibatexas/tools/testing";
import { rk } from "@ibatexas/tools";
import { createEscalationStore } from "../escalation-store.js";


describe("escalation store (D2)", () => {
  // R5-S7 — the canonical in-memory adapter. The hand-rolled EscalationRedis it
  // replaces answered sAdd/sRem/del with a bare mutation and no return, so a
  // caller reading a reply saw `undefined` where real Redis reports a count.
  let redis: ReturnType<typeof createInMemoryRedis>;
  beforeEach(() => {
    redis = createInMemoryRedis();
  });

  it("recordHandoff opens an escalation and pauses the session", async () => {
    const store = createEscalationStore(redis.client);
    const rec = await store.recordHandoff({
      sessionId: "s1",
      customerId: "cust-1",
      reason: "quero falar com humano",
      channel: "whatsapp",
      at: "2026-06-14T10:00:00.000Z",
    });
    expect(rec.status).toBe("open");
    expect(await store.isPaused("s1")).toBe(true);
    expect((await store.listOpen()).map((r) => r.sessionId)).toEqual(["s1"]);
  });

  it("recordHandoff persists the caller's customerId when known (D2 — not dropped to null)", async () => {
    const store = createEscalationStore(redis.client);
    const rec = await store.recordHandoff({
      sessionId: "s1",
      customerId: "cust-42",
      at: "2026-06-14T10:00:00.000Z",
    });
    expect(rec.customerId).toBe("cust-42");
    // round-trips through the store (persisted, not just returned).
    expect((await store.get("s1"))?.customerId).toBe("cust-42");
  });

  it("recordHandoff defaults customerId to null when the caller has none", async () => {
    const store = createEscalationStore(redis.client);
    const rec = await store.recordHandoff({ sessionId: "s2", at: "2026-06-14T10:00:00.000Z" });
    expect(rec.customerId).toBeNull();
  });

  it("recordHandoff is idempotent — preserves the original handoffAt + reason", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", reason: "first", at: "2026-06-14T10:00:00.000Z" });
    const second = await store.recordHandoff({
      sessionId: "s1",
      reason: "second",
      at: "2026-06-14T11:00:00.000Z",
    });
    expect(second.handoffAt).toBe("2026-06-14T10:00:00.000Z");
    expect(second.reason).toBe("first");
  });

  it("resolve un-pauses the session and drops it from the open queue", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-06-14T10:00:00.000Z" });
    const resolved = await store.resolve("s1", "staff:alice", "2026-06-14T10:05:00.000Z");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedBy).toBe("staff:alice");
    expect(await store.isPaused("s1")).toBe(false);
    expect(await store.listOpen()).toEqual([]);
  });

  it("isPaused is false for an unknown session", async () => {
    const store = createEscalationStore(redis.client);
    expect(await store.isPaused("never")).toBe(false);
  });

  it("listOpen sorts newest-first and self-heals stale set members", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "old", at: "2026-06-14T09:00:00.000Z" });
    await store.recordHandoff({ sessionId: "new", at: "2026-06-14T12:00:00.000Z" });
    // Plant a stale member whose record was evicted (TTL/manual delete).
    // The open-queue SET key, built the way the store builds it. The double this
    // replaces was probed for "ibx:escalation:open" — a prefix production has
    // never written — so that branch was dead and the test fell back to "the
    // first set key that happens to exist". rk() runs real now, so this is the key.
    await redis.client.sAdd(rk("escalation:open"), "ghost");

    const open = await store.listOpen();
    expect(open.map((r) => r.sessionId)).toEqual(["new", "old"]);
    // The ghost (no record) was healed out of the set.
    expect(await redis.client.sMembers(rk("escalation:open"))).not.toContain("ghost");
  });

  // ── AUT-017 — pending-intent projection ────────────────────────────────────

  const PENDING = {
    token: "tok-1",
    intentKind: "payment.refund.issue",
    intentHash: "sha256:abc",
    summaryPtBr: "reembolso de R$ 1.500,00",
    requestedAt: "2026-07-04T12:00:00.000Z",
    status: "pending" as const,
  };

  it("appendPendingIntent adds a pending intent to an OPEN escalation record", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    const rec = await store.appendPendingIntent("s1", PENDING);
    expect(rec?.pendingIntents).toHaveLength(1);
    expect(rec?.pendingIntents?.[0]?.intentHash).toBe("sha256:abc");
    // Round-trips through the store.
    expect((await store.get("s1"))?.pendingIntents?.[0]?.status).toBe("pending");
  });

  it("appendPendingIntent is idempotent on intentHash (NATS redelivery does not duplicate)", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    await store.appendPendingIntent("s1", PENDING);
    const rec = await store.appendPendingIntent("s1", { ...PENDING, token: "tok-2" });
    expect(rec?.pendingIntents).toHaveLength(1); // same intentHash → not duplicated
  });

  it("appendPendingIntent is a no-op (null) when the record is absent", async () => {
    const store = createEscalationStore(redis.client);
    expect(await store.appendPendingIntent("nope", PENDING)).toBeNull();
  });

  it("markIntentResolved flips a pending intent's status (idempotent on intentHash)", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    await store.appendPendingIntent("s1", PENDING);
    const rec = await store.markIntentResolved(
      "s1",
      "sha256:abc",
      "approved",
      "staff:owner2",
      "2026-07-04T12:05:00.000Z",
    );
    const intent = rec?.pendingIntents?.[0];
    expect(intent?.status).toBe("approved");
    expect(intent?.resolvedBy).toBe("staff:owner2");
    expect(intent?.resolvedAt).toBe("2026-07-04T12:05:00.000Z");
  });

  it("markIntentResolved is a no-op (null) when the intent is absent", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    expect(
      await store.markIntentResolved("s1", "sha256:missing", "approved", "x", "t"),
    ).toBeNull();
  });

  // ── BKL-114 — markIntentExpired (CAS-on-pending) ───────────────────────────

  it("markIntentExpired flips a pending intent → expired, stamping system provenance", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    await store.appendPendingIntent("s1", PENDING);
    const rec = await store.markIntentExpired(
      "s1",
      "sha256:abc",
      "2026-07-04T13:00:00.000Z",
    );
    const intent = rec?.pendingIntents?.[0];
    expect(intent?.status).toBe("expired");
    expect(intent?.resolvedBy).toBe("system");
    expect(intent?.resolvedAt).toBe("2026-07-04T13:00:00.000Z");
    // Round-trips through the store.
    expect((await store.get("s1"))?.pendingIntents?.[0]?.status).toBe("expired");
  });

  it("markIntentExpired is a NO-OP (null) when the intent is no longer pending — the CAS guard", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    // The intent raced to `approved` (a successful resolve — which also DEL'd the
    // park, so the sweeper would see the park "gone"). markIntentExpired MUST NOT
    // clobber it back to expired.
    await store.appendPendingIntent("s1", { ...PENDING, status: "approved" });
    const rec = await store.markIntentExpired(
      "s1",
      "sha256:abc",
      "2026-07-04T13:00:00.000Z",
    );
    expect(rec).toBeNull();
    // Status is untouched — still approved.
    expect((await store.get("s1"))?.pendingIntents?.[0]?.status).toBe("approved");
  });

  it("markIntentExpired is a no-op (null) when the intent is absent", async () => {
    const store = createEscalationStore(redis.client);
    await store.recordHandoff({ sessionId: "s1", at: "2026-07-04T12:00:00.000Z" });
    expect(
      await store.markIntentExpired("s1", "sha256:missing", "2026-07-04T13:00:00.000Z"),
    ).toBeNull();
  });

  it("markIntentExpired is a no-op (null) when the record is absent", async () => {
    const store = createEscalationStore(redis.client);
    expect(
      await store.markIntentExpired("nope", "sha256:abc", "2026-07-04T13:00:00.000Z"),
    ).toBeNull();
  });
});
