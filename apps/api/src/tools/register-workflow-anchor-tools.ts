// WORKFLOW ANCHOR tool handlers (LE2-021).
//
// A workflow's SELECTION capability — its governance anchor — is dispatched like
// any other capability once the kernel EXECUTEs it, so it must have a registered
// tool: `installWorkflowRuntime` throws for one that does not, because a
// workflow anchored on an undispatchable kind would confirm with the customer
// and then fail.
//
// Most anchors need nothing from this module. A workflow anchored on an
// ordinary chat capability (the LE2-020 fixture anchors on
// `order.checkout.create`) already has its tool in
// `register-ibatexas-tool-packs.ts`, and this module leaves it alone.
//
// ── WHY THE REORDER ANCHOR IS NOT IN THE MAIN ROSTER ─────────────────────────
//
// `IBATEXAS_TOOLS` is the LLM-CALLABLE roster: `CHAT_DRIVABLE_TOOL_KINDS`
// mirrors it, the journey gates consume that mirror, and
// `chat-drivable-roster-drift.test.ts` pins the two set-equal in both
// directions. Every member is a kind the model can name inside `express_intent`.
//
// `order.reorder.request` is not such a kind and must not become one. The model
// never names it: it calls `start_workflow`, and the runtime mints the anchor
// envelope. Putting it in the main roster would either (a) force it to chat tier
// so the mirror could contain it, which would publish conversation triggers, a
// description and a refusal code for a capability nothing can ever select, or
// (b) leave it identity-tier in the roster and break the mirror invariant
// outright. Both trade a true statement for a convenient one.
//
// So anchors follow the shape `register-workflow-scoped-tools.ts` already
// established for activity handlers: DERIVED FROM THE LOADED CORPUS. A
// workflow-anchor tool exists exactly when a loaded workflow anchors on it, a
// composition loading no workflow registers nothing, and the LLM-callable roster
// is untouched — which keeps "registered" and "chat-drivable" two different
// facts instead of one conflated one.

import type { WorkflowSelectionAnchor } from "@ibatexas/catalog";
import type { ToolDefinition, ToolRegistry } from "@claustrum/core";
import type { CapabilityId, IntentKind } from "@claustrum/core";

/**
 * THE ONE EXECUTOR EVERY MINTED ANCHOR GETS — and the must-THROW invariant, held
 * once instead of restated per anchor.
 *
 * ── WHY IT DOES NOTHING ──────────────────────────────────────────────────────
 *
 * Reaching this executor MEANS the customer approved the workflow: the kernel
 * parked the anchor envelope on the guard's REQUEST_CONFIRMATION and only a
 * resumed, receipt-bearing adjudication returns EXECUTE. (Or — the paid-cancel
 * case — the guard deliberately said nothing and `executeW5Kinds` let the anchor
 * through on the selecting turn, which is a considered absence of a question, not
 * an absence of consideration.) Either way the approval is the WHOLE content of
 * the act. Everything that MOVES happens in the workflow's activity sequence,
 * which `installWorkflowRuntime`'s wrapper runs immediately after this returns —
 * each step adjudicated individually, writing its own audit row.
 *
 * Giving an anchor work to do would be actively wrong, not merely redundant, and
 * the three shipped anchors each show a sharper version of why:
 *
 *   - REORDER — `order.reorder`'s handler POSTs a brand-new `/store/carts`, so
 *     any cart minted here would be abandoned one step later.
 *   - COUPON SWAP — the route's first activity CANCELS THE ORDER, through the
 *     kernel, with its own audit row and its own declared compensator. A cancel
 *     riding the anchor's EXECUTE would be an ungoverned money act, invisible to
 *     the per-activity trace and unreachable by the compensation machinery that
 *     exists to undo exactly it.
 *   - PAID CANCEL — worse still: the anchor runs BEFORE the activity, so the
 *     activity's `gatePaidCancel` would adjudicate an order that was already
 *     cancelled and the escalate band would evaluate against a fait accompli.
 *
 * ── AND WHY IT CANNOT FAIL SOFTLY ────────────────────────────────────────────
 *
 * The wrapper spreads this result and then OVERWRITES `message` with the outcome
 * template, so a soft `{success: false, message}` returned here would be SILENTLY
 * DISCARDED and the customer would read "Pronto, cancelei seu pedido" over a
 * failed anchor. A trivial executor has no failure mode to express, which is the
 * safest way to hold that property — but it is a property held DELIBERATELY, so
 * any future anchor work must THROW rather than return a failure shape.
 *
 * Since R6-S3 that is one property of one function rather than three parallel
 * comments over three byte-identical constants: every minted anchor carries THIS
 * reference, and a test asserts so for every anchor in the loaded corpus. Making
 * this executor do work — or return a failure shape — breaks every anchor at
 * once, loudly, which is the correct blast radius for a decision this load-bearing.
 */
