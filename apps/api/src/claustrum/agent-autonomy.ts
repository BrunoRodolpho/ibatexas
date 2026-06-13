// Agent autonomy ladder + Stage-0 soak gate (plan-v2 T3-9).
//
// A managed agent climbs a three-rung ladder, and the rung decides how a
// trigger turn executes:
//
//   Stage 0 — TRUE SHADOW: every turn runs through the sandbox plane (T3-6);
//             zero real mutations, journaled. The agent earns trust here.
//   Stage 1 — CONFIRM-GATED (supervised): a proposed mutation parks for human
//             approval (T3-7 approvals glue) before it executes live.
//   Stage 2 — AUTO for the explicitly-allowlisted lowest-risk kind ONLY
//             (`payment.pix.regenerate` — re-issue an expired/failed PIX
//             charge, idempotent, no money moved); everything else the agent
//             may express (notably `pix.charge.refund` — real money out) stays
//             PERMANENTLY confirm-gated. Auto is a per-kind allowlist, never a
//             blanket stage property.
//
// Promotion is GATED, not scheduled blindly (D-017): the Stage-0→Stage-1 flip
// requires a journaled soak of ≥ SOAK_MIN_DAYS calendar days from the recorded
// activation AND a quiet shadow drift signal. The clock starts at activation and
// is read from the agent_runs journal — it is never faked. `canPromoteToStage1`
// is the gate the operator/rollout tooling consults; this module computes the
// ladder + gate purely (no I/O) so it is unit-testable and the rollout decision
// is auditable.

import type { AgentAutonomyStage, AgentDefinition } from "@ibatexas/agents";

/** Minimum journaled Stage-0 soak before a Stage-1 flip is permitted (D-017). */
export const SOAK_MIN_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** The kind the PIX agent may run AUTO at Stage 2 — the only money-safe candidate. */
export const STAGE2_AUTO_KINDS: ReadonlySet<string> = new Set(["payment.pix.regenerate"]);

/**
 * How a trigger turn executes at the agent's current rung. `confirmKinds` are
 * the declared kinds that still require human approval at this rung;
 * `autoKinds` execute without confirmation. At Stage 0 BOTH are empty — the
 * sandbox swallows everything, so the distinction is moot (mode "shadow").
 */
export type ExecutionMode =
  | { readonly mode: "shadow" }
  | {
      readonly mode: "supervised";
      /** Every declared kind is confirm-gated at Stage 1. */
      readonly confirmKinds: ReadonlySet<string>;
    }
  | {
      readonly mode: "live";
      /** Allowlisted auto kinds (Stage 2: payment.pix.regenerate ∩ declared). */
      readonly autoKinds: ReadonlySet<string>;
      /** Declared kinds that still confirm (refunds always confirm). */
      readonly confirmKinds: ReadonlySet<string>;
    };

/**
 * Resolve the execution mode for an agent at its current autonomy stage. Pure.
 *
 * Stage 2 splits the declared kinds into the auto allowlist
 * (`STAGE2_AUTO_KINDS ∩ declaredIntentKinds`) and the rest (confirm) — so
 * `pix.charge.refund` (and any future declared kind) is confirm-gated forever
 * unless explicitly added to the allowlist.
 */
export function resolveExecutionMode(agent: AgentDefinition): ExecutionMode {
  const declared = new Set(agent.declaredIntentKinds);
  switch (agent.autonomyStage) {
    case 0:
      return { mode: "shadow" };
    case 1:
      return { mode: "supervised", confirmKinds: declared };
    case 2: {
      const autoKinds = new Set(
        [...declared].filter((k) => STAGE2_AUTO_KINDS.has(k)),
      );
      const confirmKinds = new Set([...declared].filter((k) => !autoKinds.has(k)));
      return { mode: "live", autoKinds, confirmKinds };
    }
    default: {
      // Exhaustive: AgentAutonomyStage is 0|1|2.
      const _never: never = agent.autonomyStage;
      void _never;
      return { mode: "shadow" };
    }
  }
}

/** Does a kind execute automatically (no human confirm) at this mode? */
export function isAutoKind(mode: ExecutionMode, kind: string): boolean {
  return mode.mode === "live" && mode.autoKinds.has(kind);
}

// ── Stage-0 soak gate ────────────────────────────────────────────────────────

/** What the rollout tooling reads from the agent_runs journal to gate promotion. */
export interface SoakState {
  /** ISO time the Stage-0 shadow was activated (clock start). Null = not activated. */
  readonly activatedAt: string | null;
  /** Number of journaled shadow runs observed since activation. */
  readonly runCount: number;
  /** Whether the shadow drift monitor is quiet (no open drift alerts). */
  readonly driftQuiet: boolean;
}

export interface PromotionGate {
  readonly ok: boolean;
  readonly soakDays: number;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Whether an agent may flip Stage 0 → Stage 1. Gated on ≥ SOAK_MIN_DAYS journaled
 * calendar days from activation, at least one journaled run, and a quiet drift
 * signal. `nowMs` is injected (the clock is never read here, for determinism).
 * Returns the soak days elapsed + every failing reason (empty ⇒ ok).
 */
export function canPromoteToStage1(
  agent: AgentDefinition,
  soak: SoakState,
  nowMs: number,
): PromotionGate {
  const reasons: string[] = [];
  if (agent.autonomyStage !== 0) {
    reasons.push(`agent is at stage ${agent.autonomyStage}, not 0`);
  }
  let soakDays = 0;
  if (soak.activatedAt === null) {
    reasons.push("Stage-0 shadow not activated (no soak clock start)");
  } else {
    const startedMs = Date.parse(soak.activatedAt);
    if (Number.isNaN(startedMs)) {
      reasons.push(`invalid activatedAt "${soak.activatedAt}"`);
    } else {
      soakDays = (nowMs - startedMs) / MS_PER_DAY;
      if (soakDays < SOAK_MIN_DAYS) {
        reasons.push(
          `soak ${soakDays.toFixed(2)}d < required ${SOAK_MIN_DAYS}d ` +
            `(flip permitted on/after ${new Date(startedMs + SOAK_MIN_DAYS * MS_PER_DAY).toISOString()})`,
        );
      }
    }
  }
  if (soak.runCount < 1) {
    reasons.push("no journaled shadow runs during the soak");
  }
  if (!soak.driftQuiet) {
    reasons.push("shadow drift signal not quiet");
  }
  return { ok: reasons.length === 0, soakDays, reasons };
}

/** Next stage after a permitted promotion (0→1→2; 2 is terminal). */
export function nextStage(stage: AgentAutonomyStage): AgentAutonomyStage {
  return stage === 0 ? 1 : stage === 1 ? 2 : 2;
}
