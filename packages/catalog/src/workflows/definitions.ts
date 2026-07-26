/**
 * The AUTHORED workflow corpus.
 *
 * # What lives here
 *
 * Workflows the production catalog declares, and therefore workflows the
 * runtime will offer to real customers. Everything in this array is a
 * customer-facing conversational route and gets reviewed as one — which is why
 * LE2-020 shipped the runtime with this file EMPTY and proved itself against
 * `FIXTURE_WORKFLOWS` instead, rather than authoring an un-reviewed route under
 * a runtime ticket. LE2-021 authors the first entry.
 *
 * # What an entry costs, structurally
 *
 * Adding one is not free, and the costs are the point:
 *
 *   1. `advertise` starts returning a non-empty surface, so `buildToolSurface`
 *      adds a `start_workflow` tool and the WIRE CHANGES. Every parse made
 *      under the old surface becomes unreachable through the L1 cache, by
 *      construction (the cache key digests the tool array).
 *   2. `installWorkflowRuntime` wraps the entry's ANCHOR tool, so that
 *      capability's dispatch path grows a branch — inert for any turn without
 *      an instance, which is what makes wrapping a live capability safe.
 *   3. `registerWorkflowScopedTools` registers a handler for every
 *      workflow-scoped kind the entry invokes, and THROWS at composition time
 *      for one that has none.
 *
 * # Ordering
 *
 * Declaration order is the order the selection surface lists them in. It is
 * authored, not sorted: the surface is read top-down by a model, and the
 * catalogue's order is part of what a live drive measures.
 */

import type { WorkflowDefinition } from "./types.js"

/** The reorder-last workflow's id — exported so nothing re-spells the string. */
export const REORDER_LAST_WORKFLOW_ID = "workflow.orders.reorder-last"

/**
 * REORDER-LAST — LE2-021, the first customer-facing workflow.
 *
 * *"repete meu último pedido"* → the customer is shown WHAT they are about to
 * re-buy and its total, and only on their "sim" is the cart rebuilt from the
 * previous order. A customer with no order history is told so honestly and
 * nothing runs.
 *
 * ── THE ANCHOR, AND WHY IT IS A NEW KIND ─────────────────────────────────────
 *
 * `order.reorder.request` exists because nothing already in `pack-orders` could
 * carry this confirm. `order.checkout.create` — the fixture's anchor — is
 * actively harmful here: the anchor tool runs BEFORE the activity sequence, so
 * anchoring on checkout would create a checkout for the CURRENT cart and then
 * abandon it by building a different one; and on the common empty-cart reorder
 * path `requireCartItemsForCheckout` REFUSEs first, making the workflow
 * unreachable exactly when it is wanted. `order.cart.ensure` is the honest first
 * act, but `executeCartOps` returns EXECUTE unconditionally, so it never parks —
 * the "decline → nothing executes" guarantee would be unreachable rather than
 * merely unproven.
 *
 * So the ASK and the ACT are two kinds: `order.reorder.request` (this anchor,
 * parse-reachable, carrying `confirmReorderLast`) and `order.reorder` (the
 * activity, workflow-scoped, unreachable from any parse).
 *
 * ── WHERE THE NUMBERS IN THE CONFIRM COME FROM ───────────────────────────────
 *
 * Not from here, and not from the model. `confirmReorderLast` in
 * `@ibatexas/pack-orders` authors the sentence from `OrderState.ctx` fields the
 * host projected out of an OWNER-SCOPED `OrderProjection` read, and the confirm
 * template below quotes that sentence VERBATIM through `{confirmation}`. The
 * workflow layer never re-derives money, never sees an order id, and has no
 * placeholder that could carry one.
 *
 * ── WHY IT HAS NO PARAMS ─────────────────────────────────────────────────────
 *
 * `params: []` is the strongest statement this file can make. The one value the
 * route needs — WHICH order — has no admissible source in the two-member
 * `WorkflowParamSource` union: no registry claim type carries an order id
 * (`ORDER_HISTORY`'s validated value is a pre-composed summary STRING), and a
 * slot would be model-EXTRACTED, which for an identifier is precisely the
 * confabulation that union exists to prevent. It is resolved executor-side from
 * owner-scoped state instead, so it is never a value anything upstream of the
 * database could have authored.
 *
 * ── WHY ONE ACTIVITY ─────────────────────────────────────────────────────────
 *
 * `order.reorder`'s handler POSTs a brand-new `/store/carts` and re-adds the
 * line items there, so a preceding `order.cart.ensure` would build a cart the
 * next step immediately abandons. And checkout is deliberately NOT an activity:
 * the ticket's own words are that the customer "lands in the standard checkout
 * flow", so the run ends with a rebuilt cart and the `completed` template hands
 * off. Folding checkout in would take a second, unasked money decision behind
 * the one confirmation the customer gave.
 */
