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
      // LE2-022 — `order.reorder` is `mutating: true`, so the
      // compensation-completeness rule requires a statement here and an
      // omission is a build error.
      //
      // IRREVERSIBLE, and NOT because this is the only activity. The marker
      // states what would be true of the EFFECT if a later step ever failed
      // after it: a cart rebuilt out from under a customer is a visible change
      // and the catalog declares no capability that puts the old one back.
      // Choosing "harmless" on the grounds that nothing runs after it today
      // would be true positionally and false semantically, and the next author
      // to add a step would inherit it silently.
      compensation: {
        terminal: "irreversible",
        why: "rebuilds the session cart from a past order; the catalog declares no capability that restores the previous one",
      },
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

/** The swap-for-coupon workflow's id — exported so nothing re-spells the string. */
export const SWAP_FOR_COUPON_WORKFLOW_ID = "workflow.orders.swap-for-coupon"

/**
 * SWAP-FOR-COUPON — LE2-023, and the scenario this whole workstream was
 * stress-testing.
 *
 * *"se não der pra usar o cupom, cancela minha order, faz outra igual, e aplica
 * o cupom X1234"* — one sentence that asks for a destructive multi-step act on a
 * real, possibly-paid order. The customer is shown ONE question stating the order
 * amount, the refund consequence and the new total, and only on their "sim" does
 * the governed saga run: cancel, rebuild, apply.
 *
 * ── WHY THE PRE-CHECKS ARE THE MOST IMPORTANT PART ───────────────────────────
 *
 * Four of them, evaluated at SELECTION, before any envelope exists. Each is a way
 * the confirm sentence could otherwise be a lie, and the ORDER is the author's
 * statement of which reason a customer can act on first (the first failure wins
 * and the rest are not evaluated):
 *
 *   1. no previous order      — there is nothing to swap.
 *   2. past the PONR          — the cancel this route opens with will be REFUSED
 *                               by `requireCancellable`, so confirming would ask
 *                               approval for a route already impossible.
 *   3. coupon not usable      — the entire REASON for cancelling does not hold.
 *   4. no computable total    — the sentence's third grounded number does not
 *                               exist, and "cancel this and rebuild it" with no
 *                               price is not a decision, it is a leap.
 *
 * `confirmSwapForCoupon` REFUSEs on the same four facts at ADJUDICATION. That is
 * not redundancy: these speak before the customer is asked anything, the guard is
 * the only line of defence on the RESUME path, and a coupon that expired between
 * the confirm and the "sim" is caught there — before the cancel.
 *
 * ── THE ONE CONFIRM, AND WHAT IT COVERS ──────────────────────────────────────
 *
 * `confirm.statesFacts` declares that the sentence states all three grounded
 * facts. The `cancel` activity then declares that the whole-workflow confirm
 * ALREADY ASKED `gatePaidCancel`'s `paid_cancel_requires_confirmation` — naming
 * that ONE basis reason, never the guard (the same guard also produces
 * `paid_cancel_escalation_approved`, and covering "the guard" would silently
 * cover both). The compiler checks the coverage's facts against
 * `confirm.statesFacts` (`confirm-coverage-unstated`); a test in
 * `packages/pack-orders` checks that the guard's REAL sentence carries them.
 *
 * The upper band is untouched BY CONSTRUCTION, not by care: coverage acts on
 * REQUEST_CONFIRMATION alone, so a paid cancel at or above the escalate
 * threshold still ESCALATEs and still goes to a human.
 *
 * ── WHY `cancel` IS TERMINAL, AND WHAT THAT COSTS ────────────────────────────
 *
 * `terminal: "irreversible"`, because it is true: the catalog declares no
 * capability that un-cancels an order, and inventing a compensator that "reorders
 * the cancelled order" would restore a DIFFERENT order at a DIFFERENT price and
 * call it a rollback.
 *
 * The consequence is stated rather than hidden: if the rebuild fails after the
 * cancel succeeded, the run reaches `stranded`, NOT `compensated`, and the
 * customer is told their order was cancelled and the new one could not be built.
 * That is the honest sentence for a genuinely bad outcome, and it is the outcome
 * the ticket's fifth acceptance criterion is really about — the compensation
 * MACHINERY runs (the reverse pass executes, the trace records it), and what it
 * reports is that nothing could be undone.
 */
