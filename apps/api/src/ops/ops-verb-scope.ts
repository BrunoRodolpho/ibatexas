// ops-verb-scope.ts — the ingress-scoped verb set (BKL-086, the SIM-swap
// compensating control).
//
// The ops conductor plane is ingress-agnostic: the SAME composeOpsConductor runs
// whether the manager talks from the dashboard (POST /api/admin/ops/chat, behind
// the staff JWT) or over WhatsApp (the phone→Staff-row ingress). But the two
// ingresses do NOT carry the same trust: on WhatsApp the phone IS the identity
// (AUT-003), and a signed message from a STOLEN owner phone (a SIM swap) is
// legitimate at every technical layer — Twilio signature, phone allowlist, the
// staff.active re-check all pass. There is no second factor.
//
// So the ratified BKL-086 design keeps IRREVERSIBLE money / two-person verbs
// DASHBOARD-ONLY and advertises only REVERSIBLE verbs over WhatsApp (86/un-86,
// notes, kitchen advance, alert/incident resolve, the ops_snapshot read).
// `payment.refund.issue` moves real money out and cannot be reversed by the same
// operator, so it stays off the WhatsApp plane until a step-up factor exists
// (a daily ops PIN via the staff Twilio Verify infra — a registered v2 follow-up).
//
// This module expresses that exclusion as ONE named set + two DETERMINISTIC,
// composition-time filters, so the WhatsApp scope narrows BOTH:
//   1. ADVERTISEMENT + ALLOWLIST — `scopeCapabilityPlanner` removes excluded kinds
//      from the planner's `allowedIntents`, which the ibatexas planner enforces
//      twice (it only advertises allowed intents in the express_intent enum AND
//      DROPS any model-emitted capability outside the allowlist).
//   2. CONFIRM-RESUME (defense in depth) — `scopeResumeChannel` hides an
//      out-of-scope parked envelope from THIS ingress's `matchToParked`, so a
//      money confirm PARKED from the dashboard can NEVER be resumed by an "sim"
//      typed over WhatsApp (and vice versa the park is untouched — the dashboard
//      resumes it normally).
//
// The `dashboard` scope excludes nothing, so its filters are identity (byte-
// identical to the pre-BKL-086 composition — pinned by the ops-conductor tests).

import type { CapabilityPlanner, Plan } from "@adjudicate/core/llm";
import type {
  ChannelDriver,
  ChannelMessage,
  ParkedMatch,
  Session,
  ToolDefinition,
} from "@claustrum/core";
import { OPS_FOREIGN_ADVERTISED_REFUND_KIND } from "@ibatexas/pack-ops";

/** Which ingress composed this ops conductor. Selects the excluded verb set. */
export type OpsVerbScope = "dashboard" | "whatsapp";

/**
 * The money / two-person verbs kept DASHBOARD-ONLY — excluded from the WhatsApp
 * ops plane as the SIM-swap compensating control (see the module header + the
 * BKL-086 ratified design). Every kind here is IRREVERSIBLE by the acting
 * operator alone; a WhatsApp-signed command from a stolen phone would otherwise
 * be indistinguishable from the real owner.
 *
 * Grow this set (never the WhatsApp allowlist) when a future money / two-person
 * verb lands (e.g. a staff-plane payout or a void). Keeping the EXCLUSION named
 * — rather than enumerating the WhatsApp-allowed verbs — fails CLOSED: a new ops
 * verb is reversible-by-default on WhatsApp only after a deliberate omission
 * here, but an irreversible one is dashboard-only the moment it is added.
 *
 * FE-T24: deliberately NOT generated from `CapabilityDefinition` — a genuine
 * business-policy judgment (which verbs need a WhatsApp step-up factor), not
 * a structural registry fact. See `generate-ops-boundary-kinds.ts`'s own doc
 * for the full disposition (packages/packs-composed/src/capability-
 * definitions/).
 */
export const WA_EXCLUDED_OPS_KINDS: ReadonlySet<string> = new Set<string>([
  // payment.refund.issue — moves money out of the ledger; the BKL-085 refund
  // path. Dashboard-only until a WhatsApp step-up factor exists (v2).
  OPS_FOREIGN_ADVERTISED_REFUND_KIND,
]);

