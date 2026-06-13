// P0-2 — Adjudicator-bridge audit read paths against a REAL audit-postgres
// schema (claustrum/audit-read-paths.ts).
//
// Why a postgres testcontainer, not a mock: the properties under test only
// exist on a live migrated schema — the intent_audit CHECK constraints
// (record_version, hex intent_hash, refusal pair), RANGE-partition routing by
// recorded_at, the UNIQUE (intent_hash, recorded_at) arbiter the seed INSERT
// relies on, JSONB round-tripping through the package's `rowToRecord`, and the
// keyset-paged prefix stream. A mocked reader would only pin SQL strings.
//
// Migrations are applied with the SAME runner `ibx db provision` uses
// (packages/cli/src/lib/kernel-migrate.ts — apply-once + monthly intent_audit
// partitions). It is loaded via a computed dynamic import because apps/api's
// tsconfig has `rootDir: src` — a static cross-package source import would
// trip TS6059 in the build/lint `tsc` pass; vitest's module runner resolves
// and transforms the TS source fine at runtime.
//
// Seeding goes through the production WRITE path (`createPostgresSink` +
// INSERT_AUDIT_SQL/auditInsertParams), so the read paths are exercised against
// rows shaped exactly as the live audit sink writes them.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  AUDIT_RECORD_VERSION,
  buildEnvelope,
  decisionExecute,
  type AuditRecord,
  type AuditSink,
  type IntentActor,
  type Taint,
} from "@adjudicate/core";
import {
  INSERT_AUDIT_SQL,
  INSERT_OUTCOME_SQL,
  auditInsertParams,
  createPostgresSink,
} from "@adjudicate/audit-postgres";
import {
  createAuditReadPaths,
  postgresReaderFromPool,
  type AuditReadPaths,
} from "../claustrum/audit-read-paths.js";
import { buildAdjudicator } from "../claustrum-bootstrap.js";

// Mirror the h3 postgres-container convention: local-only opt-out, CI runs real.
const SKIP_REAL_POSTGRES = process.env["IBX_SKIP_REAL_POSTGRES"] === "1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

// ── Migration-runner facade (dynamic import — see module header) ────────────

