/**
 * IbatexasResolverPort — the claustrum `ResolverPort` impl (plan → RESOLVE → adjudicate).
 *
 * For each planner-proposed envelope it runs `resolveAndAssemble` to (a) resolve
 * the (possibly natural-language) payload to concrete ids and (b) build the
 * per-pack `SystemState.ctx` the kernel guards read. It then REBUILDS the
 * envelope via `buildEnvelope` (so the kernel's intentHash re-derivation passes
 * and the resolved envelope is what gets adjudicated, dispatched, AND audited).
 *
 * Read-only. Wired into `createConductor({ resolver })` at the composition root.
 */

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ResolvedEnvelope, ResolverPort } from "@claustrum/core";
import { resolveAndAssemble } from "./resolve-and-assemble.js";

export function createIbatexasResolver(): ResolverPort {
  return {
    async resolve({ plan, cognition, customerId, channel }): Promise<ReadonlyArray<ResolvedEnvelope>> {
      const out: ResolvedEnvelope[] = [];
      for (const env of plan.envelopes) {
        const { payload, ctx } = await resolveAndAssemble({
          kind: env.kind,
          payload: (env.payload ?? {}) as Record<string, unknown>,
          customerId,
          channel,
          // The active-cart Redis key uses the conversation handle (= the
          // conductor's AgentContext.sessionId, register-ibatexas-tool-packs.ts).
          sessionId: cognition.conversationId,
        });
        // Rebuild with the SAME nonce/actor/taint so the intentHash is canonical
        // (unchanged when payload didn't change; fresh when it did). createdAt is
        // metadata-only (not hashed) — preserve it for the audit trail.
        const resolved = buildEnvelope({
          kind: env.kind,
          payload,
          actor: env.actor,
          taint: env.taint,
          nonce: env.nonce,
          createdAt: env.createdAt,
        }) as IntentEnvelope;
        out.push({ envelope: resolved, state: { ctx } });
      }
      return out;
    },
  };
}
