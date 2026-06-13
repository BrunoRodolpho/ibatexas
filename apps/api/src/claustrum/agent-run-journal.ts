// agent_runs journal (plan-v2 T3-6).
//
// Every shadow (and later supervised/live) agent turn is journaled here: what
// woke the agent, what it decided, what it WOULD have mutated (sandbox-recorded,
// never real), and which autonomy stage it ran at. Two consumers:
//   - operators reviewing the Stage-0 shadow soak (the ≥1-week journaled run
//     D-017 gates the Stage-1 flip on — T3-9 reads `activatedAt`/run history);
//   - the shadow drift monitor (decision-distribution over agent turns).
//
// This module is the SEAM + a structured-log/in-memory default. The durable
// Postgres `agent_runs` table (with the soak activation timestamp) lands with
// the T3-9 soak gate that actually reads it across restarts; the seam keeps the
// shadow composition agnostic to where records are persisted.

import { logger } from "../lib/logger.js";
import type { SandboxExecution } from "./shadow-tool-registry.js";

/** One journaled agent turn. */
export interface AgentRunRecord {
  /** Agent id (`pix-payment-failure-remediation`). */
  readonly agentId: string;
  readonly agentVersion: string;
  /** Autonomy stage the turn ran at (0 shadow, 1 confirm-gated, 2 auto). */
  readonly stage: number;
  /** `agent:<id>@<ver>:entity:<entityId>` — the unhashed audit namespace. */
  readonly sessionId: string;
  /** `${entityKind}:${entityId}` the trigger was about. */
  readonly entity: string;
  /** `${sourceSubject}:${eventId}` deterministic carrier. */
  readonly externalId: string;
  /** Kernel decision kind for the turn (EXECUTE, REFUSE, ESCALATE, …). */
  readonly decisionKind: string;
  /** Would-be mutations the sandbox swallowed (Stage 0: always real-effect-free). */
  readonly sandboxExecutions: ReadonlyArray<SandboxExecution>;
  /** ISO time the turn completed (passed in — never read the clock here). */
  readonly at: string;
}

export interface AgentRunJournal {
  record(run: AgentRunRecord): void | Promise<void>;
}

/**
 * Default journal: structured log + bounded in-memory ring (for tests and the
 * operator read surface until the durable Postgres table lands in T3-9). The
 * ring never grows unbounded; the durable backing is the source of truth for
 * the soak gate.
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
          stage: run.stage,
          sessionId: run.sessionId,
          entity: run.entity,
          externalId: run.externalId,
          decision: run.decisionKind,
          sandboxMutations: run.sandboxExecutions.length,
        },
        "agent run journaled",
      );
    },
    recent() {
      return [...ring];
    },
  };
}