interface PgClientLike {
  query(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

interface KernelMigrateLib {
  resolveAuditMigrationsDir(root: string, override?: string): string;
  runAuditMigrations(
    client: PgClientLike,
    opts: {
      migrationsDir: string;
      now: Date;
      partitionsBack?: number;
      partitionsForward?: number;
      log?: (msg: string) => void;
    },
  ): Promise<{
    applied: string[];
    skipped: string[];
    partitionsEnsured: string[];
  }>;
}

async function loadKernelMigrateLib(): Promise<KernelMigrateLib> {
  const modulePath = path.join(
    REPO_ROOT,
    "packages/cli/src/lib/kernel-migrate.ts",
  );
  return (await import(modulePath)) as KernelMigrateLib;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

const NOW_MS = Date.now();
const isoAgo = (ms: number): string => new Date(NOW_MS - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function seedRecord(args: {
  kind: string;
  actor: IntentActor;
  taint: Taint;
  payload: Record<string, unknown>;
  at: string;
  nonce: string;
}): AuditRecord {
  const envelope = buildEnvelope({
    kind: args.kind,
    payload: args.payload,
    actor: args.actor,
    taint: args.taint,
    nonce: args.nonce,
    createdAt: args.at,
  });
  // Vocabulary-controlled basis code (BASIS_CODES.business.RULE_SATISFIED).
  const decision = decisionExecute([
    { category: "business", code: "rule_satisfied" },
  ]);
  return {
    version: AUDIT_RECORD_VERSION,
    intentHash: envelope.intentHash,
    envelope,
    decision,
    decision_basis: decision.basis,
    at: args.at,
    durationMs: 1,
  };
}

// Gateway convention: user-principal envelopes carry actor.sessionId = customerId.
const alphaUser = seedRecord({
  kind: "order.cancel",
  actor: { principal: "user", sessionId: "cus_alpha" },
  taint: "UNTRUSTED",
  payload: { orderId: "ord_1" },
  at: isoAgo(1 * HOUR),
  nonce: "p0-2-alpha-user",
});
// Planner convention: llm-principal envelopes carry the conversation handle in
// actor.sessionId; the customer is named by the payload.
const alphaLlm = seedRecord({
  kind: "order.checkout.create",
  actor: { principal: "llm", sessionId: "web:sess-123" },
  taint: "UNTRUSTED",
  payload: { customerId: "cus_alpha", orderId: "ord_2" },
  at: isoAgo(2 * HOUR),
  nonce: "p0-2-alpha-llm",
});
// Older row for the `since` filter (kept inside the partition window).
const alphaOld = seedRecord({
  kind: "order.note.add",
  actor: { principal: "user", sessionId: "cus_alpha" },
  taint: "UNTRUSTED",
  payload: { orderId: "ord_0", note: "antiga" },
  at: isoAgo(7 * 24 * HOUR),
  nonce: "p0-2-alpha-old",
});
const betaUser = seedRecord({
  kind: "reservation.cancel",
  actor: { principal: "user", sessionId: "cus_beta" },
  taint: "UNTRUSTED",
  payload: { reservationId: "res_9" },
  at: isoAgo(90 * MINUTE),
  nonce: "p0-2-beta-user",
});

async function collect(
  iterable: AsyncIterable<AuditRecord>,
): Promise<AuditRecord[]> {
  const out: AuditRecord[] = [];
  for await (const record of iterable) out.push(record);
  return out;
}

const noopSink: AuditSink = {
  async emit() {
    /* read-path test — writes are seeded directly */
  },
};

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP_REAL_POSTGRES)(
  "audit read paths (postgres testcontainer)",
  () => {
    let container: StartedTestContainer;
    let pool: pg.Pool;
    let readPaths: AuditReadPaths;

    beforeAll(async () => {
      container = await new GenericContainer("postgres:15-alpine")
        .withExposedPorts(5432)
        .withEnvironment({
          POSTGRES_USER: "ibx_test",
          POSTGRES_PASSWORD: "ibx_test",
          POSTGRES_DB: "ibx_audit_test",
        })
        // initdb restarts postgres once; the port being open is not enough.
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/, 2),
        )
        .withStartupTimeout(120_000)
        .start();

      const url =
        `postgresql://ibx_test:ibx_test@${container.getHost()}:` +
        `${container.getMappedPort(5432)}/ibx_audit_test`;

      // Apply the audit-postgres migrations + intent_audit partitions with the
      // CLI's runner, on a single pg.Client (the runner wraps each file in
      // BEGIN/COMMIT — a Pool would spread the transaction across connections).
      const { resolveAuditMigrationsDir, runAuditMigrations } =
        await loadKernelMigrateLib();
      const migrationClient = new pg.Client({ connectionString: url });
      await migrationClient.connect();
      try {
        await runAuditMigrations(migrationClient, {
          migrationsDir: resolveAuditMigrationsDir(REPO_ROOT),
          now: new Date(NOW_MS),
          partitionsBack: 2, // alphaOld sits 7 days back — cover month edges
        });
      } finally {
        await migrationClient.end();
      }

      pool = new pg.Pool({ connectionString: url, max: 4 });
      readPaths = createAuditReadPaths({
        reader: postgresReaderFromPool(pool),
      });
    }, 240_000);

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
      await container?.stop({ remove: true, timeout: 10_000 }).catch(() => undefined);
    }, 60_000);

    // Declared first: runs against the migrated-but-empty schema.
    describe("empty DB", () => {
      it("replayEnvelopesByCustomerId returns empty, no throw", async () => {
        await expect(
          readPaths.replayEnvelopesByCustomerId("cus_alpha"),
        ).resolves.toEqual([]);
      });

      it("streamAuditByIntentHashPrefix yields nothing, no throw", async () => {
        await expect(
          collect(readPaths.streamAuditByIntentHashPrefix("ab")),
        ).resolves.toEqual([]);
      });

      it("getOutcomes returns empty, no throw", async () => {
        await expect(readPaths.getOutcomes({})).resolves.toEqual([]);
      });
    });

