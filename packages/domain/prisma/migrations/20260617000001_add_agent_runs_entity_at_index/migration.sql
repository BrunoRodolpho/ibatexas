-- #28-10: index agent_runs(entity, at DESC) so the adjudicate incident
-- projection's `SELECT DISTINCT ON (entity) ... ORDER BY entity, at DESC` uses
-- an index scan instead of a full sort. Cross-repo ordering: this migration must
-- be deployed BEFORE the adjudicate incident-projection loader fix relies on it.

-- CreateIndex
CREATE INDEX "agent_runs_entity_at_idx" ON "ibx_domain"."agent_runs"("entity", "at" DESC);
