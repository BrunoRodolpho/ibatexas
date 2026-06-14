// Remediation proposal writer (P4 producer seam, adopter side).
//
// When the live agent runner parks a confirm-gated remediation (B2), this writes
// a row to the SHARED `remediation_proposals` table — the exact contract the
// @adjudicate/adjutant Postgres proposal store reads (createPostgresRemediation
// ProposalStore). ibatexas writes; the adjutant projects. The table is the
// cross-repo contract, so apps/api takes NO @adjudicate/adjutant dependency.
//
// Best-effort + fail-open: the proposal read-model is operator observation, never
// governance — a write failure must never affect the parked approval or the turn.

import { logger } from "../lib/logger.js";
import type { ParkedRemediationProposal } from "./live-agent-conductor.js";

/** Minimal structural Postgres surface — pg.Pool satisfies it. */
export interface ProposalWriterPool {
  query(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
}

/** DDL mirroring @adjudicate/adjutant's remediationProposalsDDL (kept in sync). */
const REMEDIATION_PROPOSALS_DDL = `
  CREATE TABLE IF NOT EXISTS remediation_proposals (
    proposal_id   TEXT PRIMARY KEY,
    incident_id   TEXT NOT NULL,
    action        TEXT NOT NULL,
    blast_radius  INTEGER NOT NULL,
    disposition   TEXT NOT NULL,
    status        TEXT NOT NULL,
    approval_token TEXT,
    intent_hash   TEXT,
    envelope_jsonb JSONB,
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS remediation_proposals_incident_idx ON remediation_proposals(incident_id);
  CREATE INDEX IF NOT EXISTS remediation_proposals_status_idx ON remediation_proposals(status);
  CREATE INDEX IF NOT EXISTS remediation_proposals_token_idx ON remediation_proposals(approval_token);
`;

export interface RemediationProposalWriter {
  /** Create the shared table if absent (idempotent). Call once at plane boot. */
  ensureTable(): Promise<void>;
  /** Upsert a parked proposal (best-effort; swallows errors). */
  write(proposal: ParkedRemediationProposal): Promise<void>;
}

export function createRemediationProposalWriter(
  pool: ProposalWriterPool,
): RemediationProposalWriter {
  return {
    async ensureTable() {
      await pool.query(REMEDIATION_PROPOSALS_DDL);
    },
    async write(p) {
      try {
        await pool.query(
          `INSERT INTO remediation_proposals
             (proposal_id, incident_id, action, blast_radius, disposition, status,
              approval_token, intent_hash, envelope_jsonb, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (proposal_id) DO UPDATE SET
             status = EXCLUDED.status,
             approval_token = EXCLUDED.approval_token,
             updated_at = EXCLUDED.updated_at`,
          [
            p.proposalId,
            p.incidentId,
            p.action,
            1, // blastRadius: one payment per remediation
            p.disposition,
            p.status,
            p.approvalToken,
            p.intentHash,
            null, // envelope: ibatexas doesn't ship the full envelope here
            p.at,
            p.at,
          ],
        );
      } catch (err) {
        logger.error(
          { component: "remediation-proposal-writer", proposalId: p.proposalId, err: (err as Error).message },
          "failed to write remediation proposal (swallowed — approval already parked)",
        );
      }
    },
  };
}
