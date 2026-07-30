// turn-context.ts — the ONE owner of "which per-turn AMBIENT CONTEXTS does this
// ingress open around its turn, in what nesting, and when do they close?" (R4-S2).
//
// Three independent per-turn contexts exist, each solving the same shape of
// problem — a value that belongs to ONE turn, needed by code the turn cannot pass
// an argument to — and each with its own module:
//   - WIRE TRUTH (wire-capture.ts) — an AsyncLocalStorage bucket the Ollama relay
//     pushes every wire exchange it makes into.
//   - THE WORKFLOW TURN BINDING (workflow/workflow-turn.ts) — an
//     AsyncLocalStorage binding carrying `{turnId, channel}` for the kernel
//     decision observer.
//   - THE FUNNEL CONTEXT (funnel-tier.ts) — a turnId-keyed publish of the one
//     fact L0 cannot see from inside the loop (is a confirmation parked?).
//
// Before this module the CHOREOGRAPHY over those three was hand-assembled at five
// production ingresses with three different subsets, the ordering invariant
// restated in comments at each site, and the confirm-window fact derived in two
// spellings at two of them. The composition now lives here once: an ingress
// DECLARES its subset and hands over the `handleTurn` thunk.
//
// ── THE NESTING (documented ONCE, here) ─────────────────────────────────────
// Outermost to innermost, which is also open order:
//   1. FUNNEL PUBLISH — `openFunnelTurn(turnId, {confirmWindowOpen})`. Not a
//      wrapper (it is a keyed map write), so it must happen BEFORE the wrappers
//      and its close must be guaranteed on every exit — hence the single
//      `finally` below, the only close in this module that is not an ALS unwind.
//   2. WIRE CAPTURE — `beginWireTurn`.
//   3. THE WORKFLOW BINDING — `beginWorkflowTurn({turnId, channel})`.
//   4. the thunk (`handleTurn`).
// Both wrappers are AsyncLocalStorage, so their close IS the thunk settling —
// there is nothing to unwind by hand and nothing that can leak on a throw. Only
// the funnel publish needs an explicit close, and it gets exactly one.
//
// Wire is OUTSIDE workflow rather than the reverse because that is the shipped
// order at both customer ingresses; the two contexts are independent (neither
// reads the other) so the order is a pin, not a dependency, and it is pinned so a
// future third wrapper has a stated place to go.
//
// ── LIFETIME NOTE — the one ordering detail that MOVED ─────────────────────
// Pre-extraction, both customer ingresses called `closeFunnelTurn` in the OUTER
// ingress `finally` — i.e. after their post-turn delivery work (chunk push,
// history append, incident classify/open), immediately before
// `conductor.closeCapsule`. Here it closes when the TURN settles, so the funnel
// context's lifetime is narrowed to the turn itself.
//
// That is unobservable: every reader of the per-turn funnel state runs INSIDE
// `handleTurn` — the planner's `claim()` (ibatexas-planner.ts), the responder's
// `stageFor()` (ibatexas-responder.ts), and the once-per-turn tier attribution on
// the conductor `turn` log line (claustrum-bootstrap.ts's `emitTurn`, which the
// conductor calls inside the turn). No ingress reads it after the turn. The
// ordering that IS load-bearing — funnel close BEFORE `closeCapsule` — still
// holds: this module's `finally` runs before the ingress `finally` that closes
// the capsule.
//
// ── THE SUBSETS (declared config, see TURN_CONTEXT_SUBSETS) ────────────────
//   - `customer-full` (routes/chat.ts, routes/whatsapp-webhook.ts) — all three.
//   - `wire-only` (ops/ops-whatsapp-ingress.ts, routes/admin/ops-chat.ts,
//     claustrum/live-agent-conductor.ts) — wire truth ONLY. Both omissions are
//     BY DESIGN and each cites its own record; see the declaration.
// A subset's per-turn INPUTS travel with its discriminant (the args union below),
// so `wire-only` structurally cannot be handed a turnId to bind: widening what it
// wires means widening its args, not flipping a flag.

import type { ParkedEnvelope } from "@claustrum/core";
import type { FunnelTurnContext } from "./funnel-tier.js";
import { closeFunnelTurn, openFunnelTurn } from "./funnel-tier.js";
import { beginWireTurn } from "./wire-capture.js";
import type { WorkflowTurnBinding } from "./workflow/workflow-turn.js";
import { beginWorkflowTurn } from "./workflow/workflow-turn.js";