export const WORKFLOW_ANCHOR_NO_OP = (): Promise<{ readonly approved: true }> =>
  // The port is async and the anchor has nothing to await, so the promise is
  // constructed rather than awaited — `async () => …` would trip `require-await`
  // for describing a real property of this executor.
  Promise.resolve({ approved: true } as const);

/**
 * The RISK of an anchor, which is `"low"` for every anchor and always will be.
 *
 * Not a judgement about the route — reorder replaces a cart, coupon-swap and
 * paid-cancel cancel real orders — but about THIS TOOL, which moves nothing. The
 * route's risk lives on the activity capabilities (`order.reorder`,
 * `order.cancel`), where the kernel actually adjudicates it against the full
 * money ladder. Declaring an anchor `"high"` would double-count a risk already
 * priced one step later, on the step that bears it.
 */
const ANCHOR_RISK_LEVEL = "low" as const;

/**
 * The tool id for an anchor kind — MECHANICAL, and the only field of a minted
 * anchor that is derived rather than authored or fixed.
 *
 * `order.coupon.swap.request` -> `ibatexas.order.couponSwapRequest.v1`: the head
 * segment stays, the tail becomes one camelCase word. It reproduces all three
 * hand-written ids byte-for-byte (the R6-S3 registration diff is the proof), and
 * it is derivation rather than declaration because an id is an identifier the
 * kind already determines — authoring it would be offering a reviewer a choice
 * whose only wrong answers are typos.
 *
 * Note this is NOT the main roster's convention, which is genuinely irregular
 * (`order.cart.add` -> `ibatexas.cart.addItem.v1`). It does not need to be: an
 * anchor is never advertised to the model and never named in a parse, so its id
 * is an internal registry key, and regularity buys more here than familiarity.
 */
