// F-28 — the health route's outbox key goes through `rk()` (Hard Rule #7).
//
// Before F-28, `checkQueues()` in `../routes/health.ts` built its outbox key
// inline — `${process.env.APP_ENV || "development"}:outbox:${event}` — two
// lines below a dlq key that already went through `rk()`. The two key families
// in ONE function therefore disagreed about the empty-APP_ENV case: canonical
// `rk` (packages/tools/src/redis/key.ts) uses `??`, so an empty APP_ENV is
// PRESENT and yields ":dlq:…"; the inline copy used `||`, so an empty APP_ENV
// is FALSY and yielded "development:outbox:…". Worse, the outbox WRITER
// (`outboxKey` in @ibatexas/nats-client, called from `publishNatsEvent` with
// `process.env.APP_ENV ?? "development"`) uses `??` too — so the health
// route was the ONLY participant in the outbox key family reading `||`, and on
// an empty APP_ENV it read a namespace nothing writes and reported a clean
// outbox over a real backlog.
//
// WHY A SEPARATE FILE from `health.test.ts`: when this file was written that
// one mocked `@ibatexas/tools` with `getRedisClient` ONLY, so `rk` was
// `undefined` inside the SUT and the first `rk(...)` call in `checkQueues`
// threw straight into that function's swallowing `catch` — its 9 tests never
// reached a queue key at all. F-30 has since completed that mock (real `rk` +
// a table-driven `lLen`) and pinned the handler's queue BEHAVIOUR there:
// dlq/outbox body fields, the hasDlqEntries / hasOutboxBacklog flags, the
// `len > 100` backlog threshold, and the non-fatal catch. The split still
// stands, and the two files are complementary, not redundant: this file is
// about WHICH KEYS the route asks Redis for (it delegates to the real `rk` and
// records every suffix), `health.test.ts` is about what the handler DOES with
// the lengths that come back (it holds the key bytes fixed).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { healthRoutes } from "../routes/health.js";

// Recorders. `vi.hoisted` because the `vi.mock` factory below is hoisted above
// this file's own top-level statements (house style — see cart-routes.test.ts).
const { rkCalls, lLenCalls } = vi.hoisted(() => ({
  /** Every SUFFIX handed to `rk()`, in call order. */
  rkCalls: [] as string[],
  /** Every FULL key the route actually asked Redis for, in call order. */
  lLenCalls: [] as string[],
}));

vi.mock("@ibatexas/tools", async () => {
  // The REAL `rk` (as cart-routes.test.ts does), wrapped in a spy that records
  // the suffix it was handed. Re-implementing `rk` here would make this test a
  // PROJECTION of the thing it checks: a hand-mirror of `${env}:${key}` agrees
  // with the inline construction exactly as readily as with `rk()`, so it could
  // not tell the two apart. Delegating to `actual.rk` keeps the prefix
  // semantics — including the `??` empty-string quirk pinned by PR #534 — real.
  const actual = await vi.importActual<typeof import("@ibatexas/tools")>("@ibatexas/tools");
  return {
    rk: vi.fn((key: string) => {
      rkCalls.push(key);
      return actual.rk(key);
    }),
    getRedisClient: vi.fn(async () => ({
      ping: vi.fn(async () => "PONG"),
      lLen: vi.fn(async (key: string) => {
        lLenCalls.push(key);
        // Every queue empty: `dlq`/`outbox` stay off the response body and the
        // status stays "healthy", so this file asserts about KEYS only and the
        // endpoint's response shape is untouched.
        return 0;
      }),
    })),
  };
});

vi.mock("@ibatexas/domain", () => ({
  prisma: { $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]) },
}));

vi.mock("@ibatexas/nats-client", () => ({
  getNatsConnection: vi.fn(async () => ({ isClosed: vi.fn(() => false) })),
}));

const originalFetch = globalThis.fetch;
const originalAppEnv = process.env.APP_ENV;

// ── Hand-written roll call ───────────────────────────────────────────────────
// Deliberately NOT derived from the route's own DLQ_EVENTS / OUTBOX_EVENTS
// arrays (module-private, and a derived list would delete its own coverage
// along with any deleted row). Every expectation below is spelled out in full
// so a renamed or dropped event NAME reds a test, not just a changed count.

