// Deterministic live E2E: agent refund → park → resolve → (agent_runs +
// remediation_proposal in the live DB), exercising the REAL components.
//
// "Test mode": the agent's DECISION is scripted (a pix.charge.refund envelope on
// an agent: session) instead of NATS→planner→LLM, but EVERYTHING downstream is
// real — the real kernel (so B1 fires), the real AgentApprovalEngine (park +
// resolve via confirmationReceipt), the real Postgres journal + proposal writer.
// Run: npx tsx --env-file=../../.env scripts/agent-refund-e2e.ts

import pg from "pg";
import { buildEnvelope } from "@adjudicate/core";
import { adjudicate } from "@adjudicate/core/kernel";
import { pixPolicyBundle, type PixCharge, type PixState } from "@adjudicate/pack-payments-pix";
import { prisma } from "@ibatexas/domain";
import { createAgentApprovalEngine } from "../src/claustrum/agent-approvals.js";
import { createPostgresAgentRunJournal } from "../src/claustrum/agent-run-journal.js";
import { createRemediationProposalWriter } from "../src/claustrum/remediation-proposal-writer.js";

const SESSION = "agent:pix-payment-failure-remediation@0.1.0:entity:order-e2e";
const ENTITY = "order:order-e2e";
const EXTERNAL_ID = "ibatexas.payment.status_changed:pay-e2e:failed";
const DET_TIME = "2026-06-14T12:00:00.000Z";
const log = (m: string, x?: unknown) => console.log(`  ${m}`, x !== undefined ? JSON.stringify(x) : "");

// A confirmed charge the refund targets (the kernel state guards require it).
const CHARGE: PixCharge = {
  id: "cha-e2e",
  amountCentavos: 30_000,
  status: "confirmed",
  nonce: "n-e2e",
  createdAt: DET_TIME,
  confirmedAt: DET_TIME,
} as PixCharge;
const STATE: PixState = { charges: new Map([["cha-e2e", CHARGE]]) };

const refundEnvelope = buildEnvelope({
  kind: "pix.charge.refund",
  payload: { chargeId: "cha-e2e", refundCentavos: 20_000, reason: "agent remediation" },
  actor: { principal: "llm", sessionId: SESSION },
  taint: "UNTRUSTED",
  nonce: "n-e2e",
  createdAt: DET_TIME,
});

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const sqlPool = { query: (t: string, p?: ReadonlyArray<unknown>) => pool.query(t, p as unknown[]) };

  console.log("\n── 1. Agent proposes a refund → REAL kernel adjudicates (B1) ──");
  const decision = adjudicate(refundEnvelope as never, STATE as never, pixPolicyBundle);
  log("decision.kind =", decision.kind);
  if (decision.kind !== "REQUEST_CONFIRMATION") throw new Error(`B1 FAILED: expected REQUEST_CONFIRMATION, got ${decision.kind}`);
  log("✓ B1 fired: an agent-session refund is confirm-gated (never auto-EXECUTE)");

  console.log("\n── 2. Park the approval (B2, REAL engine) ──");
  let parkedToken = "";
  const engine = createAgentApprovalEngine({
    notify: async () => {},
    now: () => new Date().toISOString(),
  });
  const prompt = decision.kind === "REQUEST_CONFIRMATION" ? decision.prompt : "confirm?";
  const request = await engine.request({ envelope: refundEnvelope, prompt });
  parkedToken = request.token;
  log("✓ parked approval token =", parkedToken);

  console.log("\n── 3. Journal the agent run + write the remediation proposal (live DB) ──");
  await createPostgresAgentRunJournal(prisma).record({
    agentId: "pix-payment-failure-remediation",
    agentVersion: "0.1.0",
    sessionId: SESSION,
    entity: ENTITY,
    externalId: EXTERNAL_ID,
    decisionKind: decision.kind,
    intentKind: "pix.charge.refund",
    modelCalls: 1,
    at: new Date().toISOString(),
  });
  const writer = createRemediationProposalWriter(pool);
  await writer.ensureTable();
  await writer.write({
    proposalId: EXTERNAL_ID,
    incidentId: ENTITY,
    action: "pix.charge.refund",
    disposition: "REVIEW",
    status: "pending_review",
    approvalToken: parkedToken,
    intentHash: refundEnvelope.intentHash,
    at: new Date().toISOString(),
  });
  log("✓ agent_runs row + remediation_proposal (pending_review) written");

  console.log("\n── 4. Operator resolves the approval → REAL re-adjudication → EXECUTE ──");
  const { decision: resolved } = await engine.resolve({
    token: parkedToken,
    accepted: true,
    resolvedBy: "operator-e2e",
    rebuildState: async () => STATE as never,
    policyFor: () => pixPolicyBundle as never,
    sink: { emit: async () => {} },
  });
  log("resolved decision.kind =", resolved?.kind);
  if (resolved?.kind !== "EXECUTE") throw new Error(`RESOLVE FAILED: expected EXECUTE, got ${resolved?.kind}`);
  await writer.markResolvedByToken(parkedToken, "executed", new Date().toISOString());
  log("✓ confirmationReceipt converted the re-adjudicated decision to EXECUTE; proposal → executed");

  console.log("\n── 5. Final DB state (what the adjutant projects) ──");
  const runs = await sqlPool.query(
    `SELECT entity, decision_kind, intent_kind FROM ibx_domain.agent_runs WHERE external_id = $1`,
    [EXTERNAL_ID],
  );
  const props = await sqlPool.query(
    `SELECT incident_id, action, disposition, status, approval_token FROM remediation_proposals WHERE proposal_id = $1`,
    [EXTERNAL_ID],
  );
  log("agent_runs:", runs.rows);
  log("remediation_proposals:", props.rows);

  await pool.end();
  await prisma.$disconnect();
  console.log("\n✓ E2E chain driven: trigger(test) → B1 confirm → park → journal+proposal → resolve→EXECUTE → DB.\n");
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
