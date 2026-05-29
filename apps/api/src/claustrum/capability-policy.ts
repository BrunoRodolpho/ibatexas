/**
 * Capability PolicyBundle resolution — RC-A1 Stage 2 (Phase A.2).
 *
 * The kernel's `adjudicate(envelope, state, policy)` takes ONE PolicyBundle,
 * but the ibatexas commerce surface spans several first-party packs, each
 * shipping its own domain PolicyBundle (orders, payments, reservations,
 * customer-onboarding, whatsapp). Two consumers need a policy resolved by the
 * envelope's intent `kind`:
 *
 *   1. The cognitive loop (chat / WhatsApp) submits via `capsule.adjudicate`,
 *      which closes over a SINGLE `resolution.policy` fixed at capsule-open —
 *      before the planner has chosen a kind. That single policy must therefore
 *      be a *router* that dispatches each kind to its owning pack's guards.
 *      `composePolicyRouter` builds it.
 *
 *   2. Explicit HTTP routes (order-actions, cart, admin/*) build a concrete
 *      envelope up front and pass `policy` to `runCustomerIntent` per call — so
 *      they can resolve the specific owning bundle directly.
 *      `resolveCapabilityPolicy` does that lookup.
 *
 * Both fail CLOSED for an unknown kind: the router's taint floor is SYSTEM
 * (rank 3 — nothing UNTRUSTED/TRUSTED can propose it) and its `default` is
 * REFUSE, so an envelope whose kind no installed pack owns can never reach
 * EXECUTE. This mirrors the audited bridge's fail-closed posture
 * (`isWellFormedPolicyBundle` + `safeAuditedAdjudicate` in claustrum-bootstrap).
 *
 * Pure + dependency-injected: packs are passed in, never imported here, so the
 * module is unit-testable with hand-built fixtures and carries no dependency on
 * the (not-yet-workspace-wired) `@ibatexas/pack-*` packages. The composition
 * root (`claustrum-bootstrap`) supplies the real packs once they are wired.
 */

import type { Decision, IntentEnvelope, Taint } from "@adjudicate/core";
import type { Guard, PolicyBundle } from "@adjudicate/core/kernel";

/**
 * Structural subset of a first-party Pack that policy resolution needs. A real
 * `PackV0` (from `@ibatexas/pack-orders` et al.) satisfies this by structure;
 * heterogeneous packs are stored at `PolicyBundle<string, unknown, unknown>` so
 * one registry can hold orders + payments + reservations + … together.
 */
export interface CapabilityPolicyPack {
  /** Pack id, e.g. "ibatexas/pack-orders" — used for diagnostics + collisions. */
  readonly id: string;
  /** The intent kinds this pack owns (its wire contract). */
  readonly intents: ReadonlyArray<string>;
  /** The pack's domain PolicyBundle. */
  readonly policy: PolicyBundle<string, unknown, unknown>;
}

type GuardCategory = "stateGuards" | "authGuards" | "business";

/** The most restrictive taint floor — used for kinds no installed pack owns. */
const UNKNOWN_KIND_TAINT_FLOOR: Taint = "SYSTEM";

/**
 * Build a `kind -> pack` index, asserting no two packs claim the same intent
 * kind. A collision is a packaging error (two packs both authoritative for one
 * mutation) and must fail loudly at composition time, not silently let the last
 * writer win and route mutations to the wrong guards.
 */
function indexByKind(
  packs: ReadonlyArray<CapabilityPolicyPack>,
): ReadonlyMap<string, CapabilityPolicyPack> {
  const index = new Map<string, CapabilityPolicyPack>();
  for (const pack of packs) {
    for (const kind of pack.intents) {
      const existing = index.get(kind);
      if (existing !== undefined && existing.id !== pack.id) {
        throw new Error(
          `capability-policy: intent kind "${kind}" is claimed by both ` +
            `"${existing.id}" and "${pack.id}". Each kind must be owned by ` +
            `exactly one pack.`,
        );
      }
      index.set(kind, pack);
    }
  }
  return index;
}

/**
 * Resolve the concrete PolicyBundle that owns `kind`, or `null` if no installed
 * pack claims it. HTTP routes that already hold a built envelope use this to
 * pass the precise bundle to `runCustomerIntent`.
 */
export function resolveCapabilityPolicy(
  packs: ReadonlyArray<CapabilityPolicyPack>,
  kind: string,
): PolicyBundle<string, unknown, unknown> | null {
  return indexByKind(packs).get(kind)?.policy ?? null;
}

/**
 * Compose a single kind-dispatching PolicyBundle over every installed pack.
 *
 * Each guard category (state, auth, business) collapses to ONE delegating guard
 * that looks up the envelope's owning pack and runs that pack's guards for the
 * category in order, returning the first non-null Decision (kernel guard
 * semantics: `null` = "no opinion, continue"). The cross-category evaluation
 * order (state → taint → auth → business) is preserved by the kernel, which
 * runs our three category slots in that order with the taint gate between state
 * and auth.
 *
 * Per-pack `default`: every first-party pack ships `default: "REFUSE"`
 * (Refusal-by-Design), so a router that also defaults REFUSE reproduces each
 * pack's all-guards-null outcome exactly. We assert that invariant up front —
 * a future pack that defaults EXECUTE would need the router to apply defaults
 * per-kind, and we want that to fail loudly at boot rather than silently let
 * the blanket REFUSE override a legitimate execute-by-default.
 *
 * Unknown kinds: every delegating guard returns null, the taint floor is SYSTEM,
 * and `default` is REFUSE — so an unowned kind fails closed.
 */
export function composePolicyRouter(
  packs: ReadonlyArray<CapabilityPolicyPack>,
): PolicyBundle<string, unknown, unknown> {
  const nonRefuse = packs.filter((p) => p.policy.default !== "REFUSE");
  if (nonRefuse.length > 0) {
    throw new Error(
      `capability-policy: composePolicyRouter assumes every pack defaults ` +
        `REFUSE, but [${nonRefuse.map((p) => p.id).join(", ")}] default ` +
        `EXECUTE. Extend the router to apply per-pack defaults by kind before ` +
        `composing an execute-by-default pack.`,
    );
  }

  const index = indexByKind(packs);

  const delegate =
    (category: GuardCategory): Guard<string, unknown, unknown> =>
    (
      envelope: IntentEnvelope<string, unknown>,
      state: unknown,
    ): Decision | null => {
      const pack = index.get(envelope.kind);
      if (pack === undefined) return null;
      for (const guard of pack.policy[category]) {
        const decision = guard(envelope, state);
        if (decision !== null) return decision;
      }
      return null;
    };

  return {
    stateGuards: [delegate("stateGuards")],
    authGuards: [delegate("authGuards")],
    business: [delegate("business")],
    taint: {
      minimumFor(kind: string): Taint {
        const pack = index.get(kind);
        return pack === undefined
          ? UNKNOWN_KIND_TAINT_FLOOR
          : pack.policy.taint.minimumFor(kind);
      },
    },
    default: "REFUSE",
  };
}