export const SWAP_FOR_COUPON_WORKFLOW: WorkflowDefinition = {
  id: SWAP_FOR_COUPON_WORKFLOW_ID,
  title: "Trocar o pedido por um novo com cupom",
  description:
    "Cancelar o pedido atual do cliente e montar um pedido novo igual com um cupom de desconto aplicado, depois de confirmar com ele o valor, o reembolso e o novo total.",
  // PROVENANCE (LE2-033). EVERY phrasing here is `authored` and the body is
  // FLAGGED FOR OWNER REVIEW — unlike reorder-last, which carried one genuine
  // production utterance, this workflow has NONE, and the reason is recorded
  // rather than worked around: the `intent_audit` store was unreachable when
  // this was authored, so no phrasing could be grounded in a real customer
  // sentence. A `production-utterance` tag nobody could verify would be a
  // fabricated provenance claim, which is worse than an honest `authored` one.
  // Re-mine and upgrade when the store is reachable.
  //
  // No phrasing is drawn from `packages/journeys/extraction-corpus` or the
  // extraction-eval fixtures — that corpus is LE2-008's gate and authoring
  // against it would test-fit the measurement. None carries PII, and none is an
  // allergen or dietary disclosure.
  //
  // Authored strongest-first: the surface truncates from the end.
  triggerPhrasings: [
    {
      phrasing: "cancela meu pedido e faz outro igual com o cupom",
      provenance: "authored",
      why: "the ticket's own headline shape — names the cancel, the rebuild and the coupon in the order they happen",
    },
    {
      phrasing: "se não der pra usar o cupom, cancela e faz de novo",
      provenance: "authored",
      why: "the spec's verbatim stress-test sentence, conditional register — the hardest form and the one the whole workstream is measured on",
    },
    {
      phrasing: "quero usar meu cupom no pedido que já fiz",
      provenance: "authored",
      why: "desiderative, and names NEITHER the cancel nor the rebuild — the customer states the goal and leaves the mechanism to us, which is the most common way this will really be asked",
    },
    {
      phrasing: "dá pra aplicar esse cupom no meu pedido?",
      provenance: "authored",
      why: "interrogative — a different neighbourhood of the embedding space from the imperatives, and the phrasing most likely to collide with the coupon-validity READ, so it is here deliberately to be measured",
    },
    {
      phrasing: "refaz meu pedido com desconto",
      provenance: "authored",
      why: "'desconto' rather than 'cupom' — the noun a customer may reach for when they do not have a code in hand",
    },
    {
      phrasing: "esqueci de colocar o cupom, dá pra trocar?",
      provenance: "authored",
      why: "names the REASON (a forgotten code) instead of the act; the apologetic framing is common and shares almost no tokens with the description",
    },
    {
      phrasing: "troca meu pedido por um com o cupom",
      provenance: "authored",
      why: "the 'troca' verb the title uses, which no other phrasing here carries",
    },
  ],
  // CONJUNCTIVE, and every conjunct NARROWS. `order.cart.ensure` is the
  // always-proposable cart floor; `order.checkout.create` is the AUTHENTICATION
  // conjunct (the orders planner's `if (isAuthenticated)` branch) — offering a
  // destructive order swap to a guest would advertise a route whose anchor must
  // REFUSE at `requireAuthenticated`. `order.coupon.apply` is the conjunct that
  // says the coupon half of this route is available at all: the last activity
  // invokes exactly that capability, so gating on it keeps the workflow from
  // being offered where its own final step could not run.
  matchers: [
    { capability: "order.cart.ensure" },
    { capability: "order.checkout.create" },
    { capability: "order.coupon.apply" },
  ],
  selection: { capability: "order.coupon.swap.request" },
  // THE ONE PARAM, and it is a SLOT rather than a claim because the coupon code
  // is a value the CUSTOMER AUTHORED in the selecting utterance. No registry
  // claim carries a coupon code (`COUPON_VALID`'s validated value is a composed
  // pt-BR string), and the code is not an identifier the model could confabulate
  // into somebody else's money — it is checked against the store before any of
  // this is offered, and the guard quotes the STORE's spelling back, never this.
  params: [{ name: "code", source: { from: "slot", slot: "code" } }],
  prechecks: [
    {
      id: "has-previous-order",
      predicate: { fact: "customerHasPreviousOrder", op: "isTrue" },
      template: "no-previous-order",
    },
    {
      id: "order-is-cancelable",
      predicate: { fact: "previousOrderIsCancelable", op: "isTrue" },
      template: "past-ponr",
    },
    {
      id: "coupon-is-valid",
      predicate: { fact: "couponIsValid", op: "isTrue" },
      template: "coupon-not-usable",
    },
    {
      id: "new-total-is-computable",
      predicate: { fact: "couponNewTotalInCentavos", op: "present" },
      template: "total-unknown",
    },
  ],
  activities: [
    {
      id: "cancel",
      capability: "order.cancel",
      // EMPTY, deliberately. `orderId` is an identifier and `actorId` is the
      // BKL-103 proposer stamp; neither has an admissible `WorkflowParamSource`,
      // and both are resolved host-side from the OWNER-SCOPED previous-order
      // projection before the envelope is minted (see
      // `WorkflowRuntimeDeps.resolveActivityPayload`). An order id a model named
      // is an order id a model could have invented.
      payload: {},
      compensation: {
        terminal: "irreversible",
        why: "an order cannot be un-cancelled; the catalog declares no capability that reinstates one, and reordering it would restore a different order at a different price while calling itself a rollback",
      },
      // THE DECLARED COVERAGE — LE2-023's whole point, and the narrowest form it
      // can take. ONE basis reason, and only the two facts that guard's own
      // sentence states (it names the amount and the refund; it says nothing
      // about the new total, so claiming `newTotal` here would be claiming
      // coverage of a question that was never asked).
      confirmCoveredBy: {
        basisReason: "paid_cancel_requires_confirmation",
        statesFacts: ["orderAmount", "refundConsequence"],
        why: "the whole-workflow confirm states this order's amount and that cancelling refunds it — the same two facts gatePaidCancel's own sentence states — and the customer answered THAT question with a witnessed affirmation",
      },
    },
    {
      id: "rebuild",
      capability: "order.reorder",
      payload: {},
      compensation: {
        terminal: "irreversible",
        why: "rebuilds the session cart from the cancelled order; the catalog declares no capability that restores the previous cart",
      },
    },
    {
      // LE2-023 — THE CLOSED BRANCH'S TARGET. Reachable only through the
      // `coupon_on_placed_order` policy switch, which this workflow does not
      // declare open, and refused by the kernel even if it were: the capability
      // is `workflowScoped` (no parse can propose it) and `ordersPolicyBundle`
      // produces no EXECUTE for it. Two locks in two packages; the fixture that
      // forces the route open proves the second one is real.
      id: "price-adjust",
      capability: "order.coupon.adjust",
      payload: { code: { param: "code" } },
      compensation: {
        terminal: "harmless",
        why: "unreachable — the branch ships closed and the kernel refuses the kind; were it ever to run and be undone, a price adjustment on a placed order would need its own reversal capability, which is part of what opening this switch must build",
      },
    },
    {
      id: "apply-coupon",
      capability: "order.coupon.apply",
      // The ONE authored binding in the route: the customer's own code, carried
      // from the slot the selection surface declared.
      payload: { code: { param: "code" } },
      compensation: {
        // HARMLESS, and the marker is doing real work rather than being the soft
        // default. Nothing runs after this step, and a coupon sitting on a cart
        // the customer has not checked out is invisible to them and costs them
        // nothing. Marking it "irreversible" would make the failure render
        // "something could not be undone" about a discount — a sentence that
        // frightens a customer about nothing and teaches them to ignore the one
        // that matters.
        terminal: "harmless",
        why: "a promotion code on a not-yet-checked-out cart changes nothing the customer holds; re-applying or dropping it is a no-op from their side",
      },
    },
  ],
  // THE ROUTE, and its single branch is a POLICY switch rather than a predicate
  // over a fact — because "does this business offer price adjustment" is not a
  // fact about this customer. It is authored catalog data, identical for
  // everyone, changed only by a reviewed commit. Spelling it as a fact would put
  // what the business offers and what is true of a customer into one vocabulary,
  // and the projection layer would then need a branch that reads the catalog,
  // which is exactly the runtime authority the catalog must never hold.
  //
  // `policyOpen` is OMITTED below, so the switch is CLOSED and `otherwise` — the
  // cancel-and-rebuild saga — is the shipped path. The trace records the branch
  // as `policy coupon_on_placed_order closed`, which tells an operator the
  // BUSINESS is not offering this, not that the customer failed to qualify.
  route: [
    {
      whenPolicyOpen: "coupon_on_placed_order",
      then: ["price-adjust"],
      otherwise: ["cancel", "rebuild", "apply-coupon"],
    },
  ],
  // ABSENT ⟹ every switch closed. Opening this one is exactly one line added
  // here plus a CATALOG_VERSION bump — a catalog change, not engine work, which
  // is the ticket's own requirement and is checkable: the diff that opens it
  // touches this package and nothing else. It still would not make the branch
  // RUN; that needs the second lock opened in `pack-orders` too.
  confirm: {
    template: "confirm",
    // WHAT THE SENTENCE STATES. Declared here, checked against the coverage by
    // the compiler and against the guard's real words by a test in
    // `packages/pack-orders`. See `WorkflowConfirmPoint.statesFacts`.
    statesFacts: ["orderAmount", "refundConsequence", "newTotal"],
  },
  templates: [
    // `{confirmation}` ALONE — the kernel's own sentence, authored by
    // `confirmSwapForCoupon` from projected state. Quoted verbatim and
    // unadorned: framing added around a grounded sentence is a second voice in
    // the same breath, and the customer has no way to tell which half was
    // checked. It is also what keeps the BKL-212 soft-affirmative restatement a
    // SUBSET of what they read rather than a different question.
    { id: "confirm", text: "{confirmation}" },
    {
      id: "no-previous-order",
      text: "Ainda não encontrei nenhum pedido seu pra trocar. Quer montar um novo?",
    },
    {
      id: "past-ponr",
      text: "Esse pedido já passou do ponto de cancelamento, então não dá pra trocar por outro. Fala com a gente que a equipe te ajuda.",
    },
    {
      id: "coupon-not-usable",
      // Says what we could establish about OURSELVES, never that the store
      // rejected the code — the projection reports "could not check" and "not
      // usable" as different facts, and only one of them is a claim about the
      // coupon. See `refuseCouponNotUsable`.
      text: "Não consegui confirmar esse cupom agora, então não mexi no seu pedido. Quer tentar outro código?",
    },
    {
      id: "total-unknown",
      text: "Esse cupom é válido, mas não consigo calcular quanto ficaria o pedido novo com ele — então não mexi no seu pedido. Dá pra aplicar ele na hora de fechar um pedido novo.",
    },
    {
      id: "completed",
      text: "Pronto! Cancelei o pedido anterior e montei um carrinho novo com os mesmos itens e o cupom aplicado. Quer finalizar?",
    },
    {
      id: "declined",
      text: "Tudo bem, não cancelei nada e seu pedido continua como estava.",
    },
    {
      id: "failed",
      text: "Não consegui fazer essa troca e não mexi no seu pedido. Já chamei alguém da equipe para te ajudar.",
    },
    {
      id: "compensated",
      text: "Não consegui concluir a troca, então desfiz o que já tinha feito. Seu pedido continua como estava.",
    },
    {
      id: "stranded",
      // THE SENTENCE THIS OUTCOME EXISTS FOR. It must not say "nothing
      // happened", because the order really is cancelled. It names what was
      // done, what was not, and who is handling it.
      text: "Cancelei seu pedido anterior, mas não consegui montar o novo com o cupom. Já chamei alguém da equipe para resolver isso com você.",
    },
    {
      id: "escalated",
      // THE WHOLE TRUTH, both halves, because the machinery on the other side is
      // narrower than a customer would assume: an approval resumes THE ESCALATED
      // ACTIVITY ALONE — there is no saga-resume anywhere in this system — so
      // the rest of the route does NOT run. A template saying only "someone will
      // review this" would leave them believing their whole request is pending.
      text: "Esse cancelamento precisa da aprovação de um responsável, então mandei pra equipe revisar e ainda não mexi no seu pedido. Assim que aprovarem, o cancelamento acontece — e aí é só me chamar que eu monto o pedido novo com o cupom.",
    },
  ],
  outcomes: {
    completed: "completed",
    declined: "declined",
    failed: "failed",
    compensated: "compensated",
    stranded: "stranded",
    escalated: "escalated",
  },
}