/**
 * BKL-096 — the two-person / separation-of-duty DESTRUCTIVE verbs the ops
 * persona MUST NEVER advertise or emit on ANY ingress (dashboard OR whatsapp),
 * until an owner ratifies a propose-path (the OPS-007/008/011 ratification gate).
 * Unlike {@link WA_EXCLUDED_OPS_KINDS} — which is DASHBOARD-ONLY (a WhatsApp-scope
 * subtraction of verbs the persona MAY still drive from the trusted dashboard) —
 * this set is a NO-PLANE-EVER forbid: none of these kinds may enter the ops tool
 * registry OR the ops planner's advertised surface on either scope.
 *
 * These are the pack-OWNED destructive verb kinds (what an ops PACK verb WOULD be
 * named if someone added one), NOT the ops-advertised PROJECTION kinds:
 *   - `order.cancel`          — force-cancel a placed order (pack-orders). The ops
 *                               plane advertises the REVERSIBLE kitchen-advance
 *                               PROJECTION kind `order.status.transition`, which is
 *                               BKL-090-legality-gated to NON-terminal transitions
 *                               (a canceled/delivered jump REFUSEs `order.status.
 *                               terminal`) — it can never reach a force-cancel.
 *   - `payment.waive`         — forgive an outstanding balance (pack-payments):
 *                               irreversible debt write-off, OWNER-gated at the HTTP
 *                               route (inline OWNER check), no reversing verb.
 *   - `payment.status.force`  — force a payment into an arbitrary status
 *                               (pack-payments), bypassing the lifecycle machine;
 *                               the ops plane advertises no payment-status verb at
 *                               all (the admin route builds the PROJECTION kind
 *                               `payment.status.transition`, itself un-advertised).
 *
 * These verbs are unreachable by the ops persona TODAY via TWO independent
 * fail-closed layers: (1) none is in the ops tool registry (`ops-tool-registry.ts`
 * advertises 8 verbs); (2) none is in the staff-role matrix (`staff-role-matrix.ts`),
 * so an `admin:` envelope carrying one REFUSEs `kind_not_in_staff_matrix` at the
 * composed router. That posture is SOUND but IMPLICIT — a future PR that matrixed
 * one of these for the dashboard could silently make it ops-advertisable. This set
 * makes the exclusion EXPLICIT and drift-guarded (see `opsPlaneDriftProblems` in
 * `ops-conductor.ts`, which fails boot closed if any of these enters the ops
 * registry, and the BKL-096 drift test that pins the advertised surface). This
 * does NOT build a propose-path — it LOCKS the current forbid-state as a tested
 * contract; whether the persona may ever PROPOSE these is the separate, deferred
 * owner-ratification question.
 *
 * FE-4 CONTRACT (FE-T26): the hand-authored `FORBIDDEN_OPS_DESTRUCTIVE_KINDS`
 * constant that used to live here is DELETED — its 3 kinds now live as
 * `CapabilityDefinition.opsForbiddenDestructive: true` (`order.cancel`,
 * `payment.waive`, `payment.status.force`; see `packages/packs-composed/
 * src/capability-definitions/definitions.ts`), projected by
 * `generateOpsForbiddenDestructiveKinds` (FE-T24). `forbiddenOpsVerbProblems`
 * below now REQUIRES its `forbidden` argument (no default) — see that
 * function's own doc for why a required param, not a flipped default, was
 * the correct FE-T25-recommended, team-lead-concurred CONTRACT action.
 */

/**
 * The BKL-096 forbidden-verb check `opsPlaneDriftProblems` (ops-conductor.ts)
 * runs at boot: fails CLOSED if any `forbidden` kind ever enters the ops
 * REGISTRY, matched by either `capability` or `intentKind`. Extracted to a
 * pure, parameterized function (FE-T24 review fix) so its freshness/
 * equivalence test can drive this SAME real check with a generated
 * forbidden set, instead of a hand-copied re-implementation that could
 * silently drift from the real message text.
 *
 * FE-4 CONTRACT (FE-T26): `forbidden` is now REQUIRED — it had a default
 * (the hand-authored `FORBIDDEN_OPS_DESTRUCTIVE_KINDS`, now deleted) during
 * FE-T25's repoint window, when both the hand list and the generated
 * projection stayed alive side by side. A required param (over flipping the
 * default to the generated set) was FE-T25's own recorded recommendation
 * (`docs/architecture/design/fe4-drift-gates.md`'s CONTRACT sequence),
 * because a flipped default would have silently changed the behavior of
 * any OTHER caller that never passed an explicit `forbidden` argument —
 * every call site must now say what it means, not inherit a hidden
 * default. Every caller (the real boot call in claustrum-bootstrap.ts,
 * every test) already passes an explicit set.
 */