export const REORDER_LAST_WORKFLOW: WorkflowDefinition = {
  id: REORDER_LAST_WORKFLOW_ID,
  title: "Repetir o último pedido",
  description:
    "Repetir o último pedido do cliente: monta um carrinho novo com os mesmos itens do pedido anterior, depois de confirmar com ele.",
  // PROVENANCE (the LE2-033 discipline; legend in
  // `../capability-definitions/definitions.ts`). Exactly ONE is grounded: 602
  // distinct production rows carry a single genuine reorder utterance.
  // Everything else is authored — plausible pt-BR with no external grounding,
  // FLAGGED FOR OWNER REVIEW AS A BODY. No phrasing is drawn from
  // `packages/journeys/extraction-corpus` or the extraction-eval fixtures; that
  // corpus is LE2-008's gate and authoring against it would test-fit the
  // measurement. None carries PII, and none is an allergen or dietary
  // disclosure — the conversation projection's safety boundary applies here for
  // exactly the same reason it applies there.
  //
  // Authored strongest-evidence-first: the surface truncates from the end.
  triggerPhrasings: [
    {
      phrasing: "repete meu último pedido",
      provenance: "production-utterance",
      why: "the only genuine reorder utterance among 602 distinct production rows",
    },
    {
      phrasing: "refaz meu último pedido",
      provenance: "authored",
      why: "the ticket's own headline phrasing; 'refazer' is the verb the legacy tool description uses",
    },
    {
      phrasing: "quero pedir a mesma coisa da última vez",
      provenance: "authored",
      why: "desiderative register — a different neighbourhood of the embedding space from the imperatives",
    },
    {
      phrasing: "faz o mesmo pedido de novo",
      provenance: "authored",
      why: "imperative that never says 'último', the word the description leans on",
    },
    {
      phrasing: "quero repetir a última compra",
      provenance: "authored",
      why: "'compra' rather than 'pedido' — the noun a customer may reach for first",
    },
    {
      phrasing: "bota tudo do meu último pedido no carrinho",
      provenance: "authored",
      why: "names the OUTCOME (a filled cart) rather than the act",
    },
    {
      phrasing: "manda o de sempre",
      provenance: "authored",
      why: "the pure-idiom case, naming neither 'pedido' nor 'repetir'. Measured at 0/5 selection on a description-only surface, so it is the phrasing this whole field exists for — and the honest test of whether it helps",
    },
  ],
  // CONJUNCTIVE, and both conjuncts NARROW. `order.cart.ensure` is the
  // always-proposable cart floor: without it the turn has no cart surface at all
  // and rebuilding one is meaningless. `order.checkout.create` is the
  // AUTHENTICATION conjunct — it is the orders planner's `if (isAuthenticated)`
  // branch, and it is in the roster whether or not the cart is empty (the
  // empty-cart REFUSE is a guard, not a planner decision, so this does NOT gate
  // the workflow on having a cart). Offering a reorder to a guest would
  // advertise a route whose anchor must REFUSE at `requireAuthenticated`, which
  // teaches a customer that the system offers things it will not do.
  matchers: [{ capability: "order.cart.ensure" }, { capability: "order.checkout.create" }],
  selection: { capability: "order.reorder.request" },
  params: [],
  activities: [
    {
      id: "reorder",
      capability: "order.reorder",
      // EMPTY, deliberately — see the module doc on why the order id is not a
      // param. The workflow-scoped handler resolves it from the same
      // owner-scoped projection that grounded the confirm sentence.
      payload: {},
    },
  ],
  confirm: { template: "confirm" },
  templates: [
    // `{confirmation}` is the KERNEL's own sentence — the one `confirmReorderLast`
    // authored from projected state, naming the items and the total. Quoted
    // verbatim and ALONE: prose added around it would be a second voice in the
    // same breath as the grounded one, and the customer would have no way to
    // tell which half had been checked.
    { id: "confirm", text: "{confirmation}" },
    {
      id: "completed",
      text: "Pronto! Montei um carrinho novo com os itens do seu último pedido. Quer finalizar?",
    },
    { id: "declined", text: "Tudo bem, não repeti nada. É só me chamar quando quiser." },
    {
      id: "failed",
      text: "Não consegui montar o carrinho com os itens do seu último pedido. Já chamei alguém da equipe para te ajudar.",
    },
  ],
  outcomes: { completed: "completed", declined: "declined", failed: "failed" },
}

/**
 * Every workflow the production catalog declares. See the module doc for what
 * an entry costs structurally.
 */
export const WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [REORDER_LAST_WORKFLOW]
