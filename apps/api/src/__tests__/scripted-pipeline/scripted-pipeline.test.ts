// T2-6b acceptance — golden conversations through the REAL bootstrapClaustrum
// at ZERO Anthropic tokens (PR CI; rides root `pnpm test` like every vitest
// suite, with Docker testcontainers — the same CI substrate the T4/R2-2/T6
// conformance suites already use).
//
// Composition under test = the PRODUCTION one (T2-6a DI seams):
//   bootstrapClaustrum({ modelProvider: <content-keyed scripted provider> })
// Everything else is the real wiring — production planner
// (createIbatexasPlanner) + capability-planner union, resolve stage
// (resolveAndAssemble: NL→id auto-resolve against a REAL seeded domain DB),
// per-kind policy router with the adopter business guards, audited
// adjudicator bridge over the REAL composed audit sink (redactor → buffered
// fan-out → Postgres writer; the NATS arm degrades fail-open against a
// black-holed NATS_URL), Redis execution ledger + session store, pgvector
// grounding (fail-safe: the scripted provider IMPLEMENTS embed per D-009, the
// claustrum schema is deliberately absent → empty retrieval), fail-safe
// memory (D-012).
//
// Zero tokens BY CONSTRUCTION: when `options.modelProvider` is injected the
// Anthropic SDK client is never constructed (claustrum-bootstrap.ts), so no
// code path in this suite can spend a token. The scripted provider resolves
// requests by CONTENT (canonicalized {system, messages, tools} digest) — a
// planner-prompt or tool-surface change makes the runtime request miss the
// fixture table and fail LOUDLY (see content-key.test.ts for the unit-level
// acceptance of that property).
//
// Infra: claustrum-bootstrap-harness (postgres:15-alpine with the kernel
// audit migrations + redis:7) EXTENDED with the @ibatexas/domain Prisma
// schema (`prisma db push --skip-generate` against the throwaway container)
// so the cancel leg's auto-resolve reads a REAL order projection. The seeded
// order id is generated per run and bound to the fixtures' {{ORDER_ID}}
// template at load — no raw Medusa ids in committed fixtures (ULIDs are
// seed-nondeterministic; plan v2 ledger #15).

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { handleTurn, type Conductor } from "@claustrum/core";
import { prisma } from "@ibatexas/domain";
import { closeRedisClient } from "@ibatexas/tools";
import {
  bootstrapClaustrum,
  resetClaustrumForTests,
} from "../../claustrum-bootstrap.js";
import {
  RUN_BOOTSTRAP_HARNESS,
  setupClaustrumBootstrapHarness,
  type ClaustrumBootstrapTestHarness,
} from "../helpers/claustrum-bootstrap-harness.js";
import {
  createScriptedModelProvider,
  type ScriptedModelProvider,
} from "../helpers/scripted-model-provider.js";
import {
  loadGoldenFixtures,
  loadScriptedEntries,
  type GoldenConversationFixture,
} from "./fixture-format.js";
import {
  cc006ConversationId,
  cc006CustomerId,
  createGoldenConversationCheck,
  type ConformanceResult,
} from "./golden-conversation-check.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripted-pipeline → __tests__ → src → api → apps → repo root
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const FIXTURES_DIR = path.join(__dirname, "fixtures", "conversations");
const COMPLETIONS_DIR = path.join(__dirname, "fixtures", "completions");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Mirror of the audit redactor's session hashing (D-012): the run's chat-act
 * audit namespace is the HASHED conversationId, never the raw one. */
function hashedSessionId(conversationId: string): string {
  const h = createHash("sha256");
  h.update(conversationId);
  h.update(process.env.AUDIT_REDACT_SECRET ?? "");
  return `hashed:${h.digest("hex").slice(0, 8)}`;
}

interface AuditRow {
  readonly kind: string;
  readonly decision_kind: string;
  readonly refusal_code: string | null;
}

async function auditRowsFor(
  pool: pg.Pool,
  sessionId: string,
): Promise<AuditRow[]> {
  const res = await pool.query(
    `SELECT kind, decision_kind, refusal_code FROM intent_audit
     WHERE session_id = $1 ORDER BY recorded_at ASC`,
    [sessionId],
  );
  return res.rows as AuditRow[];
}