    describe("seeded", () => {
      beforeAll(async () => {
        // Production write path: same sink + INSERT the live audit sink uses.
        const sink = createPostgresSink({
          writer: {
            insertAudit: async (row) => {
              await pool.query(INSERT_AUDIT_SQL, [...auditInsertParams(row)]);
            },
          },
        });
        for (const record of [alphaUser, alphaLlm, alphaOld, betaUser]) {
          await sink.emit(record);
        }
        await pool.query(INSERT_OUTCOME_SQL, [
          alphaUser.intentHash,
          "succeeded",
          isoAgo(30 * MINUTE),
          "pedido cancelado",
        ]);
        await pool.query(INSERT_OUTCOME_SQL, [
          betaUser.intentHash,
          "failed",
          isoAgo(20 * MINUTE),
          null,
        ]);
      }, 30_000);

      it("replays a customer's records (session_id AND payload.customerId), newest-first", async () => {
        const records = await readPaths.replayEnvelopesByCustomerId("cus_alpha");
        expect(records.map((r) => r.intentHash)).toEqual([
          alphaUser.intentHash, // -1h
          alphaLlm.intentHash, // -2h (matched via payload.customerId)
          alphaOld.intentHash, // -7d
        ]);
        // Full round-trip through rowToRecord, not just hashes.
        expect(records[0]!.envelope.kind).toBe("order.cancel");
        expect(records[0]!.envelope.actor.sessionId).toBe("cus_alpha");
        expect(records[1]!.envelope.payload).toEqual({
          customerId: "cus_alpha",
          orderId: "ord_2",
        });
        expect(records[0]!.decision.kind).toBe("EXECUTE");
      });

      it("does not leak another customer's records", async () => {
        const records = await readPaths.replayEnvelopesByCustomerId("cus_beta");
        expect(records.map((r) => r.intentHash)).toEqual([betaUser.intentHash]);
        await expect(
          readPaths.replayEnvelopesByCustomerId("cus_nobody"),
        ).resolves.toEqual([]);
        await expect(
          readPaths.replayEnvelopesByCustomerId("  "),
        ).resolves.toEqual([]);
      });

      it("honors the `since` lower bound", async () => {
        const records = await readPaths.replayEnvelopesByCustomerId(
          "cus_alpha",
          new Date(NOW_MS - 24 * HOUR),
        );
        expect(records.map((r) => r.intentHash)).toEqual([
          alphaUser.intentHash,
          alphaLlm.intentHash,
        ]);
      });

      it("tenant scope: home tenant passes, foreign tenant gets nothing", async () => {
        const home = await readPaths.replayEnvelopesByCustomerId(
          "cus_alpha",
          undefined,
          "ibatexas",
        );
        expect(home).toHaveLength(3);
        await expect(
          readPaths.replayEnvelopesByCustomerId("cus_alpha", undefined, "acme"),
        ).resolves.toEqual([]);
      });

      it("streams records by intent-hash prefix", async () => {
        const prefix = alphaUser.intentHash.slice(0, 16);
        const records = await collect(
          readPaths.streamAuditByIntentHashPrefix(prefix),
        );
        expect(records.map((r) => r.intentHash)).toEqual([alphaUser.intentHash]);
        expect(records[0]!.envelope.actor.sessionId).toBe("cus_alpha");

        // Empty prefix = stream everything (paged).
        const all = await collect(readPaths.streamAuditByIntentHashPrefix(""));
        expect(new Set(all.map((r) => r.intentHash))).toEqual(
          new Set([
            alphaUser.intentHash,
            alphaLlm.intentHash,
            alphaOld.intentHash,
            betaUser.intentHash,
          ]),
        );
      });

      it("rejects non-hex prefixes (LIKE metacharacters) with an empty stream", async () => {
        await expect(
          collect(readPaths.streamAuditByIntentHashPrefix("%")),
        ).resolves.toEqual([]);
        await expect(
          collect(readPaths.streamAuditByIntentHashPrefix("zz")),
        ).resolves.toEqual([]);
        await expect(
          collect(readPaths.streamAuditByIntentHashPrefix("ab", "acme")),
        ).resolves.toEqual([]);
      });

      it("getOutcomes: unfiltered, newest-first, note presence-exact", async () => {
        const rows = await readPaths.getOutcomes({});
        expect(rows.map((r) => r.intentHash)).toEqual([
          betaUser.intentHash, // -20min
          alphaUser.intentHash, // -30min
        ]);
        expect(rows[0]!.observed).toBe("failed");
        expect(rows[0]!).not.toHaveProperty("note");
        expect(rows[1]!).toMatchObject({
          observed: "succeeded",
          note: "pedido cancelado",
        });
      });

      it("getOutcomes: observed / customerId / intentKind / window filters", async () => {
        const succeeded = await readPaths.getOutcomes({ observed: "succeeded" });
        expect(succeeded.map((r) => r.intentHash)).toEqual([alphaUser.intentHash]);

        const byCustomer = await readPaths.getOutcomes({ customerId: "cus_alpha" });
        expect(byCustomer.map((r) => r.intentHash)).toEqual([alphaUser.intentHash]);

        const byKind = await readPaths.getOutcomes({
          intentKind: "reservation.cancel",
        });
        expect(byKind.map((r) => r.intentHash)).toEqual([betaUser.intentHash]);

        const recent = await readPaths.getOutcomes({ since: isoAgo(25 * MINUTE) });
        expect(recent.map((r) => r.intentHash)).toEqual([betaUser.intentHash]);

        const older = await readPaths.getOutcomes({ until: isoAgo(25 * MINUTE) });
        expect(older.map((r) => r.intentHash)).toEqual([alphaUser.intentHash]);

        await expect(
          readPaths.getOutcomes({ tenantId: "acme" }),
        ).resolves.toEqual([]);
      });

      it("buildAdjudicator delegates the three read methods to the injected reader", async () => {
        const bridge = buildAdjudicator({ sink: noopSink, auditReads: readPaths });

        const replayed = await bridge.replayEnvelopesByCustomerId("cus_alpha");
        expect(replayed).toHaveLength(3);

        const streamed = await collect(
          bridge.streamAuditByIntentHashPrefix(betaUser.intentHash.slice(0, 16)),
        );
        expect(streamed.map((r) => r.intentHash)).toEqual([betaUser.intentHash]);

        const outcomes = await bridge.getOutcomes({ observed: "failed" });
        expect(outcomes.map((r) => r.intentHash)).toEqual([betaUser.intentHash]);
      });

      it("buildAdjudicator without auditReads stays empty-safe (no throw)", async () => {
        const bare = buildAdjudicator({ sink: noopSink });
        await expect(bare.replayEnvelopesByCustomerId("cus_alpha")).resolves.toEqual([]);
        await expect(
          collect(bare.streamAuditByIntentHashPrefix("ab")),
        ).resolves.toEqual([]);
        await expect(bare.getOutcomes({})).resolves.toEqual([]);
      });
    });
  },
);

// Reader-independent fail-safe contract (no container needed): a throwing
// reader degrades every method to an empty result + onError report — recall
// reads must never crash a turn.
describe("audit read paths — fail-safe on reader failure", () => {
  it("returns empty results and reports via onError", async () => {
    const onError = vi.fn();
    const broken = createAuditReadPaths({
      reader: {
        async query() {
          throw new Error("boom");
        },
      },
      onError,
    });

    await expect(broken.replayEnvelopesByCustomerId("cus_x")).resolves.toEqual([]);
    await expect(
      collect(broken.streamAuditByIntentHashPrefix("ab")),
    ).resolves.toEqual([]);
    await expect(broken.getOutcomes({})).resolves.toEqual([]);

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls.map((c) => c[1]).sort()).toEqual([
      "getOutcomes",
      "replayEnvelopesByCustomerId",
      "streamAuditByIntentHashPrefix",
    ]);
  });
});