export function workflowAnchorToolId(capability: string): string {
  const [head, ...tail] = capability.split(".");
  const camel = tail
    .map((part, index) =>
      index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
  return `ibatexas.${head}${camel === "" ? "" : `.${camel}`}.v1`;
}

/**
 * MINT the standard no-op handler for one corpus anchor.
 *
 * Every field is mechanical except `description`, which is AUTHORED pt-BR read
 * off the workflow's own selection declaration (`selection.anchorDescription` in
 * `@ibatexas/catalog`). That asymmetry is the point of the factory: the shape of
 * an anchor is a fact about the ASK/ACT split and belongs in code, while the
 * sentence describing a business act is catalog data (Hard Rule #4) and belongs
 * next to the workflow that means it.
 *
 * A MISSING OR BLANK DESCRIPTION THROWS, naming the workflow and the field. It
 * is not defaulted to a template, and that refusal is the whole conscious-
 * authoring act: minting is cheap enough that an author who never thinks about
 * this anchor would otherwise get a working one for free, described by a sentence
 * nobody chose, for a capability whose approval IS the customer-facing act.
 */
export function mintWorkflowAnchorTool(
  anchor: WorkflowSelectionAnchor,
): ToolDefinition<unknown, unknown> {
  const description = anchor.description;
  if (description === undefined || description.trim() === "") {
    throw new Error(
      `[workflow] the workflow "${anchor.workflowId}" is anchored on ` +
        `"${anchor.capability}", which the main tool roster does not carry, so its ` +
        "handler must be minted here — but the workflow declares no " +
        "`selection.anchorDescription`. The anchor's description is the one " +
        "AUTHORED field of a minted handler and is never defaulted: a template " +
        "would describe a customer-facing approval in a sentence nobody chose. " +
        "Add `selection.anchorDescription` (pt-BR) to the workflow in " +
        "@ibatexas/catalog, or anchor it on a capability the roster already owns.",
    );
  }
  return {
    id: workflowAnchorToolId(anchor.capability),
    capability: anchor.capability as CapabilityId,
    // `capability === intentKind` — the roster-wide invariant, held here too even
    // though an anchor is deliberately off the LLM-callable roster.
    intentKind: anchor.capability as IntentKind,
    description,
    inputSchema: {},
    outputSchema: {},
    riskLevel: ANCHOR_RISK_LEVEL,
    execute: WORKFLOW_ANCHOR_NO_OP,
  };
}

/**
 * Register anchor handlers for the selection capabilities a loaded corpus uses
 * and the main roster does not already cover.
 *
 * Call BEFORE `installWorkflowRuntime`, which asserts every anchor is
 * dispatchable and throws otherwise. Registering an anchor the main roster
 * already owns is skipped rather than overwritten — the registry is
 * last-write-wins, so shadowing a real capability's real handler with a stub
 * would silently replace the anchor ACT with a no-op.
 *
 * ── WHAT R6-S3 CHANGED, AND WHAT IT DELIBERATELY DID NOT ────────────────────
 *
 * Before: three hand-written constants and a hand-written map from kind to
 * constant. An author who added a fourth workflow and forgot the map entry got
 * the boot throw below — discovery by wall.
 *
 * Now: any corpus anchor the roster does not cover is MINTED. That does not make
 * anchors free, because minting requires the workflow to have AUTHORED
 * `selection.anchorDescription`, and `mintWorkflowAnchorTool` throws when it has
 * not. So the forgettable step moved from "add a map entry in apps/api" to
 * "declare the sentence next to the workflow you are already writing" — the same
 * fail-closed guarantee, on the field that actually needed a human.
 */
export function registerWorkflowAnchorTools(
  tools: ToolRegistry,
  anchors: Iterable<WorkflowSelectionAnchor>,
): void {
  for (const anchor of anchors) {
    if (tools.hasCapability(anchor.capability)) continue;
    tools.register(mintWorkflowAnchorTool(anchor));

    // ── THE WALL, NOW UNREACHABLE — AND KEPT ANYWAY ─────────────────────────
    //
    // This is LE2-021's boot throw, narrowed to what it always MEANT: no anchor
    // leaves this function undispatchable. Its old cause (a corpus anchor with
    // no hand-map entry) cannot occur now — the line above either minted a
    // handler or threw naming the workflow — so nothing in the test suite drives
    // this branch, and `factory-coverage.test.ts` asserts the absence of that
    // cause directly, over the real corpus, which is what replaced its discovery
    // role.
    //
    // Deleting it would still be wrong. The property it states is about the
    // REGISTRY, not about this module's bookkeeping: `installWorkflowRuntime`
    // runs next and will wrap whatever `list()` returns for this capability, and
    // a customer who confirms a workflow whose anchor cannot dispatch is exactly
    // the failure both throws exist to keep out of production. A wall that costs
    // two lines and stands where a confirmed multi-step run would otherwise fail
    // is worth keeping unreachable.
    if (!tools.hasCapability(anchor.capability)) {
      throw new Error(
        `[workflow] a loaded workflow is anchored on "${anchor.capability}", which ` +
          "has no registered tool even after its anchor handler was minted. The " +
          "anchor is dispatched like any other capability, so an unregistered one " +
          "would confirm with the customer and then fail at dispatch. Register the " +
          "tool, or anchor the workflow on a kind that has one.",
      );
    }
  }
}
