/**
 * The workflow runtime's PROOF CORPUS — LE2-020.
 *
 * One linear workflow, authored so that every seam of the runtime is exercised
 * by a real turn against real machinery. It is openly a FIXTURE and says so in
 * its id: it is not a customer journey, it is the instrument that proves the
 * runtime works before any customer journey is authored against it (the seed
 * journeys are Implementation Decision 18's, on later tickets).
 *
 * # Everything referenced here is REAL
 *
 * A fixture whose capabilities were invented would prove nothing: the kernel
 * would default-REFUSE an unknown kind (`composePolicyRouter`'s SYSTEM taint
 * floor) and the "each activity is adjudicated" claim would be vacuous. So
 * every kind below is a real, pack-owned, router-known capability with real
 * guards and a real handler:
 *
 *   - `order.checkout.create` (SELECTION ANCHOR) — chat-tier, pack-orders. Its
 *     `confirmLargeTicket` guard returns REQUEST_CONFIRMATION at or above
 *     R$ 1.000 with the total read from grounded state, which is what makes the
 *     whole-workflow confirm carry a GROUNDED AMOUNT rather than a number the
 *     workflow layer computed for itself. The workflow never re-derives money —
 *     its confirm template quotes the kernel's own prompt verbatim (the
 *     `{confirmation}` placeholder).
 *   - `order.cart.ensure` (ORDINARY ACTIVITY) — chat-tier, pack-orders,
 *     registered handler, Medusa-only egress. Present so the sequence proves an
 *     ordinary kind is adjudicated individually inside a workflow exactly as it
 *     is outside one, and that a mixed sequence works.
 *   - `order.reorder` (WORKFLOW-SCOPED ACTIVITY) — identity-tier, pack-orders,
 *     `workflowScoped: true`. The access class's positive proof: the parser can
 *     never emit it, and an instantiated workflow's executor can.
 *
 * # Why the sequence is not a plausible customer journey
 *
 * Because it is not trying to be. It is chosen to cover the runtime's cases in
 * the fewest steps: one ordinary activity and one workflow-scoped activity,
 * behind one confirm point, with one claim-sourced param and one
 * customer-authored slot param. Reading it as a proposed conversational flow is
 * a category error — see `definitions.ts` for where real workflows go.
 */

import type { WorkflowDefinition } from "./types.js"

/** The fixture workflow's id — exported so tests never re-spell the string. */
export const FIXTURE_WORKFLOW_ID = "workflow.fixture.linear-v0"

/**
 * The authored order id the fixture's reorder activity targets. Exported so the
 * turn-seam suite routes its Medusa fake at the same value instead of
 * re-spelling it — see the activity's binding for why it is a `const` and not a
 * param.
 */
export const FIXTURE_PREVIOUS_ORDER_ID = "order_le2020_previous"

/**
 * The linear v0 fixture workflow. See the module doc for why each capability is
 * the one it is.
 */
