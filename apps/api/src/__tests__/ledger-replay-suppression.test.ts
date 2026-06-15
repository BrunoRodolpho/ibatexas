/**
 * P0-1 — execution-Ledger wiring (Hard Rule #9): cross-turn replay
 * suppression through the adjudicator bridge, against a REAL Redis
 * (testcontainer — RULE 3: the dedup semantics live in Redis's server-side
 * SET NX, which a Map-stub cannot emulate faithfully).
 *
 * Two invariants:
 *   1. Replay suppression — the same envelope (same intentHash) adjudicated
 *      twice EXECUTEs once; the second pass REFUSEs with the kernel's
 *      `ledger_replay_suppressed` refusal + `ledger:replay_suppressed`
 *      basis, and BOTH attempts emit an AuditRecord.
 *   2. Fail-closed — a Redis that rejects (unreachable) surfaces as REFUSE,
 *      never as a dedup bypass: the ledger throw propagates uncaught through
 *      `adjudicateAndAudit` into the bridge's fail-closed catch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuditRecord, AuditSink } from "@adjudicate/core";
import { buildEnvelope } from "@adjudicate/core";
import { createRedisLedger, type RedisLedgerClient } from "@adjudicate/audit";
import { buildAdjudicator } from "../claustrum-bootstrap.js";
import {
  RUN_REAL_REDIS,
  setupRedisTestContainer,
  type RedisTestHarness,
} from "./helpers/redis-testcontainer.js";

// ── Fixtures (mirrors claustrum-bridge-audit.test.ts) ───────────────────────

function capturingSink(): AuditSink & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
    async emit(record: AuditRecord) {
      records.push(record);
    },
  };
}

// Minimal well-formed PolicyBundle: no guards, taint floor UNTRUSTED, default
// EXECUTE — a clean envelope adjudicates to EXECUTE, exercising the ledger's
// recordExecution (claim) and checkLedger (replay) paths.
function executeAllPolicy(): unknown {
  return {
    stateGuards: [],
    authGuards: [],
    business: [],
    taint: { minimumFor: () => "UNTRUSTED" as const },
    default: "EXECUTE" as const,
  };
}

// Deterministic nonce/createdAt → repeated calls share one intentHash, so the
// second adjudication is byte-for-byte the replay the ledger must suppress.
function probeEnvelope(nonce = "n-p0-1-replay") {
  return buildEnvelope({
    kind: "test.ledger.probe",
    payload: { hello: "world" },
    actor: { principal: "user", sessionId: "web:cust-1" },
    taint: "UNTRUSTED",
    nonce,
    createdAt: "2026-06-11T12:00:00.000Z",
  });
}

// node-redis's generic reply type is `string | Buffer | null`; this client is
// never put in buffer mode, so narrow to the contract the ledger consumes
// (same shape production wires in claustrum-bootstrap.ts).
function asLedgerClient(client: RedisTestHarness["client"]): RedisLedgerClient {
  return {
    set: (key, value, options) =>
      client.set(key, value, {
        ...(options?.NX ? { NX: true as const } : {}),
        ...(options?.EX !== undefined ? { EX: options.EX } : {}),
      }) as Promise<string | null>,
    get: (key) => client.get(key) as Promise<string | null>,
    del: (key) => client.del(key),
  };
}

const keyFor = (suffix: string): string => `p0-1-ledger-test:${suffix}`;

describe.skipIf(!RUN_REAL_REDIS)(
  "P0-1 — execution ledger replay suppression (real Redis)",
  () => {
    let harness: RedisTestHarness;

    beforeAll(async () => {
      harness = await setupRedisTestContainer();
    }, 120_000);

    afterAll(async () => {
      await harness?.teardown();
    });

    beforeEach(async () => {
      // Dedicated container per file — a full flush is the cheapest isolation.
      await harness.client.flushAll();
    });

    it("EXECUTEs first, REFUSEs the replay with the replay_suppressed basis", async () => {
      const sink = capturingSink();
      const ledger = createRedisLedger({
        client: asLedgerClient(harness.client),
        keyFor,
      });
      const bridge = buildAdjudicator({ sink, ledger });

      const first = await bridge.adjudicate(
        probeEnvelope(),
        { channel: "web" } as never,
        executeAllPolicy() as never,
      );
      expect(first.kind).toBe("EXECUTE");

      const second = await bridge.adjudicate(
        probeEnvelope(), // same nonce/createdAt → same intentHash → replay
        { channel: "web" } as never,
        executeAllPolicy() as never,
      );
      expect(second.kind).toBe("REFUSE");
      expect(
        (second as { refusal: { code: string } }).refusal.code,
      ).toBe("ledger_replay_suppressed");
      // The kernel tags the suppression with the controlled-vocabulary basis
      // (BASIS_CODES.ledger.REPLAY_SUPPRESSED).
      expect(second.basis).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "ledger",
            code: "replay_suppressed",
          }),
        ]),
      );
      // Audit-completeness holds across suppression: both attempts recorded.
      expect(sink.records).toHaveLength(2);
    });
  },
);

describe("P0-1 — execution ledger fails CLOSED on Redis loss", () => {
  // No container here on purpose: an injected client whose methods reject is
  // the deterministic stand-in for a stopped/unreachable Redis.

  it("a rejecting checkLedger (Redis down before the kernel runs) → REFUSE", async () => {
    const sink = capturingSink();
    const deadClient: RedisLedgerClient = {
      async get() {
        throw new Error("redis unreachable");
      },
      async set() {
        throw new Error("redis unreachable");
      },
    };
    const bridge = buildAdjudicator({
      sink,
      ledger: createRedisLedger({ client: deadClient, keyFor }),
    });

    const decision = await bridge.adjudicate(
      probeEnvelope("n-p0-1-dead-check"),
      { channel: "web" } as never,
      executeAllPolicy() as never,
    );

    // Redis loss is a refusal, never a dedup bypass.
    expect(decision.kind).toBe("REFUSE");
    // The throw happened before the kernel decided/audited — nothing emitted.
    expect(sink.records).toHaveLength(0);
  });

  it("a rejecting recordExecution (claim fails AFTER an EXECUTE) → REFUSE", async () => {
    // The most dangerous bypass shape: checkLedger misses, the kernel decides
    // EXECUTE, then the SET-NX claim rejects. The decided EXECUTE must not
    // surface when the dedup claim could not be recorded.
    const sink = capturingSink();
    const claimRejectingClient: RedisLedgerClient = {
      async get() {
        return null; // miss — lets the kernel reach the EXECUTE claim
      },
      async set() {
        throw new Error("redis unreachable");
      },
    };
    const bridge = buildAdjudicator({
      sink,
      ledger: createRedisLedger({ client: claimRejectingClient, keyFor }),
    });

    const decision = await bridge.adjudicate(
      probeEnvelope("n-p0-1-dead-claim"),
      { channel: "web" } as never,
      executeAllPolicy() as never,
    );

    expect(decision.kind).toBe("REFUSE");
    expect(sink.records).toHaveLength(0);
  });
});
