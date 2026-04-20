// E2E conversation scenario runner for IbateXas WhatsApp bot.
// Exercises the real pipeline: routeMessage() → XState actor → synthesizePrompt()
// Only external services (Medusa, Stripe, NATS, Anthropic) are mocked.

import { createActor } from "xstate"
import type { AgentMessage } from "@ibatexas/types"
import { routeMessage } from "../../router.js"
import { orderMachine, getStateString } from "../../machine/order-machine.js"
import { synthesizePrompt } from "../../prompt-synthesizer.js"
import { createDefaultContext } from "../../machine/types.js"
import type { OrderContext } from "../../machine/types.js"

// ── Fixture types ─────────────────────────────────────────────────────────────

export interface ScenarioTurn {
  input: string
  expectedEvents?: string[]
  expectedState?: string
  assertContext?: Record<string, unknown>
  assertPromptContains?: string[]
  assertPromptNotContains?: string[]
  assertTools?: string[]
  injectSearchResult?: { found: boolean; products: unknown[]; alternatives: string[] }
  injectCartResult?: { success: boolean; cartId: string; items: unknown[]; totalInCentavos: number; error?: string }
  injectDeliveryResult?: { inZone: boolean; feeInCentavos: number; etaMinutes: number; error?: string }
  injectCheckoutResult?: { success: boolean; paymentMethod: string; checkoutData: unknown }
  injectPixDetails?: { name: string; email: string; cpf: string }
}

export interface ScenarioFixture {
  name: string
  description: string
  channel: "whatsapp" | "web"
  customerId: string | null
  isNewCustomer?: boolean
  mealPeriod?: "lunch" | "dinner" | "closed"
  turns: ScenarioTurn[]
}

export interface TurnResult {
  turnIndex: number
  input: string
  events: Array<{ type: string; [k: string]: unknown }>
  stateValue: string
  context: Record<string, unknown>
  synthesized: { systemPrompt: string; availableTools: string[]; maxTokens: number }
  errors: string[]
}