// ── Subset declarations ──────────────────────────────────────────────────────

/** The declared per-turn context subsets. One per INGRESS SHAPE, not per surface. */
export type TurnContextSubset = "customer-full" | "wire-only";

/**
 * What one subset wires. Declared adapter config — {@link runTurnWithContexts}
 * reads these flags rather than restating the composition per subset, so a
 * context this table omits is omitted in the code path too.
 */
export interface TurnContextSubsetDeclaration {
  readonly name: TurnContextSubset;
  /** Wire-truth capture (wire-capture.ts). */
  readonly wire: boolean;
  /** The workflow turn binding (workflow/workflow-turn.ts). */
  readonly workflow: boolean;
  /** The funnel per-turn context publish (funnel-tier.ts). */
  readonly funnel: boolean;
  /**
   * Why each omitted context is omitted, citing the record that makes the
   * omission a decision. EMPTY for a subset that omits nothing — an omission
   * without an entry here is the thing this field exists to prevent.
   */
  readonly omissions: readonly string[];
}

export const TURN_CONTEXT_SUBSETS: Readonly<
  Record<TurnContextSubset, TurnContextSubsetDeclaration>
> = {
  /**
   * The customer conversational planes (web chat + WhatsApp webhook): all three
   * contexts. These are the only ingresses whose conductor composition wires the
   * funnel seam at all (claustrum-bootstrap.ts:3729-3736), and the only ones that
   * can see a parked confirmation to derive the confirm window from.
   */
  "customer-full": {
    name: "customer-full",
    wire: true,
    workflow: true,
    funnel: true,
    omissions: [],
  },
  /**
   * The ops planes (WhatsApp ingress + admin dashboard) and the managed-agent
   * conductor: wire truth ONLY.
   *
   * Wire truth is wired everywhere because NOT wrapping is the lossy option, not
   * the neutral one: an exchange captured outside a context is dropped by design
   * (wire-capture.ts:25-26), so an unwrapped turn silently has no wire record.
   */
  "wire-only": {
    name: "wire-only",
    wire: true,
    workflow: false,
    funnel: false,
    omissions: [
      // workflow-turn.ts:37-43 — "FAIL-CLOSED OUTSIDE A TURN".
      "workflow binding: `currentWorkflowTurnId()` returns undefined for an unbound " +
        "caller, the decision observer records nothing, and the workflow renders its " +
        "template without a quoted confirm sentence. workflow-turn.ts:37-43 names the " +
        "ops plane as exactly that correct degrade — an unbound caller loses a quote, " +
        "it never inherits someone else's.",
      // funnel-tier.ts:334-337 — decideL0's "FAIL-CLOSED ON A MISSING CONTEXT".
      "funnel context: an unpublished context is not \"no park\", it is \"nobody told " +
        "us\", so `decideL0` stands down and the turn takes the normal model path " +
        "(funnel-tier.ts:334-337, which names the ops and agent planes). These " +
        "compositions also omit the planner/responder `funnel` seam outright " +
        "(claustrum-bootstrap.ts:3730-3736), so a publish here would be inert as well " +
        "as unwanted: L0 is a customer-plane decision and the ops small-talk posture " +
        "is its own ratified surface.",
    ],
  },
};

// ── The confirm-window derivation (ONE spelling) ─────────────────────────────

/**
 * Is this turn's confirm window OPEN — i.e. does the session hold at least one
 * pending confirmation?
 *
 * The single spelling of a fact that was derived at two customer ingresses. Takes
 * the park LIST rather than the capsule on purpose: routes/chat.ts reads
 * `capsule.loadedSession?.pendingConfirmations` ONCE, before its park-reply
 * triage, and the funnel must see THAT reading — "the same park set that just
 * failed to match" — so the read point stays the ingress's to choose.
 *
 * FE-D32 (ratified): while a confirm window is open, L0 must not fire AT ALL —
 * the restate-then-confirm path and the conductor's `matchToParked` own every
 * reply in that window. `undefined` (no loaded session, or no park array) is
 * FALSE, which is the honest reading of "this session has no pending
 * confirmation"; absence of the publish altogether is the fail-closed case and is
 * funnel-tier.ts's business, not this predicate's.
 */