export const FIXTURE_LINEAR_WORKFLOW: WorkflowDefinition = {
  id: FIXTURE_WORKFLOW_ID,
  title: "Fluxo de teste linear",
  description:
    "Fluxo de teste do runtime: finalizar o pedido e repetir os itens do pedido anterior.",
  // Six SYNTHETIC phrasings, all `authored`, all openly fixture-shaped — they
  // name the fixture rather than pretending to be pt-BR a customer would speak.
  // The field is required by the contract, and a fixture that borrowed a real
  // workflow's phrasings would collide with it under the compiler's
  // cross-namespace rule the moment both were compiled together, which is the
  // rule working rather than a reason to weaken it.
  triggerPhrasings: [
    { phrasing: "fluxo de teste linear um", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste linear dois", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste linear tres", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste linear quatro", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste linear cinco", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste linear seis", provenance: "authored", why: "fixture probe" },
  ],
  // Offered only on a turn whose capability planners already authorized a
  // checkout — so an unauthenticated customer, or one with no cart, is never
  // offered the workflow. The workflow can only narrow, never widen.
  matchers: [{ capability: "order.checkout.create" }],
  selection: { capability: "order.checkout.create" },
  params: [
    {
      // CUSTOMER-AUTHORED: a note the customer typed in the selecting
      // utterance, carried on the selection call's closed `slots` surface and
      // rendered into the confirm prompt. A slot param need not reach an
      // activity payload — being shown back to the customer before they approve
      // is a first-class use, and the one that most needs the value to be
      // theirs rather than the model's.
      name: "note",
      source: { from: "slot", slot: "note" },
    },
    {
      // CLAIM-SOURCED, and it must name the REGISTRY CLAIM TYPE vocabulary —
      // not the responder's success-class vocabulary (SDD §K: "map, do not
      // equate"). LE2-020 shipped `{claimType: "order-placed", field:
      // "orderId"}`, which is wrong in BOTH halves and was caught by LE2-021:
      // `order-placed` is a `SUCCESS_CLAIM_CLASSES` guard id, not a member of
      // `REGISTRY_CLAIM_TYPE_REFERENCES`, and no registry type's `valueBinding`
      // carries an `orderId` at all. The `claim-param-type-unknown` rule in the
      // workflow-shape pass now makes that spelling a BUILD error.
      //
      // The honest binding is the one the registry actually proves: the C6
      // value of ORDER_HISTORY is a deterministically pre-composed pt-BR
      // SUMMARY STRING (`historySummaryText`), so this param is shown back to
      // the customer in the confirm prompt rather than used as an identifier.
      // That is the strongest use of a claim-sourced value anyway — see the
      // slot param above.
      name: "previousOrderSummary",
      source: {
        from: "claim",
        claimType: "ORDER_HISTORY",
        field: "historySummaryText",
      },
    },
    // The ANCHOR's own required slots. Declaring them as params is what puts
    // them on the workflow's CLOSED slot surface, which is what lets them
    // survive the parse seam and reach the anchor payload — where the real
    // checkout guards read them (and the real resolver renames the snake_case
    // wire keys the model actually produces). A workflow does not get to skip
    // what its anchor capability requires; it has to carry it like any other
    // proposal would.
    { name: "paymentMethod", source: { from: "slot", slot: "payment_method" } },
    { name: "deliveryType", source: { from: "slot", slot: "delivery_type" } },
  ],
  activities: [
    {
      id: "ensure",
      capability: "order.cart.ensure",
      // LE2-022 — `order.cart.ensure` is `mutating: true` in the capability
      // table, so the compensation-completeness rule requires a statement. It is
      // HARMLESS rather than irreversible: `getOrCreateCart` is idempotent over a
      // session that already has a cart, and a customer who ends a failed run
      // with an empty cart they already had is exactly where they started. That
      // is the whole reason the marker is two-valued — under a single boolean
      // this step would strand the run and the reply would warn a customer about
      // nothing.
      compensation: {
        terminal: "harmless",
        why: "idempotent — a session cart the customer already had is not a change to undo",
      },
      payload: {},
    },
    {
      id: "reorder",
      capability: "order.reorder",
      // An AUTHORED CONSTANT, which is first-party by construction. It used to
      // bind the claim param above, back when that param was mis-declared as an
      // order id; now that the param is honestly a summary STRING, feeding it to
      // an `orderId` field would be a type lie the compiler cannot see.
      //
      // A `slot` would be the other available source and is deliberately NOT
      // used: a slot is model-EXTRACTED, so a fixture that sourced an order id
      // from one would stand in the repository as a worked example of the exact
      // confabulation `WorkflowParamSource` exists to prevent. In the real
      // reorder-last flow the identifier is resolved executor-side from
      // owner-scoped state, never carried as a param at all.
      payload: { orderId: { const: FIXTURE_PREVIOUS_ORDER_ID } },
      // LE2-022 — the LAST step of a linear route, so nothing after it can fail
      // and strand it. IRREVERSIBLE rather than harmless all the same, because
      // the marker states what would be TRUE of the effect, not what happens to
      // be reachable in this route's ordering: a cart rebuilt out from under a
      // customer is a visible change, and an author who reorders this workflow
      // must not inherit a "harmless" that was only ever true positionally.
      compensation: {
        terminal: "irreversible",
        why: "replaces the session cart with a copy of an old order; no capability puts the old one back",
      },
    },
  ],
  confirm: { template: "confirm" },
  templates: [
    {
      id: "confirm",
      // `{confirmation}` is the KERNEL's own confirm prompt, quoted verbatim —
      // the grounded amount is never re-computed here.
      text: "{confirmation} Em seguida eu repito os itens do seu pedido anterior ({previousOrderSummary}). Sua observação: {note}",
    },
    { id: "completed", text: "Pronto! Concluí todas as etapas do seu pedido." },
    { id: "declined", text: "Tudo bem, não fiz nada. É só me chamar quando quiser." },
    {
      id: "failed",
      text: "Não consegui concluir todas as etapas. Já chamei alguém da equipe para te ajudar.",
    },
    // LE2-022 — required from here on: this route reaches two activities, so a
    // run CAN stop in the middle, and the two honest things to say about that
    // are different sentences.
    {
      id: "compensated",
      text: "Não consegui concluir todas as etapas, então desfiz o que já tinha feito. Nada foi cobrado.",
    },
    {
      id: "stranded",
      text: "Não consegui concluir todas as etapas e não consegui desfazer tudo o que já tinha feito. Já chamei alguém da equipe para resolver isso com você.",
    },
  ],
  outcomes: {
    completed: "completed",
    declined: "declined",
    failed: "failed",
    compensated: "compensated",
    stranded: "stranded",
  },
}

/** The v1 fixture workflow's id — exported so tests never re-spell the string. */
export const FIXTURE_CONDITIONAL_WORKFLOW_ID = "workflow.fixture.conditional-v1"

/**
 * The money band, in centavos, the fixture's conditional edge branches on.
 *
 * Exported so the turn-seam suite arranges its previous-order double ABOVE and
 * BELOW one number instead of re-spelling it on each side — the same discipline
 * {@link FIXTURE_PREVIOUS_ORDER_ID} follows, and the thing that makes the
 * both-arms proof a single knob rather than two independent literals that can
 * drift until both tests take the same arm.
 */
export const FIXTURE_BRANCH_THRESHOLD_CENTAVOS = 5000

/**
 * The cart the conditional fixture's checkout activity names.
 *
 * An AUTHORED CONSTANT, and the exported one so the turn-seam suite seeds Redis
 * and its Medusa fake at the same value instead of re-spelling it — the
 * {@link FIXTURE_PREVIOUS_ORDER_ID} precedent exactly.
 *
 * A cart id is session-derived in every real flow, which is why it is a FIXTURE
 * constant and not a param: `WorkflowParamSource` has no member that could carry
 * one honestly, and a slot would be model-EXTRACTED. What it buys is that
 * `requireCartIdForCartOps` — a real guard on `order.checkout.create` — can be
 * satisfied by an activity at all, so the later checkout guards are reachable
 * and the fixture measures them rather than stopping at the first one.
 */
export const FIXTURE_CART_ID = "cart_le2022"

/**
 * THE CONDITIONAL v1 FIXTURE — LE2-022's proof corpus.
 *
 * A sibling of {@link FIXTURE_LINEAR_WORKFLOW}, not a replacement: that workflow
 * is the LINEAR runtime's witness and stays exactly as linear as it was, so a
 * regression in the v0 path shows up as a v0 failure. This one adds — and only
 * adds — the three things v1 introduces:
 *
 *   PRE-CHECK      a feasibility predicate that refuses BEFORE any confirm.
 *   BRANCH         a conditional edge with two arms that each run something.
 *   COMPENSATION   a mutating step with a real compensator, and a route where a
 *                  later step can fail after it has already run.
 *
 * # Everything referenced here is REAL, for the same reason as the v0 fixture
 *
 * Same rule, same enforcement: the kernel default-REFUSEs an envelope whose kind
 * no pack owns, so a fixture over invented capabilities would prove nothing at
 * all. Every kind below is pack-owned, router-known, and has a handler that
 * resolves what it needs from the Capsule rather than from a resolver stage the
 * workflow runtime does not run:
 *
 *   - `order.checkout.create` (SELECTION ANCHOR) — as in the v0 fixture, its
 *     `confirmLargeTicket` guard is what parks the whole-workflow confirm with a
 *     GROUNDED amount the workflow never re-derives.
 *   - `order.reorder` (WORKFLOW-SCOPED) — the `then` arm. Rebuilds the cart from
 *     the customer's own last order; the compensated step.
 *   - `order.cart.ensure` — the `otherwise` arm AND, under a second activity id,
 *     `order.reorder`'s compensator.
 *
 * # Why the compensator is `order.cart.ensure`
 *
 * Because it is the only undo the CATALOG actually declares. `order.reorder`
 * points the session at a brand-new cart built from an old order; re-running the
 * session's cart floor is what puts the customer back on a cart of their own
 * instead of leaving them holding one a failed run built for them. There is no
 * `order.cart.clear` capability, and inventing one for a fixture would put a new
 * mutating verb into a production pack to make a test read better — which is
 * precisely the direction this corpus exists to avoid. The fixture routes over
 * what the catalog has, and says so.
 *
 * # Why the branch reads the PREVIOUS order's total and not the cart's
 *
 * Because the cart total is the knob that decides whether the anchor parks at
 * all (`confirmLargeTicket`). A branch over the same number would make the two
 * arms and the confirm move together, so a test could not vary one without the
 * other and "both branches proven" would be proven against two different flows.
 * The previous order's total is grounded by the same owner-scoped projection and
 * is independent of the cart, which makes it the one knob that varies the branch
 * and nothing else.
 */
export const FIXTURE_CONDITIONAL_WORKFLOW: WorkflowDefinition = {
  id: FIXTURE_CONDITIONAL_WORKFLOW_ID,
  title: "Fluxo de teste condicional",
  description:
    "Fluxo de teste do runtime v1: confere se dá pra repetir, escolhe o caminho pelo valor do pedido anterior e desfaz o que fez se travar no meio.",
  // Six SYNTHETIC phrasings, disjoint from the linear fixture's under the shared
  // fold — two fixtures sharing one phrasing would trip
  // `trigger-phrasing-collides` the moment both compile together, which is the
  // rule working rather than a reason to weaken it.
  triggerPhrasings: [
    { phrasing: "fluxo de teste condicional um", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste condicional dois", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste condicional tres", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste condicional quatro", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste condicional cinco", provenance: "authored", why: "fixture probe" },
    { phrasing: "fluxo de teste condicional seis", provenance: "authored", why: "fixture probe" },
  ],
  matchers: [{ capability: "order.checkout.create" }],
  selection: { capability: "order.checkout.create" },
  // The ANCHOR's own required slots, as in the v0 fixture: a workflow does not
  // get to skip what its anchor capability requires.
  params: [
    { name: "paymentMethod", source: { from: "slot", slot: "payment_method" } },
    { name: "deliveryType", source: { from: "slot", slot: "delivery_type" } },
  ],
  // FEASIBILITY, evaluated at SELECTION — before the anchor envelope exists, so
  // before the kernel can park anything. Every activity below reads the
  // customer's previous order one way or another, so a customer without one is
  // asking for something that cannot happen, and the honest moment to say so is
  // BEFORE the confirm rather than after their "sim".
  prechecks: [
    {
      id: "previous-order-present",
      predicate: { fact: "customerHasPreviousOrder", op: "isTrue" },
      template: "infeasible-no-previous-order",
    },
  ],
  activities: [
    {
      id: "reorder",
      capability: "order.reorder",
      payload: { orderId: { const: FIXTURE_PREVIOUS_ORDER_ID } },
      // THE COMPENSATED STEP. It is not the last thing the route runs, so a
      // later failure genuinely can strand it — which is what makes declaring a
      // compensator here a real statement rather than a decorative one.
      compensation: { by: "undoReorder" },
    },
    {
      id: "undoReorder",
      capability: "order.cart.ensure",
      payload: {},
      // A COMPENSATOR, and therefore terminal: the regress has to stop
      // somewhere, and the compiler stops it here
      // (`compensator-not-terminal`). Not routed either — a compensator is
      // reached by failure, never by the forward path
      // (`compensator-routed`).
      compensation: {
        terminal: "harmless",
        why: "the rollback itself; idempotent, and undoing an undo is a regress with no authored end",
      },
    },
    {
      id: "ensureCart",
      capability: "order.cart.ensure",
      payload: {},
      compensation: {
        terminal: "harmless",
        why: "idempotent — a session cart the customer already had is not a change to undo",
      },
    },
    {
      id: "finishCheckout",
      capability: "order.checkout.create",
      payload: {
        // The cart id is an AUTHORED CONSTANT — see FIXTURE_CART_ID. Without it
        // `requireCartIdForCartOps` refuses before any checkout guard runs, and
        // the fixture would prove only that a missing field is caught.
        cartId: { const: FIXTURE_CART_ID },
        paymentMethod: { param: "paymentMethod" },
        deliveryType: { param: "deliveryType" },
      },
      // IRREVERSIBLE, and the sharpest case in the corpus: a created checkout is
      // a money act. It is also the step that proves the runtime grants a
      // workflow NO authority — this is the anchor's own capability, and it
      // still meets `confirmLargeTicket` on its own terms when it runs as an
      // activity. It declares NO `confirmCoveredBy`, so under LE2-023's refined
      // rule it is an UNCOVERED confirm and behaves exactly as it always has:
      // above the money band this step does not EXECUTE and the run compensates.
      // That is deliberate and load-bearing — this fixture is the pin that
      // coverage did not become the default.
      compensation: {
        terminal: "irreversible",
        why: "a created checkout is a money act; no capability in the catalog withdraws one",
      },
    },
  ],
  // THE ROUTE. Branch first, then a step that can fail after the branch has
  // already mutated something — which is the shape compensation exists for.
  route: [
    {
      when: {
        fact: "previousOrderTotalInCentavos",
        op: "atLeast",
        value: FIXTURE_BRANCH_THRESHOLD_CENTAVOS,
      },
      // A previous order worth repeating: rebuild it.
      then: ["reorder"],
      // A trivial one: do not rebuild anything, just make sure a cart exists.
      // NOT an empty arm, deliberately — an arm that does nothing proves the
      // branch was taken only by the ABSENCE of a step, and absence is what a
      // broken predicate also produces.
      otherwise: ["ensureCart"],
    },
    { activity: "finishCheckout" },
  ],
  confirm: { template: "confirm" },
  templates: [
    {
      id: "confirm",
      text: "{confirmation} Em seguida eu repito os itens do seu pedido anterior, se valer a pena.",
    },
    { id: "completed", text: "Pronto! Concluí todas as etapas do seu pedido." },
    { id: "declined", text: "Tudo bem, não fiz nada. É só me chamar quando quiser." },
    {
      id: "failed",
      text: "Não consegui concluir todas as etapas. Já chamei alguém da equipe para te ajudar.",
    },
    {
      id: "compensated",
      text: "Não consegui concluir todas as etapas, então desfiz o que já tinha feito. Nada foi cobrado.",
    },
    {
      id: "stranded",
      text: "Não consegui concluir todas as etapas e não consegui desfazer tudo o que já tinha feito. Já chamei alguém da equipe para resolver isso com você.",
    },
    // THE PRE-CHECK'S OWN REASON. Not a generic refusal: it names the thing that
    // is missing, which is the only version of this sentence a customer can act
    // on.
    {
      id: "infeasible-no-previous-order",
      text: "Ainda não encontrei nenhum pedido anterior seu pra repetir. Assim que você fizer o primeiro, é só me chamar.",
    },
  ],
  outcomes: {
    completed: "completed",
    declined: "declined",
    failed: "failed",
    compensated: "compensated",
    stranded: "stranded",
  },
}

/** The proof corpus the runtime's end-to-end suite loads. */
export const FIXTURE_WORKFLOWS: readonly WorkflowDefinition[] = [
  FIXTURE_LINEAR_WORKFLOW,
  FIXTURE_CONDITIONAL_WORKFLOW,
]
