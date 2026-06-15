/**
 * AgentDefinition — the zod manifest for a server-resident managed agent
 * (plan-v2 T3-3).
 *
 * A managed agent is NOT a Pack: it has no policy, no planner, no handlers.
 * It is a triggered consumer of the SAME kernel-gated pipeline the chat
 * surface uses — so what it declares here is its *authorization envelope*:
 * which intent kinds it may ever express (`declaredIntentKinds`, enforced
 * by T3-4's AUTH-phase scope guard), what wakes it (`trigger`), what it may
 * spend (`budgets`, T3-2 host caps + T3-4 escalate guard), how to stop it
 * (`killSwitchKey`, T3-5) and who answers for it (`owner`). The agent plane
 * runs a SINGLE live path (the staging ladder was removed) — every trigger
 * really executes through the kernel; refunds are confirm-gated by policy.
 *
 * Session identity (D-017): every capsule an agent opens carries
 * `sessionId = agent:<id>@<version>:entity:<entityId>` — the `agent:`
 * prefix is written UNHASHED to `intent_audit`, and every time-windowed
 * production-signal consumer (kernel-replay `--ci`, impact graph, drift
 * baselines) excludes that namespace. `sessionIdPrefix` is therefore
 * load-bearing governance data, validated here to be EXACTLY
 * `agent:<id>@<version>` so the exclusion filters and the registry can
 * never disagree about an agent's namespace.
 */

import { z } from "zod"

/**
 * The audit-namespace prefix shared by every managed agent. Must agree
 * with the `session_id LIKE 'agent:%'` exclusion filters in
 * `ibx kernel replay --ci` (T1b-3) and the impact-graph generator (T2-4).
 */
export const AGENT_SESSION_NAMESPACE = "agent:"

/** kebab-case ASCII, same alphabet as product handles (CLAUDE.md naming). */
const AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Plain x.y.z — pre-release/build suffixes would leak `+`/`-` ambiguity into sessionIds. */
const AGENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** Canonical sessionId prefix for an agent id + version (D-017). */
export function expectedSessionIdPrefix(id: string, version: string): string {
  return `${AGENT_SESSION_NAMESPACE}${id}@${version}`
}

// ── Trigger ──────────────────────────────────────────────────────────────────

/**
 * What wakes the agent. `subjects` are short-form NATS subjects (the
 * `publishNatsEvent()` convention — never the `ibatexas.`-prefixed wire
 * form); `eventKinds` are the qualifying domain event kinds within those
 * subjects that actually open a trigger capsule (T3-2 filters on them).
 */
export const AgentTriggerSchema = z
  .object({
    subjects: z.array(z.string().min(1)).nonempty(),
    eventKinds: z.array(z.string().min(1)).nonempty(),
  })
  .strict()
  .superRefine((trigger, ctx) => {
    for (const [i, subject] of trigger.subjects.entries()) {
      if (subject.startsWith("ibatexas.")) {
        ctx.addIssue({
          code: "custom",
          path: ["subjects", i],
          message:
            `subject "${subject}" está na forma prefixada do wire — use a forma curta ` +
            `(convenção publishNatsEvent; o client adiciona o prefixo "ibatexas.")`,
        })
      }
    }
  })

export type AgentTrigger = z.infer<typeof AgentTriggerSchema>

// ── Budgets ──────────────────────────────────────────────────────────────────

/**
 * Hard resource caps per agent. `maxModelCallsPerTrigger` and
 * `wallClockMsPerTrigger` are host-enforced by the trigger bridge (T3-2);
 * `tokensPerDay` feeds the kernel-side escalate guard (T3-4, reading the
 * `llm:tokens`-shaped counter); `cooldownSeconds` keys the per-entity
 * cooldown in Redis (T3-2).
 */
export const AgentBudgetsSchema = z
  .object({
    maxModelCallsPerTrigger: z.number().int().positive(),
    wallClockMsPerTrigger: z.number().int().positive(),
    tokensPerDay: z.number().int().positive().optional(),
    cooldownSeconds: z.number().int().nonnegative(),
  })
  .strict()

export type AgentBudgets = z.infer<typeof AgentBudgetsSchema>

// ── AgentDefinition ──────────────────────────────────────────────────────────

export const AgentDefinitionSchema = z
  .object({
    id: z.string().regex(AGENT_ID_PATTERN, {
      message: "id deve ser kebab-case ASCII (ex: pix-payment-failure-remediation)",
    }),
    version: z.string().regex(AGENT_VERSION_PATTERN, {
      message: "version deve ser x.y.z simples (sem sufixos de pre-release/build)",
    }),
    displayName: z.string().min(1),
    declaredIntentKinds: z.array(z.string().min(1)).nonempty(),
    trigger: AgentTriggerSchema,
    budgets: AgentBudgetsSchema,
    killSwitchKey: z.string().min(1),
    owner: z.string().min(1),
    sessionIdPrefix: z.string().min(1),
  })
  .strict()
  .superRefine((def, ctx) => {
    const expected = expectedSessionIdPrefix(def.id, def.version)
    if (def.sessionIdPrefix !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["sessionIdPrefix"],
        message: `sessionIdPrefix deve ser exatamente "${expected}" (D-017)`,
      })
    }
    if (new Set(def.declaredIntentKinds).size !== def.declaredIntentKinds.length) {
      ctx.addIssue({
        code: "custom",
        path: ["declaredIntentKinds"],
        message: "declaredIntentKinds contém kinds duplicados",
      })
    }
  })

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

// ── Session-id composition (D-017) ───────────────────────────────────────────

/**
 * Compose the full capsule sessionId for one triggered entity:
 * `agent:<id>@<version>:entity:<entityId>`. The trigger bridge (T3-2) and
 * the Stage-0 composition (T3-6) MUST mint sessionIds through this helper
 * so the unhashed-`agent:`-prefix contract (D-017) has a single producer.
 */
export function agentSessionId(
  def: Pick<AgentDefinition, "sessionIdPrefix">,
  entityId: string,
): string {
  if (entityId.length === 0) {
    throw new Error("agentSessionId: entityId vazio")
  }
  return `${def.sessionIdPrefix}:entity:${entityId}`
}
