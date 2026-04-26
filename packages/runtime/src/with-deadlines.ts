// Deadline helpers for racing async generators against a hard timeout.
//
// The pattern: an orchestrator runs an async generator (e.g. an LLM stream)
// and wants to bail out at a wall-clock deadline regardless of where the
// generator is blocked. `Promise.race(gen.next(), deadlinePromise(signal))`
// breaks out the moment the AbortSignal fires.

/**
 * Sentinel returned by `deadlinePromise` when the abort signal fires.
 * Compare strict-equal against the result of `Promise.race` to detect
 * a deadline hit:
 *
 *   const result = await Promise.race([
 *     gen.next(),
 *     deadlinePromise(controller.signal),
 *   ]);
 *   if (result === DEADLINE_HIT) {
 *     await gen.return(undefined);
 *     return; // emit fallback, log, etc.
 *   }
 */
export const DEADLINE_HIT: unique symbol = Symbol("DEADLINE_HIT");

/**
 * Returns a promise that resolves with `DEADLINE_HIT` when the given
 * AbortSignal fires (or immediately if the signal is already aborted).
 *
 * Used with `Promise.race` against `generator.next()` so a blocked
 * downstream (a stuck LLM stream, a hung tool call) cannot hold the
 * orchestrator past its hard deadline.
 */
export function deadlinePromise(signal: AbortSignal): Promise<typeof DEADLINE_HIT> {
  return new Promise<typeof DEADLINE_HIT>((resolve) => {
    if (signal.aborted) {
      resolve(DEADLINE_HIT);
      return;
    }
    signal.addEventListener("abort", () => resolve(DEADLINE_HIT), {
      once: true,
    });
  });
}
