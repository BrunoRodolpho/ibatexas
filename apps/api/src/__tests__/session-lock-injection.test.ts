// P0-9 — PostgresAdvisorySessionLock injection (RC-R3 / Decision 1).
//
// Why a postgres testcontainer, not a mock: the property under test is
// CROSS-PROCESS mutual exclusion — `pg_try_advisory_lock` ownership lives in
// the Postgres backend, keyed per connection. Two lock instances over two
// SEPARATE pg.Pools model two api replicas; a mocked pool would only prove the
// SQL string, not that the second replica's acquire actually blocks until the
// first releases. The lock key uses the conductor's shape
// (`${channel}:${customerId}`, see @claustrum/core ports/session-lock).
//
// The bootstrap wiring itself (sessionLock passed to createConductor) is
// pinned by a source-level assertion — constructing the full conductor needs
// live Anthropic/Redis/NATS deps, which is out of scope for this suite.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { PostgresAdvisorySessionLock } from "@claustrum/memory-postgres";

// Mirror the h3 postgres-container convention: local-only opt-out, CI runs real.
const SKIP_REAL_POSTGRES = process.env["IBX_SKIP_REAL_POSTGRES"] === "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Cross-pool serialization (two replicas, one session) ────────────────────

describe.skipIf(SKIP_REAL_POSTGRES)(
  "PostgresAdvisorySessionLock (postgres testcontainer)",
  () => {
    let container: StartedTestContainer;
    // Two SEPARATE pools = two api processes. Connection pinning is the
    // load-bearing property, so the pools must not share backends.
    let poolA: pg.Pool;
    let poolB: pg.Pool;
    let lockA: PostgresAdvisorySessionLock;
    let lockB: PostgresAdvisorySessionLock;

    beforeAll(async () => {
      container = await new GenericContainer("postgres:15-alpine")
        .withExposedPorts(5432)
        .withEnvironment({
          POSTGRES_USER: "ibx_test",
          POSTGRES_PASSWORD: "ibx_test",
          POSTGRES_DB: "ibx_lock_test",
        })
        // initdb restarts postgres once; the port being open is not enough.
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/, 2),
        )
        .withStartupTimeout(120_000)
        .start();

      const url =
        `postgresql://ibx_test:ibx_test@${container.getHost()}:` +
        `${container.getMappedPort(5432)}/ibx_lock_test`;

      // Advisory locks need no schema — a fresh DB is enough.
      poolA = new pg.Pool({ connectionString: url, max: 2 });
      poolB = new pg.Pool({ connectionString: url, max: 2 });
      lockA = new PostgresAdvisorySessionLock(poolA);
      lockB = new PostgresAdvisorySessionLock(poolB);
    }, 240_000);

    afterAll(async () => {
      await poolA?.end().catch(() => undefined);
      await poolB?.end().catch(() => undefined);
      await container
        ?.stop({ remove: true, timeout: 10_000 })
        .catch(() => undefined);
    }, 60_000);

    it(
      "second acquire on the same session key waits until the first releases",
      async () => {
        const key = "whatsapp:cust_p09"; // conductor key shape `${channel}:${customerId}`
        const events: string[] = [];

        const handleA = await lockA.acquire(key, { timeoutMs: 5_000 });
        expect(handleA).not.toBeNull();

        // Replica B contends on the same key over its OWN pool. Must poll, not
        // resolve, while A holds.
        const pendingB = lockB.acquire(key, { timeoutMs: 15_000 }).then((h) => {
          events.push("b:acquired");
          return h;
        });

        // Several poll intervals (50ms each) — B must still be blocked.
        await sleep(400);
        expect(events).toEqual([]);

        events.push("a:released");
        await handleA!.release();

        const handleB = await pendingB;
        expect(handleB).not.toBeNull();
        // Strict ordering: release-before-acquire, i.e. turns serialized.
        expect(events).toEqual(["a:released", "b:acquired"]);
        await handleB!.release();
      },
      30_000,
    );

    it(
      "contended acquire fails CLOSED (null) on timeout; key reusable after release",
      async () => {
        const key = "web:cust_timeout";

        const handleA = await lockA.acquire(key, { timeoutMs: 5_000 });
        expect(handleA).not.toBeNull();

        // The conductor fails the turn closed on null rather than running
        // unserialized — pin the null contract.
        const denied = await lockB.acquire(key, { timeoutMs: 250 });
        expect(denied).toBeNull();

        await handleA!.release();
        const handleB = await lockB.acquire(key, { timeoutMs: 5_000 });
        expect(handleB).not.toBeNull();
        await handleB!.release();
      },
      30_000,
    );

    it(
      "different session keys do not contend",
      async () => {
        const handleA = await lockA.acquire("web:cust_a", { timeoutMs: 5_000 });
        const handleB = await lockB.acquire("web:cust_b", { timeoutMs: 1_000 });
        expect(handleA).not.toBeNull();
        expect(handleB).not.toBeNull();
        await handleA!.release();
        await handleB!.release();
      },
      30_000,
    );
  },
);

// ── Bootstrap wiring (static, runs even when containers are skipped) ────────

describe("claustrum-bootstrap injects the distributed session lock", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../claustrum-bootstrap.ts"),
    "utf8",
  );

  it("imports PostgresAdvisorySessionLock from @claustrum/memory-postgres", () => {
    expect(source).toMatch(
      /PostgresAdvisorySessionLock[\s\S]{0,200}from "@claustrum\/memory-postgres"/,
    );
  });

  it("passes sessionLock over pgPool in the createConductor options", () => {
    // The only `createConductor({` in the file is the composition-root call.
    const callIndex = source.indexOf("createConductor({");
    expect(callIndex).toBeGreaterThan(-1);
    expect(source.slice(callIndex)).toContain(
      "sessionLock: new PostgresAdvisorySessionLock(pgPool)",
    );
  });
});