describe("GET /health — outbox key construction (F-28)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    server = Fastify({ logger: false });
    await server.register(healthRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    if (originalAppEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnv;
  });

  /** Drive the real handler and hand back what it asked Redis for. */
  async function driveHealth(): Promise<void> {
    rkCalls.length = 0;
    lLenCalls.length = 0;
    const response = await server.inject({ method: "GET", url: "/health" });
    // Pin the unchanged contract while we are here: `checkQueues` swallows its
    // own errors, so without this a broken stub would look like a silent pass.
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("healthy");
  }

  // ── RTR TARGET ─────────────────────────────────────────────────────────────
  // Restoring the inline construction reds THIS test at any APP_ENV: `rk` is
  // simply never handed an "outbox:…" suffix.
  it("hands every outbox suffix to rk() — the key is not built inline", async () => {
    process.env.APP_ENV = "f28-probe-env";

    await driveHealth();

    expect(rkCalls).toEqual([
      "dlq:order.status_changed",
      "dlq:order.placed",
      "dlq:notification.send",
      "dlq:support.handoff_requested",
      "dlq:conversation.message.appended",
      "outbox:order.placed",
      "outbox:reservation.created",
      "outbox:order.status_changed",
      "outbox:order.refunded",
      "outbox:order.disputed",
      "outbox:order.canceled",
      "outbox:order.payment_failed",
    ]);
  });

  // ── MEASUREMENT 1: the normal case is NOT a key change ─────────────────────
  // This test passes under BOTH the inline construction and `rk()` — that is
  // precisely its claim. With APP_ENV set (the production and test norm) the
  // bytes the route asks Redis for are unchanged by F-28. Expectations are
  // written as LITERALS: neither `rk(...)` nor `${process.env.APP_ENV}:…`,
  // either of which would be a projection of the implementation.
  it("APP_ENV set: keys are byte-identical to the pre-F-28 inline form", async () => {
    process.env.APP_ENV = "f28-probe-env";

    await driveHealth();

    expect(lLenCalls).toEqual([
      "f28-probe-env:dlq:order.status_changed",
      "f28-probe-env:dlq:order.placed",
      "f28-probe-env:dlq:notification.send",
      "f28-probe-env:dlq:support.handoff_requested",
      "f28-probe-env:dlq:conversation.message.appended",
      "f28-probe-env:outbox:order.placed",
      "f28-probe-env:outbox:reservation.created",
      "f28-probe-env:outbox:order.status_changed",
      "f28-probe-env:outbox:order.refunded",
      "f28-probe-env:outbox:order.disputed",
      "f28-probe-env:outbox:order.canceled",
      "f28-probe-env:outbox:order.payment_failed",
    ]);
  });

  // ── MEASUREMENT 2: the empty-APP_ENV change, stated on purpose ─────────────
  // The ONE behavior change F-28 makes, and the point of the slice. Canonical
  // `rk` treats an empty APP_ENV as PRESENT (`??`), so the prefix is the empty
  // string and every key carries a leading colon. PR #534 pinned that leading
  // colon as a deliberate SHARED QUIRK of `rk`; F-28 does not touch it — it
  // only makes health.ts AGREE with `rk`, whatever `rk` does. Pre-F-28 the
  // outbox half answered "development:outbox:…" (`||` treats "" as falsy) while
  // the dlq half answered ":dlq:…": two namespaces from one function.
  // Also RTR-discriminating.
  it("APP_ENV empty: outbox keys share the dlq namespace instead of splitting", async () => {
    process.env.APP_ENV = "";

    await driveHealth();

    expect(lLenCalls).toEqual([
      ":dlq:order.status_changed",
      ":dlq:order.placed",
      ":dlq:notification.send",
      ":dlq:support.handoff_requested",
      ":dlq:conversation.message.appended",
      ":outbox:order.placed",
      ":outbox:reservation.created",
      ":outbox:order.status_changed",
      ":outbox:order.refunded",
      ":outbox:order.disputed",
      ":outbox:order.canceled",
      ":outbox:order.payment_failed",
    ]);

    // The property the split violated, asserted directly: every key the route
    // reads carries ONE namespace prefix, whatever that prefix happens to be.
    const prefixes = new Set(lLenCalls.map((k) => k.slice(0, k.indexOf(":"))));
    expect(prefixes).toEqual(new Set([""]));
  });
});