/** The paid-cancel workflow's id — exported so nothing re-spells the string. */
export const PAID_CANCEL_WORKFLOW_ID = "workflow.orders.paid-cancel"

/**
 * PAID-CANCEL — LE2-024, and the ONLY workflow here that re-platforms an act the
 * system already had.
 *
 * *"quero cancelar meu pedido"* on an order that has been PAID FOR. The customer
 * is shown what the order cost and that cancelling refunds it, and only on their
 * "sim" is the cancel adjudicated — against the same money ladder, by the same
 * kernel, as a directly-parsed cancel.
 *
 * ── THIS ONE IS A MIGRATION, NOT A NEW ROUTE ─────────────────────────────────
 *
 * Reorder-last and swap-for-coupon added routes that had no direct-intent form.
 * This one fronts `order.cancel`, which has been a chat-tier capability all
 * along, and that changes what "correct" means for every part of it. There is an
 * existing behaviour to REPRODUCE, so nothing here may be authored on its merits
 * — the confirm sentence, the refusals and the money bands are all the direct
 * ladder's, reached through the same functions rather than through agreeing
 * copies:
 *
 *   the confirm     — `paidCancelConfirmText`, the sentence `gatePaidCancel`
 *                     itself asks with. ONE function, two callers.
 *   the PONR refuse — `refuseOrderPastPonr`, the factory `requireCancellable`
 *                     refuses a direct cancel with.
 *   the bands       — not reproduced at all. The `cancel` activity meets the
 *                     REAL `gatePaidCancel`, so the ladder is not mirrored here,
 *                     it is ENCOUNTERED.
 *
 * `apps/api/src/__tests__/paid-cancel-parity.e2e.test.ts` drives the same
 * utterances and the same states down BOTH paths and diffs the observations. A
 * parity suite that only drove this one would be pinning a copy against itself.
 *
 * ── THE THREE BANDS, AND THE ONE THAT DIVERGES ───────────────────────────────
 *
 *   UNPAID          — `confirmPaidCancel` returns null, the anchor EXECUTEs on
 *                     the selecting turn, and the cancel runs in that same turn.
 *                     The direct ladder does not ask either. PARITY.
 *   PAID, SUB-BAND  — one confirm, quoting the shared sentence; the activity's
 *                     own `paid_cancel_requires_confirmation` is resolved by the
 *                     declared coverage below. PARITY on the question asked.
 *   PAID, ≥ R$1.000 — the activity ESCALATEs, and the customer reads the
 *                     `escalated` template. DIVERGENT, deliberately: the direct
 *                     ladder escalates on the FIRST turn without asking, and this
 *                     route asks first and escalates on the second. The reason is
 *                     BKL-103 and it is written out in `confirmPaidCancel`'s doc —
 *                     an escalation raised at the anchor would park an
 *                     `order.cancel.request`, which no approval path can act on.
 *                     One extra question, against an escalation a human can
 *                     actually approve.
 *
 * ── WHY THE PHRASINGS ARE THE ONES THE DIRECT PATH DOES NOT ALREADY CLAIM ────
 *
 * `order.cancel` declares ten `conversationTriggers`, and the compiler's
 * `trigger-phrasing-collides` rule forbids this workflow from re-declaring any of
 * them — *"two routes advertising one sentence do not degrade selection, they
 * make it a coin flip"*. Every phrasing below is therefore a production utterance
 * that capability did NOT take, and the overlap that remains is SEMANTIC rather
 * than textual: both routes answer "cancel my order", and only retirement can
 * settle which one owns that ask. The live drive measures the split; the ticket
 * stages the decision.
 */
