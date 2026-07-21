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
 * unambiguous "nothing to say to the customer". The DEFAULT predicate
 * (`isEmptyCompletion(completion.text)`) is deliberately NOT what the planner's
 * completion seam wants: an empty `text` there is normal (a structured tool
 * call was made) or a legitimate no-intent (small-talk, where the model still
 * says something in `text`) — text-only emptiness there is not a failure
 * signal on its own. FE-T01 threads a STRICTER caller-supplied `isEmpty`
 * predicate for the planner's extraction seam (`text` empty AND no
 * `toolCalls` — see `ibatexas-planner.ts`), so this same bounded-retry
 * mechanism now also backs "genuinely empty completion → repair-or-refuse"
 * without changing the responder's byte-identical default behavior.
 */

export interface EmptyRetryOptions<T = { text: string }> {
  /** Total attempts including the first (coerced to >= 1). */
  readonly maxAttempts: number;
  /** Delay (ms) before attempt N+1, given the completed attempt count `n`. */
  readonly delayForAttempt?: (n: number) => number;
  /** Injectable sleep so tests run without real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Predicate deciding whether a completion counts as "empty" (and should be
   * retried). Defaults to `isEmptyCompletion(completion.text)` — the original
   * F6/BKL-031 responder behavior, byte-identical when omitted. FE-T01's
   * planner extraction seam passes a stricter predicate (text empty AND no
   * tool calls) so a legitimate no-intent completion is never retried.
   */
  readonly isEmpty?: (completion: T) => boolean;
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
  options: EmptyRetryOptions<T>,
): Promise<EmptyRetryResult<T>> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const delayForAttempt = options.delayForAttempt ?? DEFAULT_DELAY;
  const isEmpty = options.isEmpty ?? ((c: T) => isEmptyCompletion(c.text));

  let completion = await complete(1);
  let attempts = 1;
  while (isEmpty(completion) && attempts < maxAttempts) {
    await sleep(delayForAttempt(attempts));
    completion = await complete(attempts + 1);
    attempts += 1;
  }

  return {
    completion,
    attempts,
    recovered: attempts > 1 && !isEmpty(completion),
  };
}

/**
 * BKL-162 — resilience for the PLANNER's completion boundary.
 *
 * `completeWithEmptyRetry` above retries an EMPTY completion but PROPAGATES a
 * thrown error — which is exactly the silent-turn defect on the planner: the
 * self-hosted 4B emits malformed tool-call XML on the read-tool surface →
 * Ollama returns HTTP 500 → the completion call THROWS a `CompletionError` →
 * the turn aborts before `turn_trace`, with no reply and no incident.
 *
 * This variant CAPTURES a thrown error and retries (bounded, jittered), so a
 * completion failure never propagates past the planner. It also retries an
 * empty result when an `isEmpty` predicate is supplied (default: never — pure
 * error-retry, so a legitimate structured/tool-call completion is untouched).
 * It returns a discriminated result: `ok:true` with the completion (possibly a
 * trailing EMPTY, so the caller's empty-repair REFUSE still fires, byte-
 * identical to `completeWithEmptyRetry`), or `ok:false` with the last error so
 * the caller degrades to an honest extraction-failure REFUSE — never silence.
 *
 * The single re-prompt IS the read-surface "repair": a 500 yields no model
 * output to parse-repair, so a bounded deterministic retry is the only honest
 * repair available (FE-T01 repair-or-refuse parity for the read frame).
 */
export type ResilientCompletionResult<T> =
  | { readonly ok: true; readonly completion: T; readonly attempts: number; readonly recovered: boolean }
  | { readonly ok: false; readonly error: unknown; readonly attempts: number };

export async function completeWithResilience<T>(
  complete: (attempt: number) => Promise<T>,
  options: EmptyRetryOptions<T>,
): Promise<ResilientCompletionResult<T>> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const delayForAttempt = options.delayForAttempt ?? DEFAULT_DELAY;
  // Default: never treat a completion as empty — pure error-retry. Callers that
  // ALSO want empty-repair (the extraction pass) pass isGenuinelyEmptyCompletion.
  const isEmpty = options.isEmpty ?? ((): boolean => false);

  let attempts = 0;
  let lastEmpty: T | undefined;
  let lastError: unknown;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const completion = await complete(attempts);
      if (!isEmpty(completion)) {
        return { ok: true, completion, attempts, recovered: attempts > 1 };
      }
      lastEmpty = completion;
      lastError = undefined;
    } catch (err) {
      lastError = err;
      lastEmpty = undefined;
    }
    if (attempts < maxAttempts) await sleep(delayForAttempt(attempts));
  }

  // Exhausted. A trailing EMPTY is still a usable completion (the caller's
  // empty-repair REFUSE fires on it); a trailing THROW leaves no completion →
  // ok:false so the caller REFUSEs on the error rather than the turn aborting.
  if (lastEmpty !== undefined) {
    return { ok: true, completion: lastEmpty, attempts, recovered: false };
  }
  return { ok: false, error: lastError, attempts };
}
