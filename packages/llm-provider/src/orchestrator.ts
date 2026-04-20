// Orchestrator — Layer 2: Human Illusion Orchestrator.
//
// Wraps the 4-phase pipeline (runAgent) with:
// - LatencyEnvelope tracking (TTFB, soft deadline, hard deadline)
// - TTFB enforcement: emit "typing..." status if no response in 800ms
// - Hard deadline: true 4s cutoff via Promise.race (not just an abort flag)
// - Partial-text guard: if text already emitted, don't append fallback
//
// The Orchestrator is the public API for conversation processing.
// Both WhatsApp webhook and web chat route should use runOrchestrator.

import { type AgentContext, type AgentMessage, type StreamChunk } from "@ibatexas/types"
import { createLatencyEnvelope, type LatencyEnvelope, type OrderContext } from "./machine/types.js"
import { buildDeterministicFallback } from "./prompt-synthesizer.js"
import { runAgent } from "./agent.js"

// Re-export runAgent for backward compatibility
export { runAgent }

// ── Deadline sentinel ────────────────────────────────────────────────────────

const DEADLINE_HIT = Symbol("DEADLINE_HIT")

/**
 * Create a promise that resolves when the abort signal fires.
 * Used with Promise.race to break out of blocked generator.next() calls.
 */
function createDeadlinePromise(signal: AbortSignal): Promise<typeof DEADLINE_HIT> {
  return new Promise<typeof DEADLINE_HIT>((resolve) => {
    if (signal.aborted) { resolve(DEADLINE_HIT); return }
    signal.addEventListener("abort", () => resolve(DEADLINE_HIT), { once: true })
  })
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Run the conversation pipeline with latency tracking, TTFB enforcement,
 * and hard deadline protection.
 *
 * Drop-in replacement for runAgent with identical StreamChunk interface.
 */
export async function* runOrchestrator(
  message: string,
  history: AgentMessage[],
  context: AgentContext,
): AsyncGenerator<StreamChunk> {
  const envelope = createLatencyEnvelope()
  let firstChunkEmitted = false
  let textEmitted = false
  let ttfbTimerFired = false
  let softDeadlineEmitted = false

  // Kernel metadata — captured from kernel_done chunk for state-aware fallbacks
  let lastKernelState: { stateValue: string; context: Record<string, unknown> } | null = null

  // TTFB enforcement: if no text_delta within 800ms, emit typing status
  const ttfbTimer = setTimeout(() => {
    ttfbTimerFired = true
  }, envelope.ttfbDeadlineMs)

  // Soft deadline: signal LLM to wrap up (used by consumers for response compression)
  let softDeadlineHit = false
  const softDeadlineTimer = setTimeout(() => {
    softDeadlineHit = true
  }, envelope.softDeadlineMs)

  // Hard deadline: abort entire pipeline at 4s
  const abortController = new AbortController()
  const hardDeadlineTimer = setTimeout(() => {
    abortController.abort()
  }, envelope.hardDeadlineMs)

  // Promise that resolves when the hard deadline fires — used with Promise.race
  // to break out of blocked generator.next() calls
  const deadlinePromise = createDeadlinePromise(abortController.signal)

  try {
    const generator = runAgent(message, history, context)

    for (;;) {
      // Race generator.next() against hard deadline — THIS is the critical fix.
      // Without Promise.race, a blocked kernel (e.g. processCheckout 30s timeout)
      // would keep us stuck in generator.next() past the 4s deadline.
      const raceResult = await Promise.race([
        generator.next(),
        deadlinePromise,
      ])

      // ── Hard deadline won the race ──
      if (raceResult === DEADLINE_HIT) {
        console.warn("[orchestrator] Hard deadline hit — yielding state-aware fallback")

        // Fix B: If text was already emitted, DON'T append fallback.
        // A partial response is better than a frankenresponse.
        if (textEmitted) {
          // Yield truncation marker so user knows the response was cut short
          yield { type: "text_delta", delta: "..." }
          yield { type: "done" }

          // Explicitly stop the generator and abort any in-flight requests
          generator.return(undefined)
          abortController.abort()
          return
        }

        // No text emitted yet — yield deterministic fallback
        if (lastKernelState) {
          const fallback = buildDeterministicFallback(
            lastKernelState.stateValue,
            lastKernelState.context as unknown as OrderContext,
          )
          yield { type: "text_delta", delta: fallback }
        } else {
          yield {
            type: "text_delta",
            delta: "Desculpa a demora! Pode repetir o que precisa? Estou aqui pra te ajudar 🍖",
          }
        }
        yield { type: "done" }

        // Explicitly stop the generator and abort any in-flight requests
        generator.return(undefined)
        abortController.abort()
        return
      }

      // ── Normal generator result ──
      const { value: chunk, done } = raceResult
      if (done) return

      // Capture kernel metadata (don't forward to consumers)
      if (chunk.type === "kernel_done") {
        lastKernelState = { stateValue: chunk.stateValue, context: chunk.context }
        continue
      }

      // Emit TTFB status if timer fired before first text
      if (!firstChunkEmitted && ttfbTimerFired && chunk.type !== "status") {
        yield { type: "status" as const, message: "Só um instante…" }
      }

      if (chunk.type === "text_delta") {
        textEmitted = true
        if (!firstChunkEmitted) {
          firstChunkEmitted = true
          clearTimeout(ttfbTimer)
        }
      } else if (chunk.type === "pix_data") {
        if (!firstChunkEmitted) {
          firstChunkEmitted = true
          clearTimeout(ttfbTimer)
        }
      }

      // Emit soft deadline warning once — consumers can use this to adjust behavior
      if (softDeadlineHit && !softDeadlineEmitted && textEmitted) {
        softDeadlineEmitted = true
      }

      yield chunk
    }
  } catch (err) {
    console.error("[orchestrator] Unexpected error:", (err as Error).message)
    yield { type: "error", message: "Erro ao processar sua mensagem. Tente novamente." }
  } finally {
    clearTimeout(ttfbTimer)
    clearTimeout(softDeadlineTimer)
    clearTimeout(hardDeadlineTimer)
  }
}

/**
 * Get the remaining latency budget in milliseconds.
 * Useful for Supervisor to decide on response compression.
 */
export function getRemainingBudget(envelope: LatencyEnvelope): number {
  return Math.max(0, envelope.hardDeadlineMs - (Date.now() - envelope.messageReceivedAt))
}