export function deriveConfirmWindowOpen(
  pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined,
): boolean {
  return (pendingConfirmations?.length ?? 0) > 0;
}

// ── The composition ─────────────────────────────────────────────────────────

interface TurnThunk<T> {
  /**
   * The `handleTurn` invocation. Exactly what the contexts must cover — and
   * nothing the ingress does AFTER the turn (delivery, history, incidents), which
   * stays outside so the contexts' lifetime is the turn's.
   */
  readonly thunk: () => Promise<T>;
}

/** The `customer-full` inputs: everything its three contexts need. */
export interface CustomerFullTurnArgs {
  readonly subset: "customer-full";
  /** `capsule.turnId` — the key for BOTH the funnel publish and the binding. */
  readonly turnId: string;
  /** `capsule`'s channel ("web" / "whatsapp"). Feeds real guards through the
   *  binding — see WorkflowTurnBinding's note on why it is not cosmetic. */
  readonly channel: string;
  /** The session's parked confirmations, as the ingress read them. */
  readonly pendingConfirmations: ReadonlyArray<ParkedEnvelope> | undefined;
}

/** The `wire-only` inputs: none. See the subset declaration for why. */
export interface WireOnlyTurnArgs {
  readonly subset: "wire-only";
}

export type RunTurnWithContextsArgs<T> =
  | (CustomerFullTurnArgs & TurnThunk<T>)
  | (WireOnlyTurnArgs & TurnThunk<T>);

/** The per-turn facts each OPTIONAL context needs, present iff it is applied. */
interface AppliedTurnContexts<T> {
  readonly wire: boolean;
  readonly workflow: WorkflowTurnBinding | undefined;
  readonly funnel:
    | { readonly turnId: string; readonly context: FunnelTurnContext }
    | undefined;
  readonly thunk: () => Promise<T>;
}

/**
 * Wrap the thunk in the applied contexts, INNERMOST FIRST — each wrap puts its
 * context OUTSIDE the previous one, so the sequence below reads innermost-to-
 * outermost and produces the nesting the header pins.
 *
 * Deliberately NOT `async`: a subset with no funnel returns the wire promise
 * directly, so wiring the composition adds no scheduling hop to those turns.
 */
function composeTurn<T>(applied: AppliedTurnContexts<T>): Promise<T> {
  let run = applied.thunk;

  const binding = applied.workflow;
  if (binding !== undefined) {
    const inner = run;
    run = () => beginWorkflowTurn(binding, inner);
  }

  if (applied.wire) {
    const inner = run;
    run = () => beginWireTurn(inner);
  }

  const funnel = applied.funnel;
  if (funnel !== undefined) {
    const inner = run;
    // The ONE explicit close in this module (the wrappers above unwind
    // themselves). `finally` — not a trailing statement — so a thunk that throws
    // still drops the publish, and it drops BEFORE the ingress `finally` closes
    // the capsule.
    run = async () => {
      openFunnelTurn(funnel.turnId, funnel.context);
      try {
        return await inner();
      } finally {
        closeFunnelTurn(funnel.turnId);
      }
    };
  }

  return run();
}

/**
 * INGRESS SEAM — run one conversational turn inside this ingress's DECLARED
 * per-turn context subset.
 *
 * Call AFTER `openCapsule` (every input comes from the capsule) and let the
 * ingress keep its own `finally` for `conductor.closeCapsule` — the capsule
 * outlives the turn because the ingress's post-turn delivery work does.
 */
export function runTurnWithContexts<T>(args: RunTurnWithContextsArgs<T>): Promise<T> {
  if (args.subset === "wire-only") {
    const declared = TURN_CONTEXT_SUBSETS["wire-only"];
    return composeTurn({
      wire: declared.wire,
      workflow: undefined,
      funnel: undefined,
      thunk: args.thunk,
    });
  }

  const declared = TURN_CONTEXT_SUBSETS["customer-full"];
  return composeTurn({
    wire: declared.wire,
    workflow: declared.workflow ? { turnId: args.turnId, channel: args.channel } : undefined,
    funnel: declared.funnel
      ? {
          turnId: args.turnId,
          context: {
            confirmWindowOpen: deriveConfirmWindowOpen(args.pendingConfirmations),
          },
        }
      : undefined,
    thunk: args.thunk,
  });
}