export function forbiddenOpsVerbProblems(
  opsTools: ReadonlyArray<ToolDefinition<unknown, unknown>>,
  forbidden: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const tool of opsTools) {
    const capability = String(tool.capability);
    const intentKind = String(tool.intentKind);
    if (forbidden.has(capability) || forbidden.has(intentKind)) {
      problems.push(
        `ops registry advertises FORBIDDEN two-person destructive verb ` +
          `"${capability}" (tool ${tool.id}); these verbs must stay ops-unreachable ` +
          `until an owner ratifies a propose-path (OPS-007/008/011). See ` +
          `CapabilityDefinition.opsForbiddenDestructive.`,
      );
    }
  }
  return problems;
}

/** The excluded kinds for an ingress scope (empty for `dashboard`). */
export function excludedKindsForScope(scope: OpsVerbScope): ReadonlySet<string> {
  return scope === "whatsapp" ? WA_EXCLUDED_OPS_KINDS : EMPTY_EXCLUSION;
}

const EMPTY_EXCLUSION: ReadonlySet<string> = new Set<string>();

/**
 * Wrap a capability planner so its advertised `allowedIntents` exclude the given
 * kinds. Because the ibatexas planner both advertises the enum AND enforces the
 * allowlist from `allowedIntents`, a removed kind is simultaneously NOT offered
 * to the model AND DROPPED if the model emits it anyway. Filtering can only
 * REMOVE intent kinds — it never touches `visibleReadTools`, so the pack's
 * `safePlan` MUTATING-leak invariant is preserved. An empty exclusion returns
 * the planner unchanged (byte-identical composition).
 */
export function scopeCapabilityPlanner<S, C>(
  planner: CapabilityPlanner<S, C>,
  excludedKinds: ReadonlySet<string>,
): CapabilityPlanner<S, C> {
  if (excludedKinds.size === 0) return planner;
  return {
    plan(state: S, context: C): Plan {
      const base = planner.plan(state, context);
      const allowedIntents = base.allowedIntents.filter(
        (kind) => !excludedKinds.has(kind),
      );
      if (allowedIntents.length === base.allowedIntents.length) return base;
      return { ...base, allowedIntents };
    },
  };
}

/**
 * Wrap a ChannelDriver so an out-of-scope PARKED envelope is invisible to its
 * `matchToParked` resume matcher — the defense-in-depth half of the WhatsApp
 * verb scope. `matchToParked` is a PURE read of `session.pendingConfirmations`;
 * we hand the underlying matcher a session whose parks are filtered to the
 * in-scope kinds, so an affirmative reply ("sim") on this ingress can only
 * resume a park this ingress is allowed to propose in the first place. A money
 * confirm parked from the dashboard therefore stays parked when someone types
 * "sim" over WhatsApp — the dashboard can still resume it (its own scope
 * excludes nothing). Only `matchToParked` is decorated; every other driver
 * method (perceive / render / attest) delegates VERBATIM. An empty exclusion
 * returns the driver unchanged.
 */
export function scopeResumeChannel(
  channel: ChannelDriver,
  excludedKinds: ReadonlySet<string>,
): ChannelDriver {
  if (excludedKinds.size === 0) return channel;
  return {
    kind: channel.kind,
    perceive: (raw) => channel.perceive(raw),
    render: (response) => channel.render(response),
    attest: (envelope) => channel.attest(envelope),
    matchToParked: (channelEvent: ChannelMessage, session: Session): ParkedMatch | null => {
      const parks = session.pendingConfirmations;
      const inScope = parks.filter(
        (park) => !excludedKinds.has(String(park.envelope.kind)),
      );
      // Fast path: nothing filtered ⇒ delegate the original session untouched.
      if (inScope.length === parks.length) {
        return channel.matchToParked(channelEvent, session);
      }
      return channel.matchToParked(channelEvent, {
        ...session,
        pendingConfirmations: inScope,
      });
    },
  };
}
