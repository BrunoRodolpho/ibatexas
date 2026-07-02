/**
 * F6 — regenerate-on-empty for model completions (BKL-031).
 *
 * Live RCA: the self-hosted 4B returns an empty completion ~22% of the time; a
 * single empty response ghosts the customer (the webhook's `if (response.text)`
 * fail-open sends nothing). This wraps a model-completion call with a bounded,
 * jittered retry loop: retry while the returned `text` is empty/whitespace-only,
 * up to `maxAttempts` total. It ALWAYS returns the last completion (empty or
 * not) so the caller's holding-message fallback still fires when every attempt
 * is empty — the retry reduces ghosting, it never masks a persistent failure.
 *
 * Applies to the responder's `completeWith` seam, where an empty `text` is an
 * unambiguous "nothing to say to the customer". It is deliberately NOT applied
 * to the planner's completion seam, where an empty `text` is normal (structured
 * tool calls) or a legitimate no-intent (small-talk) — retrying there would be
 * a behavior change, not a resilience fix.
 */

export interface EmptyRetryOptions {
  /** Total attempts including the first (coerced to >= 1). */
  readonly maxAttempts: number;
  /** Delay (ms) before attempt N+1, given the completed attempt count `n`. */
  readonly delayForAttempt?: (n: number) => number;
  /** Injectable sleep so tests run without real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function isEmptyCompletion(text: string | null | undefined): boolean {
  return text == null || text.trim().length === 0;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Linear backoff with jitter: attempt 1→~150-250ms, 2→~300-400ms, …
const DEFAULT_DELAY = (n: number): number => 150 * n + Math.floor(Math.random() * 100);

export interface EmptyRetryResult<T> {
  readonly completion: T;
  /** Total attempts made (1 = no retry needed). */
  readonly attempts: number;
  /** True when an initial empty was recovered by a later non-empty attempt. */
  readonly recovered: boolean;
}

export async function completeWithEmptyRetry<T extends { text: string }>(
  complete: (attempt: number) => Promise<T>,
  options: EmptyRetryOptions,
): Promise<EmptyRetryResult<T>> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const delayForAttempt = options.delayForAttempt ?? DEFAULT_DELAY;

  let completion = await complete(1);
  let attempts = 1;
  while (isEmptyCompletion(completion.text) && attempts < maxAttempts) {
    await sleep(delayForAttempt(attempts));
    completion = await complete(attempts + 1);
    attempts += 1;
  }

  return {
    completion,
    attempts,
    recovered: attempts > 1 && !isEmptyCompletion(completion.text),
  };
}
