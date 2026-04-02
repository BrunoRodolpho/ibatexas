// Supervisor — Layer 3: real-time evaluator of response quality and strategy.
//
// The Supervisor evaluates user intent, emotional state, conversation momentum,
// and latency pressure to select an operating mode that the Orchestrator uses
// to modify the LLM's system prompt.
//
// HARD CONSTRAINTS:
// - Supervisor NEVER modifies state or data directly
// - Supervisor failure → ignore and continue (system works without it)
// - Execution must complete in <50ms (pure heuristics, no LLM call)

import type { SupervisorInput, SupervisorOutput } from "./machine/types.js"

// ── Default output (safe fallback) ──────────────────────────────────────────

const DEFAULT_OUTPUT: SupervisorOutput = {
  mode: "SPEED_MODE",
  modifiers: {
    verbosityScale: 1.0,
  },
  confidence: 0.3,
}

// ── Supervisor evaluation ───────────────────────────────────────────────────

/**
 * Evaluate the current conversation state and select an operating mode.
 * Pure heuristics — no LLM call, no state mutation.
 *
 * Returns a safe default on any error.
 */
export async function evaluateSupervisor(input: SupervisorInput): Promise<SupervisorOutput> {
  try {
    return evaluateHeuristics(input)
  } catch (err) {
    console.error("[supervisor] Evaluation failed, returning default:", (err as Error).message)
    return DEFAULT_OUTPUT
  }
}

// ── Heuristic engine ────────────────────────────────────────────────────────

function evaluateHeuristics(input: SupervisorInput): SupervisorOutput {
  const { userMessage, illusionContext, contextSnapshot, latencyBudgetMs } = input

  // ── First contact: always warm, never compressed ──
  if (
    input.stateValue === "first_contact" &&
    contextSnapshot.isNewCustomer
  ) {
    return {
      mode: "EMPATHY_MODE",
      modifiers: {
        toneAdjustment: "Cliente novo — seja caloroso e acolhedor. Apresente a marca com entusiasmo.",
        verbosityScale: 1.0,
      },
      confidence: 0.95,
      reasoning: "first_contact + new customer",
    }
  }

  // ── RECOVERY_MODE: customer is struggling ──
  if (contextSnapshot.fallbackCount >= 2) {
    return {
      mode: "RECOVERY_MODE",
      modifiers: {
        toneAdjustment: "Reconecte com o cliente, confirme que entendeu o pedido.",
        verbosityScale: 1.0,
      },
      confidence: 0.9,
      reasoning: `fallbackCount=${contextSnapshot.fallbackCount} >= 2`,
    }
  }

  // ── EMPATHY_MODE: frustration detected ──
  if (detectFrustration(userMessage)) {
    return {
      mode: "EMPATHY_MODE",
      modifiers: {
        toneAdjustment: "Use tom mais empático, reconheça a frustração do cliente.",
        verbosityScale: 1.0,
      },
      confidence: 0.8,
      reasoning: "frustration keywords detected",
    }
  }

  // ── DIRECT_MODE: ready to checkout, all slots filled ──
  if (
    contextSnapshot.items.length > 0 &&
    contextSnapshot.fulfillment !== null &&
    contextSnapshot.paymentMethod !== null
  ) {
    return {
      mode: "DIRECT_MODE",
      modifiers: {
        toneAdjustment: "Vá direto ao ponto.",
        verbosityScale: 0.7,
      },
      confidence: 0.85,
      reasoning: "cart + all slots filled",
    }
  }

  // ── SPEED_MODE: high momentum, short message, or low latency budget ──
  if (
    illusionContext.momentum === "high" &&
    userMessage.length < 20
  ) {
    return {
      mode: "SPEED_MODE",
      modifiers: {
        toneAdjustment: "Seja mais conciso.",
        verbosityScale: 0.6,
        skipUpsell: latencyBudgetMs < 1500,
      },
      confidence: 0.7,
      reasoning: `momentum=high, short message (${userMessage.length} chars)`,
    }
  }

  // ── SPEED_MODE: latency pressure ──
  if (latencyBudgetMs < 1000) {
    return {
      mode: "SPEED_MODE",
      modifiers: {
        toneAdjustment: "Seja mais conciso.",
        verbosityScale: 0.5,
        skipUpsell: true,
      },
      confidence: 0.75,
      reasoning: `latencyBudget=${latencyBudgetMs}ms < 1000ms`,
    }
  }

  // ── SPEED_MODE: 1-word messages indicate rapid interaction ──
  if (userMessage.trim().split(/\s+/).length === 1 && userMessage.length < 15) {
    return {
      mode: "SPEED_MODE",
      modifiers: {
        verbosityScale: 0.6,
      },
      confidence: 0.6,
      reasoning: `single-word message: "${userMessage.slice(0, 15)}"`,
    }
  }

  // ── Latency override: force DIRECT_MODE when behind schedule ──
  if (latencyBudgetMs < 2000 && latencyBudgetMs >= 1000) {
    return {
      mode: "DIRECT_MODE",
      modifiers: {
        toneAdjustment: "Responda rápido e objetivo — tempo curto.",
        verbosityScale: 0.5,
      },
      confidence: 0.8,
      reasoning: `latencyBudget=${latencyBudgetMs}ms < 2000ms, forcing direct`,
    }
  }

  // ── Default: SPEED_MODE with normal verbosity ──
  return DEFAULT_OUTPUT
}

// ── Frustration detection (pt-BR keywords) ──────────────────────────────────

const FRUSTRATION_PATTERNS = [
  /\b(problema|demora|não funciona|nao funciona|erro|bug)\b/i,
  /\b(cade|cadê|quanto tempo|esperando|tá demorando|ta demorando)\b/i,
  /\b(absurdo|ridículo|ridiculo|péssimo|pessimo|horrível|horrivel)\b/i,
  /\b(quero cancelar|desisto|esquece|deixa pra lá|deixa pra la)\b/i,
  /[!?]{2,}/, // multiple punctuation = frustration signal
]

function detectFrustration(message: string): boolean {
  return FRUSTRATION_PATTERNS.some((p) => p.test(message))
}
