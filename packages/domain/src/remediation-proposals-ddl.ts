// Canonical DDL for the cross-repo `remediation_proposals` table.
//
// This table is the contract the @adjudicate/adjutant Postgres proposal store
// reads (createPostgresRemediationProposalStore); the ibatexas live-agent runner
// writes it (apps/api remediation-proposal-writer). Kept in sync with the
// adjudicate-side remediationProposalsDDL. Idempotent (IF NOT EXISTS) — applied
// both at plane boot (writer.ensureTable) and by `ibx db provision`.
export const REMEDIATION_PROPOSALS_DDL = `
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
`