// ── Dot-path accessor ─────────────────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce((current, key) => {
    if (current === null || current === undefined) return undefined
    if (key === "length" && Array.isArray(current)) return current.length
    return (current as Record<string, unknown>)[key]
  }, obj)
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function runScenario(fixture: ScenarioFixture): TurnResult[] {
  // Build initial context, patching in fixture overrides
  const initialContext: OrderContext = {
    ...createDefaultContext(fixture.channel, fixture.customerId),
    isNewCustomer: fixture.isNewCustomer ?? false,
  }

  const actor = createActor(orderMachine, { input: initialContext })
  actor.start()

  const history: AgentMessage[] = []
  const results: TurnResult[] = []

  for (let i = 0; i < fixture.turns.length; i++) {
    const turn = fixture.turns[i]
    const errors: string[] = []

    // 1. Route the message (pass current machine state for context-aware routing)
    const currentMachineState = getStateString(actor.getSnapshot())
    const events = routeMessage(turn.input, history, currentMachineState)

    // 2. Verify expectedEvents
    if (turn.expectedEvents) {
      const actualTypes = events.map((e) => e.type) as string[]
      for (const expected of turn.expectedEvents) {
        if (!actualTypes.includes(expected)) {
          errors.push(`expectedEvent "${expected}" not found. Got: ${actualTypes.join(", ")}`)
        }
      }
    }

    // 3. Send each event to actor and inject mock results at async-waiting states
    for (const event of events) {
      actor.send(event as Parameters<typeof actor.send>[0])

      let stateAfter = getStateString(actor.getSnapshot())

      // Inject mock results based on which async-waiting state we landed in
      if (stateAfter === "ordering.validating_item" && turn.injectSearchResult) {
        actor.send({ type: "SEARCH_RESULT", ...turn.injectSearchResult } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())
      }

      if (stateAfter === "ordering.adding_to_cart" && turn.injectCartResult) {
        actor.send({ type: "CART_UPDATED", ...turn.injectCartResult } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())
      }

      if (stateAfter === "checkout.estimating_delivery" && turn.injectDeliveryResult) {
        actor.send({ type: "DELIVERY_RESULT", ...turn.injectDeliveryResult } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())
      }

      // Inject PIX details (simulates LLM tool call → event injection)
      if (stateAfter === "checkout.collecting_pix_details" && turn.injectPixDetails) {
        actor.send({ type: "PIX_DETAILS_COLLECTED", payload: turn.injectPixDetails } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())
      }

      // Auto-confirm when reviewing PIX details with checkout injection pending
      if (stateAfter === "checkout.reviewing_pix_details" && (turn.injectCheckoutResult || turn.injectPixDetails)) {
        actor.send({ type: "CONFIRM_ORDER" } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())
      }

      // If we're at confirming with a checkout injection, auto-send CONFIRM_ORDER first
      if (stateAfter === "checkout.confirming" && turn.injectCheckoutResult) {
        actor.send({ type: "CONFIRM_ORDER" } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())
      }

      if (stateAfter === "checkout.processing_payment" && turn.injectCheckoutResult) {
        actor.send({ type: "CHECKOUT_RESULT", ...turn.injectCheckoutResult } as Parameters<typeof actor.send>[0])
        stateAfter = getStateString(actor.getSnapshot())

        // After successful checkout, auto-inject LOYALTY_LOADED
        if (stateAfter === "checkout.order_placed") {
          actor.send({ type: "LOYALTY_LOADED", stamps: 3 } as Parameters<typeof actor.send>[0])
        }
      }
    }

    // 4. Get final state string
    const stateValue = getStateString(actor.getSnapshot())

    // 5. Verify expectedState
    if (turn.expectedState && stateValue !== turn.expectedState) {
      errors.push(`expectedState "${turn.expectedState}" but got "${stateValue}"`)
    }

    // 6. Verify assertContext via dot-path access
    const context = actor.getSnapshot().context as unknown as Record<string, unknown>
    if (turn.assertContext) {
      for (const [path, expected] of Object.entries(turn.assertContext)) {
        const actual = getNestedValue(context, path)
        if (expected === "not_null") {
          if (actual === null || actual === undefined) {
            errors.push(`assertContext: "${path}" expected not_null but got ${JSON.stringify(actual)}`)
          }
        } else {
          if (actual !== expected) {
            errors.push(`assertContext: "${path}" expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`)
          }
        }
      }
    }

    // 7. Synthesize prompt — real call
    const synthesized = synthesizePrompt(stateValue, context as unknown as OrderContext, fixture.channel)

    // 8. Verify prompt assertions
    if (turn.assertPromptContains) {
      for (const substr of turn.assertPromptContains) {
        if (!synthesized.systemPrompt.includes(substr)) {
          errors.push(`assertPromptContains: "${substr}" not found in prompt`)
        }
      }
    }

    if (turn.assertPromptNotContains) {
      for (const substr of turn.assertPromptNotContains) {
        if (synthesized.systemPrompt.includes(substr)) {
          errors.push(`assertPromptNotContains: "${substr}" should NOT be in prompt but was`)
        }
      }
    }

    if (turn.assertTools) {
      for (const tool of turn.assertTools) {
        if (!synthesized.availableTools.includes(tool)) {
          errors.push(`assertTools: "${tool}" not in availableTools: [${synthesized.availableTools.join(", ")}]`)
        }
      }
    }

    // 9. Push to history
    history.push({ role: "user", content: turn.input })
    history.push({ role: "assistant", content: "[mock assistant]" })

    results.push({
      turnIndex: i,
      input: turn.input,
      events: events as Array<{ type: string; [k: string]: unknown }>,
      stateValue,
      context,
      synthesized,
      errors,
    })
  }

  actor.stop()
  return results
}