/** The composed sink buffers; poll until the expected count lands. */
async function waitForAuditRows(
  pool: pg.Pool,
  sessionId: string,
  count: number,
  timeoutMs = 15_000,
): Promise<AuditRow[]> {
  const deadline = Date.now() + timeoutMs;
  let rows: AuditRow[] = [];
  for (;;) {
    rows = await auditRowsFor(pool, sessionId);
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_BOOTSTRAP_HARNESS)(
  "scripted pipeline — golden conversations at zero tokens (T2-6b)",
  () => {
    let harness: ClaustrumBootstrapTestHarness;
    let conductor: Conductor;
    let provider: ScriptedModelProvider;
    let assertPool: pg.Pool;
    let fixtures: GoldenConversationFixture[];
    let checkResult: ConformanceResult;

    // Seeded per run; bound to {{ORDER_ID}} at fixture load.
    const ORDER_ID = `t26b-order-${randomUUID()}`;
    const CANCEL_CUSTOMER_ID = cc006CustomerId("cancel-confirm-gate");
    const substitutions = { ORDER_ID } as const;

    beforeAll(async () => {
      harness = await setupClaustrumBootstrapHarness({
        env: {
          // Black-hole NATS deterministically: the audit sink's NATS arm must
          // exercise its fail-open path against a connection refusal, never
          // accidentally publish into a developer's live dev-stack broker.
          NATS_URL: "nats://127.0.0.1:1",
        },
      });

      // Domain schema layer — the same `prisma db push` ibx bootstrap runs,
      // against the throwaway container. `--url` overrides the prisma.config.ts
      // datasource explicitly (Prisma 7 CLI; client generation is a separate
      // step in v7, so the committed generated client is never touched).
      await execFileAsync(
        "pnpm",
        [
          "--filter",
          "@ibatexas/domain",
          "exec",
          "prisma",
          "db",
          "push",
          "--url",
          harness.pgUrl,
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: harness.pgUrl },
          timeout: 240_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );

      // Seed the cancel leg's entity state: one customer with exactly one
      // order, so the NL→id auto-resolve is unambiguous. First property
      // access on the lazy @ibatexas/domain prisma proxy happens HERE —
      // after the harness pinned DATABASE_URL to the container.
      await prisma.customer.create({
        data: {
          id: CANCEL_CUSTOMER_ID,
          phone: "+5511999990001",
          name: "Cliente T2-6b",
          source: "web",
        },
      });
      await prisma.orderProjection.create({
        data: {
          id: ORDER_ID,
          displayId: 42620,
          customerId: CANCEL_CUSTOMER_ID,
          fulfillmentStatus: "pending",
          paymentStatus: "awaiting",
          totalInCentavos: 8900,
          subtotalInCentavos: 8900,
          itemCount: 1,
          medusaCreatedAt: new Date(),
        },
      });

      assertPool = new pg.Pool({ connectionString: harness.pgUrl, max: 2 });

      fixtures = await loadGoldenFixtures(FIXTURES_DIR, substitutions);
      provider = createScriptedModelProvider({
        entries: await loadScriptedEntries(COMPLETIONS_DIR, substitutions),
      });

      conductor = await bootstrapClaustrum({ modelProvider: provider });

      // Drive every fixture ONCE up front (the check is the canonical
      // driver); individual tests assert different facets of the same run.
      checkResult = await createGoldenConversationCheck({ substitutions }).run(
        conductor,
        { fixturesDir: FIXTURES_DIR },
      );
    }, 420_000);

    afterAll(async () => {
      await resetClaustrumForTests().catch(() => undefined);
      await assertPool?.end().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
      // Close the shared Redis singleton BEFORE the container stops so the
      // client does not reconnect-spin against a dead port.
      await closeRedisClient().catch(() => undefined);
      await harness?.teardown();
    }, 60_000);

    it("IBX-GC-006: all golden conversations reproduce envelope kinds, decisions and responder behavior", () => {
      if (!checkResult.passed) {
        throw new Error(checkResult.details);
      }
      expect(checkResult.passed).toBe(true);
      expect(checkResult.details).toMatch(/Verified 3 golden conversation/);
    });

    it("audit ledger: each adjudicated turn lands in intent_audit under its HASHED session namespace (D-012); the empty-plan turn audits nothing", async () => {
      for (const fixture of fixtures) {
        const expected = fixture.expectedAudit;
        if (expected === undefined) continue;
        const sessionId = hashedSessionId(cc006ConversationId(fixture.id));
        const rows = await waitForAuditRows(
          assertPool,
          sessionId,
          expected.rows,
          expected.rows === 0 ? 2_000 : 15_000,
        );
        expect(
          rows.length,
          `fixture ${fixture.id}: intent_audit rows for ${sessionId}`,
        ).toBe(expected.rows);
        for (const [i, rec] of (expected.records ?? []).entries()) {
          expect(rows[i]?.kind).toBe(rec.kind);
          expect(rows[i]?.decision_kind).toBe(rec.decision);
          if (rec.refusalCode !== undefined) {
            expect(rows[i]?.refusal_code).toBe(rec.refusalCode);
          }
        }
        // The namespace really is hashed scoping: nothing under the raw id.
        const raw = await auditRowsFor(
          assertPool,
          cc006ConversationId(fixture.id),
        );
        expect(raw.length).toBe(0);
      }
    }, 60_000);

    it("zero tokens by construction: every model call resolved a registered content key; no SDK, no unknowns", () => {
      // 3 conversations × 1 planner completion = 3, PLUS a responder completion
      // ONLY for the empty-plan/small-talk turn. The decision-aware responder
      // (Phase A) is MODEL-FREE on a real REFUSE (renders the explainer) and on
      // REQUEST_CONFIRMATION (returns decision.prompt), so cart-intent-refused
      // and cancel-confirm-gate make NO responder model call. Total: 3 + 1 = 4.
      const completes = provider.calls.filter((c) => c.method === "complete");
      expect(completes.length).toBe(4);
      // Content-keyed, never positional: every call resolved to a labeled
      // fixture (an unknown key would have thrown the turn).
      expect(completes.every((c) => c.label !== null)).toBe(true);
      expect(new Set(completes.map((c) => c.label)).size).toBe(4);
      // DEF-005: grounding is opt-in (CLAUSTRUM_GROUNDING_ENABLED) and runs as a
      // DESIGNED no-op by default, so the grounding port never calls embed in this
      // golden run — zero embed calls, not a swallowed throw. (With the flag on AND
      // a real embedder, the pgvector path would embed each perception; that path is
      // gated behind a boot capability probe — see provider-embed-capability.ts.)
      const embeds = provider.calls.filter((c) => c.method === "embed");
      expect(embeds.length).toBe(0);
      expect(provider.calls.filter((c) => c.method === "stream").length).toBe(0);
    });

    it("repeated turns resolve by CONTENT, not cursor: re-driving a conversation returns the identical scripted behavior", async () => {
      // The upstream InMemoryModelProvider failure mode (plan v2 ledger #13)
      // is a modulo cursor: a repeated call rotates the script. Re-drive the
      // smalltalk turn — same content key → same completion → same reply.
      const customerId = cc006CustomerId("smalltalk-noop");
      const conversationId = cc006ConversationId("smalltalk-noop");
      const inbound = {
        channel: "web" as const,
        customerId,
        conversationId,
        text: "Oi, tudo bem?",
        receivedAt: "2026-05-18T00:00:00.000Z",
      };
      const capsule = await conductor.openCapsule({
        channel: "web",
        customerId,
        inbound,
      });
      const result = await handleTurn(capsule, inbound);
      await conductor.closeCapsule(capsule);

      expect(result.plan.envelopes).toHaveLength(0);
      expect(result.decision.kind).toBe("REFUSE");
      expect(result.response.text).toBe(
        "Olá! Tudo ótimo por aqui. Como posso ajudar?",
      );
      // 4 from the IBX-GC-006 run above + 2 from this re-drive (small-talk calls
      // both planner and responder each turn; the model-free fixtures do not).
      const completes = provider.calls.filter((c) => c.method === "complete");
      expect(completes.length).toBe(6);
      expect(
        completes.filter((c) => c.label === "planner:smalltalk-noop").length,
      ).toBe(2);
      expect(
        completes.filter((c) => c.label === "responder:smalltalk-noop").length,
      ).toBe(2);
    }, 30_000);
  },
);
