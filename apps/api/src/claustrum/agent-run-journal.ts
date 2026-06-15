// agent_runs journal (P1 D-journal).
//
// Every managed-agent trigger turn is journaled here: what woke the agent, what
// it decided, the intent kind it proposed, and how many model calls it made.
// Two consumers:
//   - operators reviewing agent run history (the console /agents surface);
//   - the P4 adjutant, which projects incidents/proposals from these rows.
//
// This module is the SEAM + a structured-log/in-memory default. The durable
// Postgres `agent_runs` table (createPostgresAgentRunJournal) is the source of
// truth across restarts; the in-memory ring is the test/no-DB fallback. The
// runner stays agnostic to where records persist.

import { logger } from "../lib/logger.js";

/** One journaled agent turn (P1 single live path — no autonomy stage, no sandbox). */
export interface AgentRunRecord {
  /** Agent id (`pix-payment-failure-remediation`). */
  readonly agentId: string;
  readonly agentVersion: string;
  /** `agent:<id>@<ver>:entity:<entityId>` — the unhashed audit namespace. */
  readonly sessionId: string;
  /** `${entityKind}:${entityId}` the trigger was about. */
  readonly entity: string;
  /** `${sourceSubject}:${eventId}` deterministic carrier (upsert key with agentId). */
  readonly externalId: string;
  /** Kernel decision kind for the turn (EXECUTE, REFUSE, REQUEST_CONFIRMATION, …). */
  readonly decisionKind: string;
  /** Derived from the planned envelope(s); "" when the turn proposed none. */
  readonly intentKind: string;
  /** Model calls the turn actually made (≤ the per-trigger cap, H1). */
  readonly modelCalls: number;
  /** ISO time the turn completed (passed in — never read the clock here). */
  readonly at: string;
}

export interface AgentRunJournal {
  record(run: AgentRunRecord): void | Promise<void>;
}

/**
 * Default journal: structured log + bounded in-memory ring (for tests and the
 * no-DB fallback). The durable backing (createPostgresAgentRunJournal) is the
 * source of truth; this ring never grows unbounded.
 */
export function createLoggingAgentRunJournal(ringSize = 256): AgentRunJournal & {
  recent(): ReadonlyArray<AgentRunRecord>;
} {
  const ring: AgentRunRecord[] = [];
  return {
    record(run) {
      ring.push(run);
      if (ring.length > ringSize) ring.shift();
      logger.info(
        {
          component: "agent-runs",
          agentId: run.agentId,
          agentVersion: run.agentVersion,
          sessionId: run.sessionId,
          entity: run.entity,
          externalId: run.externalId,
          decision: run.decisionKind,
          intentKind: run.intentKind,
          modelCalls: run.modelCalls,
        },
        "agent run journaled",
      );
    },
    recent() {
      return [...ring];
    },
  };
}

// ── Durable Postgres journal (the P4 projection source of truth) ─────────────

/**
 * Minimal structural slice of the domain PrismaClient the journal needs: an
 * `agentRun.upsert` keyed on the compound `@@unique([agentId, externalId])`.
 * The real `prisma` from `@ibatexas/domain` satisfies this; tests inject a fake.
 */
export interface AgentRunPrisma {
  agentRun: {
    upsert(args: {
      where: { agentId_externalId: { agentId: string; externalId: string } };
      create: {
        agentId: string;
        agentVersion: string;
        sessionId: string;
        entity: string;
        externalId: string;
        decisionKind: string;
        intentKind: string;
        modelCalls: number;
        at: string | Date;
      };
      update: {
        agentVersion: string;
        sessionId: string;
        entity: string;
        decisionKind: string;
        intentKind: string;
        modelCalls: number;
        at: string | Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * Durable journal backed by the `agent_runs` Postgres table. Upserts on
 * `(agentId, externalId)` so a BullMQ retry that re-runs the SAME trigger
 * overwrites rather than duplicates. Fail-OPEN: a journal write failure logs
 * and is swallowed — journaling must never break a turn or the dispatch path.
 */
export function createPostgresAgentRunJournal(prisma: AgentRunPrisma): AgentRunJournal {
  return {
    async record(run) {
      try {
        await prisma.agentRun.upsert({
          where: {
            agentId_externalId: { agentId: run.agentId, externalId: run.externalId },
          },
          create: {
            agentId: run.agentId,
            agentVersion: run.agentVersion,
            sessionId: run.sessionId,
            entity: run.entity,
            externalId: run.externalId,
            decisionKind: run.decisionKind,
            intentKind: run.intentKind,
            modelCalls: run.modelCalls,
            at: run.at,
          },
          update: {
            agentVersion: run.agentVersion,
            sessionId: run.sessionId,
            entity: run.entity,
            decisionKind: run.decisionKind,
            intentKind: run.intentKind,
            modelCalls: run.modelCalls,
            at: run.at,
          },
        });
      } catch (err) {
        logger.error(
          {
            component: "agent-runs",
            agentId: run.agentId,
            externalId: run.externalId,
            err: (err as Error).message,
          },
          "agent_runs journal write failed (swallowed — turn unaffected)",
        );
      }
    },
  };
}
