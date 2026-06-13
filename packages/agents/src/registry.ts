/**
 * AGENT_REGISTRY — the composed roster of server-resident managed agents
 * (plan-v2 T3-3), mirror-imaging `IBATEXAS_COMPOSED_PACKS`: this package is
 * the ONLY place that names the managed agents together. The trigger-bridge
 * worker (T3-2), the scope/budget guards (T3-4), the per-agent kill switch
 * (T3-5), the AI-BOM gate (`ibx kernel pack-bom`) and the journeys gates
 * all consume this list — it lives in a workspace package (not apps/api)
 * because the CLI/journeys gates can never import apps/* (the P0-8 lesson).
 *
 * Every entry is `AgentDefinitionSchema.parse()`d at module-load, so a
 * schema-invalid definition fails the importing process fail-closed. The
 * cross-cutting roster checks (declared ⊆ registered pack kinds, prefix
 * uniqueness) live in `assertAgentRosterIntegrity()` — composition roots
 * MUST call it at boot (see drift.ts).
 */

import { AgentDefinitionSchema, type AgentDefinition } from "./definition.js"

// ── PIX payment-failure remediation (the lighthouse agent) ──────────────────
//
// DRAFT seeded at Stage 0 per T3-3; T3-9 fills/finalizes the real definition
// as the agent climbs the autonomy ladder (Stage 0 shadow → Stage 1
// confirm-gated → Stage 2 auto for `payment.pix.regenerate` only; refunds
// always confirm). Declared kinds:
//   - `payment.pix.regenerate` — @ibatexas/pack-payments (the customer-facing
//     composite regenerate kind; the only Stage-2 auto candidate per plan §5)
//   - `pix.charge.refund`      — @adjudicate/pack-payments-pix (wire-PSP
//     refund; permanently confirm-gated)
// Trigger: the payments domain publishes `payment.status_changed` (CLAUDE.md
// NATS conventions — short form); the bridge qualifies on failed/expired
// transitions before opening a capsule.
export const PIX_REMEDIATION_AGENT: AgentDefinition = AgentDefinitionSchema.parse({
  id: "pix-payment-failure-remediation",
  version: "0.1.0",
  displayName: "Remediação de falhas de pagamento PIX",
  declaredIntentKinds: ["payment.pix.regenerate", "pix.charge.refund"],
  trigger: {
    subjects: ["payment.status_changed"],
    eventKinds: ["payment.failed", "payment.expired"],
  },
  autonomyStage: 0,
  budgets: {
    // Host hard caps (T3-2): one trigger turn is plan → (at most) one
    // envelope → respond; 4 model calls is generous headroom.
    maxModelCallsPerTrigger: 4,
    wallClockMsPerTrigger: 60_000,
    // Kernel-side daily token budget (T3-4 escalate guard threshold).
    tokensPerDay: 200_000,
    // Per-entity cooldown (T3-2): at most one remediation attempt per
    // payment per 15 minutes, whatever the redelivery pattern.
    cooldownSeconds: 900,
  },
  // Logical kill-switch identity (T3-5 keys createRedisEmergencyStateStore
  // per agent off this; the Redis key itself is built with rk() there).
  killSwitchKey: "agent:pix-payment-failure-remediation",
  owner: "bnocesar@gmail.com",
  sessionIdPrefix: "agent:pix-payment-failure-remediation@0.1.0",
})

// ── Composed roster ──────────────────────────────────────────────────────────

export const AGENT_REGISTRY: ReadonlyArray<AgentDefinition> = [
  PIX_REMEDIATION_AGENT,
]
