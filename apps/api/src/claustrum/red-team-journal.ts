// agent_red_team_runs journal (ERDS-058).
//
// Every managed-agent red-team / adversarial test case is journaled here: which
// suite + case ran, what the kernel decided, the intent it proposed, how many
// model calls it made, and how many assertions passed. Two consumers:
//   - operators reviewing per-release red-team coverage (the console surface);
//   - the adjutant, which projects red-team gaps from these rows.
//
// This module is the SEAM + the durable Postgres backing
// (createPostgresRedTeamJournal). Per-release CI population is DEFERRED (it needs
// an ANTHROPIC_API_KEY to actually drive the model), so today this only lands the
// store + the journal + its unit test; the suite runner is a later phase.
//
// Mirrors agent-run-journal.ts exactly: an upsert-shaped seam (here a create,
// since each red-team run is a fresh row), fail-OPEN — a journal write failure
// logs and is swallowed so red-team journaling never breaks the suite.

import { logger } from "../lib/logger.js";

/** One journaled red-team test case execution. */
export interface AgentRedTeamRunRecord {
  /** Agent id under test (`pix-payment-failure-remediation`). */
  readonly agentId: string;
  /** Agent version under test; omitted when the suite doesn't pin one. */
  readonly agentVersion?: string;
  /** The red-team suite (e.g. `prompt-injection`). */
  readonly testSuite: string;
  /** The individual adversarial case within the suite. */
  readonly testCase: string;
  /** Kernel decision kind the case produced (EXECUTE, REFUSE, …). */
  readonly decisionKind: string;
  /** Intent kind the case proposed; omitted when the turn proposed none. */
  readonly intentKind?: string;
  /** Model calls the case made. */
  readonly modelCalls: number;
  /** Assertions that passed; omitted when the case records no tally. */
  readonly assertionsPassed?: number;
  /** ISO time the case completed (passed in — never read the clock here). */
  readonly at: string;
}

export interface AgentRedTeamJournal {
  record(run: AgentRedTeamRunRecord): void | Promise<void>;
}

/**
 * Minimal structural slice of the domain PrismaClient the journal needs: an
 * `agentRedTeamRun.create`. The real `prisma` from `@ibatexas/domain` satisfies
 * this; tests inject a fake.
 */
export interface AgentRedTeamPrisma {
  agentRedTeamRun: {
    create(args: {
      data: {
        agentId: string;
        agentVersion?: string | null;
        testSuite: string;
        testCase: string;
        decisionKind: string;
        intentKind?: string | null;
        modelCalls: number;
        assertionsPassed?: number | null;
        at: string | Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * Durable journal backed by the `agent_red_team_runs` Postgres table. Each call
 * inserts a fresh row (one per case execution). Fail-OPEN: a write failure logs
 * and is swallowed — red-team journaling must never break the suite.
 */
export function createPostgresRedTeamJournal(
  prisma: AgentRedTeamPrisma,
): AgentRedTeamJournal {
  return {
    async record(run) {
      try {
        await prisma.agentRedTeamRun.create({
          data: {
            agentId: run.agentId,
            agentVersion: run.agentVersion ?? null,
            testSuite: run.testSuite,
            testCase: run.testCase,
            decisionKind: run.decisionKind,
            intentKind: run.intentKind ?? null,
            modelCalls: run.modelCalls,
            assertionsPassed: run.assertionsPassed ?? null,
            at: run.at,
          },
        });
      } catch (err) {
        logger.error(
          {
            component: "agent-red-team",
            agentId: run.agentId,
            testSuite: run.testSuite,
            testCase: run.testCase,
            err: (err as Error).message,
          },
          "agent_red_team_runs journal write failed (swallowed — suite unaffected)",
        );
      }
    },
  };
}