export const PAID_CANCEL_WORKFLOW: WorkflowDefinition = {
  id: PAID_CANCEL_WORKFLOW_ID,
  title: "Cancelar um pedido já pago",
  description:
    "Cancelar um pedido do cliente que já foi pago, confirmando com ele o valor do pedido e que o cancelamento devolve o dinheiro.",
  // PROVENANCE (LE2-033). EVERY phrasing here is `production-utterance` — the
  // first workflow in this file for which that is true of the whole body, and it
  // is not a lucky draw: cancelling is an act customers have been asking for in
  // production since before any of this existed, so the store had real sentences
  // to read. They were mined from `claustrum_memory_episodic.user_text` (1568
  // rows, 602 distinct) and PII-SCRUBBED per the legend — order ids became
  // `12345`. Counts below are occurrences of the pre-scrub original.
  //
  // Every one of them was checked against `order.cancel`'s own
  // `conversationTriggers` and none collides; the ones that did are noted in the
  // module doc above. No phrasing is drawn from
  // `packages/journeys/extraction-corpus` or the extraction-eval fixtures — that
  // corpus is LE2-008's gate and authoring against it would test-fit the
  // measurement. None carries PII, and none is an allergen or dietary disclosure.
  //
  // Strongest-evidence-first: the surface truncates from the end.
  triggerPhrasings: [
    {
      phrasing: "cancela o último pedido",
      provenance: "production-utterance",
      why: "15 production rows — the most-said cancel sentence in the store that `order.cancel` does not already claim; names the order by RECENCY rather than by id, which is how a customer who has one open order actually refers to it",
    },
    {
      phrasing: "poderia cancelar meu pedido mais recente, por gentileza?",
      provenance: "production-utterance",
      why: "14 production rows, and the only polite-interrogative cancel in the corpus — a different neighbourhood of the embedding space from every imperative here",
    },
    {
      phrasing: "quero cancelar meu pedido por favor",
      provenance: "production-utterance",
      why: "3 production rows across two spellings that fold together (one capitalised and punctuated); the plain desiderative, which is the register the corpus repeats most",
    },
    {
      phrasing: "quero cancelar o pedido 12345",
      provenance: "production-utterance",
      why: "3 production rows under distinct order ids — the customer names the order by NUMBER, the form that most needs the resolver rather than the model to pick the target",
    },
    {
      phrasing: "quero cancelar meu pedido 12345",
      provenance: "production-utterance",
      why: "the possessive-plus-number form; shares almost every token with the entry above and selects differently often enough in past drives to be worth carrying both",
    },
    {
      phrasing: "cancela o pedido 12345",
      provenance: "production-utterance",
      why: "the bare imperative with a number and no politeness marker or possessive — the shortest cancel in the corpus, and the one with the fewest tokens for retrieval to work with",
    },
    {
      phrasing: "cancela o pedido 12345 de 1200 reais",
      provenance: "production-utterance",
      why: "the ONE production cancel that states an AMOUNT, and it states one above the escalate band — the exact shape this workflow's divergent case is about, so it is here to be measured rather than because it is common",
    },
  ],
  // CONJUNCTIVE, and every conjunct NARROWS. `order.cart.ensure` is the
  // always-proposable cart floor; `order.checkout.create` is the AUTHENTICATION
  // conjunct (the orders planner's `if (isAuthenticated)` branch) — offering a
  // cancel to a guest would advertise a route whose anchor must REFUSE at
  // `requireAuthenticated`.
  //
  // ── THE `order.cancel` CONJUNCT WAS REMOVED BY THE RETIREMENT, AND THE
  //    REASONING THAT PUT IT THERE INVERTED ─────────────────────────────────
  //
  // It was authored so that "the day `order.cancel` stops being offered, this
  // workflow stops being offered WITH it rather than outliving the capability it
  // fronts". That day came, and the premise turned out to be backwards: the
  // capability stopped being ADVERTISED precisely BECAUSE this workflow now owns
  // the ask. Keeping the conjunct made retirement self-defeating — the planner
  // drops `order.cancel` from `allowedIntents`, the matcher stops holding, the
  // workflow is not advertised, and a cancel utterance reaches NOTHING.
  //
  // The parity suite caught it immediately (every workflow case rendered the
  // model's fallback instead of the confirm), which is the argument for a matcher
  // being a DECLARED precondition a test can drive rather than a comment.
  //
  // What the conjunct was really reaching for — "do not offer this route where its
  // act cannot run" — is already covered and better: `confirmPaidCancel` REFUSEs
  // on no-order and past-PONR, the pre-checks speak before any confirm, and the
  // activity meets the real `gatePaidCancel`. Advertisement is not the layer that
  // check belongs in.
  matchers: [
    { capability: "order.cart.ensure" },
    { capability: "order.checkout.create" },
  ],
  selection: { capability: "order.cancel.request" },
  // NONE, and for the reason reorder-last has none: the one value this route
  // needs — WHICH order — is an IDENTIFIER, and neither admissible
  // `WorkflowParamSource` may carry one. No registry claim exposes an order id,
  // and a slot would be model-EXTRACTED, which for an identifier is precisely the
  // confabulation that union exists to prevent. It is stamped host-side from the
  // OWNER-SCOPED previous-order projection that grounded the confirm sentence, so
  // the order this cancels is the order the customer was shown.
  params: [],
  prechecks: [
    {
      id: "has-previous-order",
      predicate: { fact: "customerHasPreviousOrder", op: "isTrue" },
      template: "no-order-to-cancel",
    },
    {
      id: "order-is-cancelable",
      predicate: { fact: "previousOrderIsCancelable", op: "isTrue" },
      template: "past-ponr",
    },
    {
      // THE THIRD ONE EXISTS TO KEEP `statesFacts` HONEST. `paidCancelConfirmText`
      // has an absent-total branch that asks WITHOUT naming a figure, and the
      // confirm below declares that it states `orderAmount`. Without this
      // pre-check that declaration would be false exactly when the projection came
      // back thin — and the coverage that rests on it would be claiming the
      // customer read a number nobody showed them.
      id: "amount-is-known",
      predicate: { fact: "previousOrderTotalInCentavos", op: "present" },
      template: "amount-unknown",
    },
  ],
  activities: [
    {
      id: "cancel",
      capability: "order.cancel",
      payload: {
        // The ONE authored binding, and it is not an identifier: the pt-BR reason
        // written into the order's own cancellation record. `orderId` and the
        // BKL-103 `actorId` proposer stamp are host-resolved before the envelope
        // is minted (`stampOrderActivityPayload`), because an order id a model
        // named is an order id a model could have invented.
        reason: { const: "Cancelado a pedido do cliente" },
      },
      compensation: {
        terminal: "irreversible",
        why: "an order cannot be un-cancelled; the catalog declares no capability that reinstates one, and reordering it would restore a different order at a different price while calling itself a rollback",
      },
      // THE DECLARED COVERAGE, and here it is doing something the swap-for-coupon
      // one could not: asserting that the covering question and the covered
      // question are THE SAME SENTENCE. `confirmPaidCancel` and `gatePaidCancel`
      // both call `paidCancelConfirmText`, so the two facts below are stated by
      // the confirm because they are stated by the covered guard — not because an
      // author judged the two sentences close enough.
      confirmCoveredBy: {
        basisReason: "paid_cancel_requires_confirmation",
        statesFacts: ["orderAmount", "refundConsequence"],
        why: "the whole-workflow confirm is BYTE-IDENTICAL to gatePaidCancel's own question — the same paidCancelConfirmText call, stating this order's amount and that cancelling refunds it — and the customer answered THAT question with a witnessed affirmation",
      },
    },
  ],
  confirm: {
    template: "confirm",
    // WHAT THE SENTENCE STATES. Two facts, not three: `paidCancelConfirmText`
    // names the amount and the refund consequence and says nothing about any new
    // total, so declaring `newTotal` here would be claiming coverage of a question
    // this route never asks.
    statesFacts: ["orderAmount", "refundConsequence"],
  },
  templates: [
    // `{confirmation}` ALONE — and here the rule that framing must be additive is
    // load-bearing in a way it was not for the other two workflows. The parity pin
    // asserts this render is byte-identical to what a direct paid cancel shows;
    // ANY word added around the placeholder breaks that, so the degenerate form is
    // not a stylistic choice here, it is the acceptance criterion.
    { id: "confirm", text: "{confirmation}" },
    {
      id: "no-order-to-cancel",
      text: "Ainda não encontrei nenhum pedido seu pra cancelar. Se você fez um pedido agora há pouco, me chama que eu procuro de novo.",
    },
    {
      id: "past-ponr",
      // The same fact `refuseOrderPastPonr` states, in the pre-check's own voice.
      text: "Esse pedido já passou do ponto de cancelamento, então não dá mais pra cancelar por aqui. Fala com a gente que a equipe te ajuda.",
    },
    {
      id: "amount-unknown",
      text: "Não consegui confirmar o valor desse pedido agora, então preferi não mexer nele. Me chama de novo em instantes ou fala com a equipe que a gente resolve.",
    },
    {
      id: "completed",
      text: "Pronto, cancelei seu pedido. O reembolso já foi solicitado e o valor volta pra você pelo mesmo meio de pagamento.",
    },
    { id: "declined", text: "Tudo bem, não cancelei nada e seu pedido continua como estava." },
    {
      id: "failed",
      text: "Não consegui cancelar seu pedido e não mexi em nada. Já chamei alguém da equipe para te ajudar.",
    },
    {
      id: "escalated",
      // THE WHOLE TRUTH, both halves — the same shape swap-for-coupon's carries
      // and for the same reason, minus its second clause: this route has no steps
      // after the cancel, so there is nothing the customer must ask for again. An
      // approval here completes the whole request.
      text: "Esse cancelamento precisa da aprovação de um responsável, então mandei pra equipe revisar e ainda não mexi no seu pedido. Assim que aprovarem, o cancelamento e o reembolso acontecem e eu te aviso.",
    },
  ],
  outcomes: {
    completed: "completed",
    declined: "declined",
    failed: "failed",
    escalated: "escalated",
  },
}

/**
 * Every workflow the production catalog declares. See the module doc for what
 * an entry costs structurally.
 */
export const WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  REORDER_LAST_WORKFLOW,
  SWAP_FOR_COUPON_WORKFLOW,
  PAID_CANCEL_WORKFLOW,
]
