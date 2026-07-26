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
 * The linear v0 fixture workflow. See the module doc for why each capability is
 * the one it is.
 */
export const FIXTURE_LINEAR_WORKFLOW: WorkflowDefinition = {
  id: FIXTURE_WORKFLOW_ID,
  title: "Fluxo de teste linear",
  description:
    "Fluxo de teste do runtime: finalizar o pedido e repetir os itens do pedido anterior.",
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
      // CLAIM-SOURCED: the order id comes from a claim the claims kernel
      // VALIDATED this turn — never from the model's own recollection.
      name: "previousOrderId",
      source: { from: "claim", claimType: "order-placed", field: "orderId" },
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
      payload: {},
    },
    {
      id: "reorder",
      capability: "order.reorder",
      payload: { orderId: { param: "previousOrderId" } },
    },
  ],
  confirm: { template: "confirm" },
  templates: [
    {
      id: "confirm",
      // `{confirmation}` is the KERNEL's own confirm prompt, quoted verbatim —
      // the grounded amount is never re-computed here.
      text: "{confirmation} Em seguida eu repito os itens do seu pedido anterior. Sua observação: {note}",
    },
    { id: "completed", text: "Pronto! Concluí todas as etapas do seu pedido." },
    { id: "declined", text: "Tudo bem, não fiz nada. É só me chamar quando quiser." },
    {
      id: "failed",
      text: "Não consegui concluir todas as etapas. Já chamei alguém da equipe para te ajudar.",
    },
  ],
  outcomes: { completed: "completed", declined: "declined", failed: "failed" },
}

/** The proof corpus the runtime's end-to-end suite loads. */
export const FIXTURE_WORKFLOWS: readonly WorkflowDefinition[] = [FIXTURE_LINEAR_WORKFLOW]
