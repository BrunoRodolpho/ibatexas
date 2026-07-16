/**
 * IbatexasResolverPort — the claustrum `ResolverPort` impl (plan → RESOLVE → adjudicate).
 *
 * For each planner-proposed envelope it runs `resolveAndAssemble` to (a) resolve
 * the (possibly natural-language) payload to concrete ids and (b) build the
 * per-pack `SystemState.ctx` the kernel guards read. It then REBUILDS the
 * envelope via `buildEnvelope` (so the kernel's intentHash re-derivation passes
 * and the resolved envelope is what gets adjudicated, dispatched, AND audited).
 *
 * FE-T09b (BKL-154) — BEFORE resolving, each envelope's `kind`/`payload` pass
 * through `correctAmendPreference`: a deterministic candidate-resolution
 * correction that re-routes a cart-op proposal (`order.item.add/update/
 * remove`) to its granular amend sibling when the utterance references an
 * already-placed order AND the customer has one to amend (see that module's
 * doc for the live-disproof this fixes). The corrected `kind`/`payload` — not
 * `env.kind`/`env.payload` — drive `resolveAndAssemble` AND the envelope
 * rebuild below, so a re-route is never silently lost.
 *
 * Read-only. Wired into `createConductor({ resolver })` at the composition root.
 */

import { buildEnvelope, type IntentEnvelope } from "@adjudicate/core";
import type { ResolvedEnvelope, ResolverPort } from "@claustrum/core";
import { resolveAndAssemble } from "./resolve-and-assemble.js";
import { correctAmendPreference } from "./amend-preference-correction.js";
import {
  buildCustomerAuthority,
  customerPrincipalForSession,
  resourceRefsForIntent,
} from "./authority-wiring.js";

export function createIbatexasResolver(): ResolverPort {
  return {
    async resolve({ plan, cognition, customerId, channel }): Promise<ReadonlyArray<ResolvedEnvelope>> {
      const out: ResolvedEnvelope[] = [];
      for (const env of plan.envelopes) {
        const correction = await correctAmendPreference(
          env.kind,
          (env.payload ?? {}) as Record<string, unknown>,
          // Optional chaining, not a direct read: `CognitiveState.perception`
          // is REQUIRED by the port's type, but defends against an
          // incomplete/malformed cognition object anyway (fail-closed —
          // no text ⇒ correctAmendPreference's own `undefined` branch ⇒ no
          // re-route — never a crash that would take the whole turn down).
          cognition.perception?.text,
          customerId,
        );
        const kind = correction?.kind ?? env.kind;
        const rawPayload = correction?.payload ?? ((env.payload ?? {}) as Record<string, unknown>);

        const { payload, ctx, owned, ownershipIndeterminate } = await resolveAndAssemble({
          kind,
          payload: rawPayload,
          customerId,
          channel,
          // The active-cart Redis key uses the conversation handle (= the
          // conductor's AgentContext.sessionId, register-ibatexas-tool-packs.ts).
          sessionId: cognition.conversationId,
        });
        // 034-F1: for money-moving (ownership-gated) kinds, stamp resourceRefs
        // (owner=customer, resource=orderId) and inject state.authority built from
        // the ownership-CONFIRMED `owned` set, engaging the kernel ownership guard
        // as defense-in-depth. Non-gated kinds are untouched.
        //
        // Finding 11: when ownership is INDETERMINATE (the scoped DB load threw),
        // do NOT stamp refs / inject authority — otherwise the guard would see an
        // unbound resource and REFUSE the resource's TRUE owner on a transient DB
        // error. Leaving it inert falls back to service-layer scoping (fail-safe).
        const refs = ownershipIndeterminate
          ? undefined
          : resourceRefsForIntent(
              kind,
              payload as Record<string, unknown>,
              customerId,
            );
        // Rebuild with the SAME nonce/actor/taint so the intentHash is canonical
        // (unchanged when payload didn't change; fresh when it did). createdAt is
        // metadata-only (not hashed) — preserve it for the audit trail. `kind` is
        // the (possibly amend-preference-corrected) kind, never the raw `env.kind`.
        const resolved = buildEnvelope({
          kind,
          payload,
          actor: env.actor,
          taint: env.taint,
          nonce: env.nonce,
          createdAt: env.createdAt,
          ...(refs === undefined ? {} : { resourceRefs: refs }),
        }) as IntentEnvelope;
        const state =
          refs === undefined
            ? { ctx }
            : {
                ctx,
                // 034-F1: source the principal binding from the conductor-
                // AUTHENTICATED session (cognition.conversationId), NOT
                // env.actor.sessionId — so the kernel IDOR gate verifies the
                // adjudicated envelope's actor session matches the authenticated
                // session (the planner stamps actor.sessionId = conversationId, so
                // a legit turn matches; a divergent/forged actor session REFUSEs).
                authority: buildCustomerAuthority(
                  customerId,
                  owned,
                  customerPrincipalForSession(cognition.conversationId, customerId),
                ),
              };
        out.push({ envelope: resolved, state });
      }
      return out;
    },
  };
}
