/**
 * F6 — regenerate-on-empty (BKL-031). Proves the responder's completion retry:
 * retries while empty up to maxAttempts, stops on the first non-empty, returns
 * the last (empty) completion when all attempts fail so the holding fallback
 * still fires, and never retries a first-attempt non-empty.
 */
import { describe, it, expect, vi } from "vitest";
import {
  completeWithEmptyRetry,
  completeWithResilience,
  isEmptyCompletion,
} from "../complete-with-retry.js";

const noSleep = { sleep: async () => {}, delayForAttempt: () => 0 };

describe("isEmptyCompletion", () => {
  it.each([
    [undefined, true],
    [null, true],
    ["", true],
    ["   \n\t ", true],
    ["oi", false],
  ])("(%s) → %s", (text, expected) => {
    expect(isEmptyCompletion(text as string | null | undefined)).toBe(expected);
  });
});

describe("completeWithEmptyRetry (F6/BKL-031)", () => {
  it("returns the first completion without retrying when it is non-empty", async () => {
    const complete = vi.fn(async () => ({ text: "olá!" }));
    const { completion, attempts, recovered } = await completeWithEmptyRetry(complete, {
      maxAttempts: 3,
      ...noSleep,
    });
    expect(completion.text).toBe("olá!");
    expect(attempts).toBe(1);
    expect(recovered).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries on empty and recovers on a later non-empty completion", async () => {
    const outputs = ["", "  ", "recuperado"];
    const complete = vi.fn(async (attempt: number) => ({ text: outputs[attempt - 1]! }));
    const { completion, attempts, recovered } = await completeWithEmptyRetry(complete, {
      maxAttempts: 3,
      ...noSleep,
    });
    expect(completion.text).toBe("recuperado");
    expect(attempts).toBe(3);
    expect(recovered).toBe(true);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("stops at maxAttempts and returns the last (empty) completion for the holding fallback", async () => {
    const complete = vi.fn(async () => ({ text: "" }));
    const { completion, attempts, recovered } = await completeWithEmptyRetry(complete, {
      maxAttempts: 3,
      ...noSleep,
    });
    expect(completion.text).toBe("");
    expect(attempts).toBe(3);
    expect(recovered).toBe(false);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("never retries when maxAttempts is 1 (retry disabled)", async () => {
    const complete = vi.fn(async () => ({ text: "" }));
    const { attempts } = await completeWithEmptyRetry(complete, { maxAttempts: 1, ...noSleep });
    expect(attempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("preserves extra completion fields (usage tokens) on the returned completion", async () => {
    const complete = vi.fn(async () => ({ text: "ok", inputTokens: 10, outputTokens: 3 }));
    const { completion } = await completeWithEmptyRetry(complete, { maxAttempts: 2, ...noSleep });
    expect(completion).toMatchObject({ text: "ok", inputTokens: 10, outputTokens: 3 });
  });

  it("sleeps between retries using the injected sleep", async () => {
    const sleep = vi.fn(async () => {});
    const outputs = ["", "ok"];
    const complete = vi.fn(async (n: number) => ({ text: outputs[n - 1]! }));
    await completeWithEmptyRetry(complete, { maxAttempts: 3, sleep, delayForAttempt: (n) => n * 10 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
  });
});

describe("completeWithEmptyRetry — custom isEmpty predicate (FE-T01)", () => {
  it("uses the default text-only predicate when isEmpty is omitted (byte-identical to today)", async () => {
    // text empty but toolCalls populated — the default predicate retries on
    // text alone, unaware of toolCalls (the pre-FE-T01 responder behavior).
    const complete = vi.fn(async () => ({ text: "", toolCalls: [{ id: "a" }] }));
    const { attempts } = await completeWithEmptyRetry(complete, { maxAttempts: 2, ...noSleep });
    expect(attempts).toBe(2); // still retries — default predicate ignores toolCalls
  });

  it("a caller-supplied isEmpty predicate overrides the default (does not retry a structured tool call)", async () => {
    const complete = vi.fn(async () => ({ text: "", toolCalls: [{ id: "a" }] }));
    const isEmpty = (c: { text: string; toolCalls?: unknown[] }) =>
      isEmptyCompletion(c.text) && (c.toolCalls === undefined || c.toolCalls.length === 0);
    const { attempts } = await completeWithEmptyRetry(complete, {
      maxAttempts: 3,
      isEmpty,
      ...noSleep,
    });
    expect(attempts).toBe(1); // toolCalls present → not "empty" under the custom predicate
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("a caller-supplied isEmpty predicate retries a genuinely empty (text AND toolCalls empty) completion", async () => {
    const complete = vi.fn(async () => ({ text: "", toolCalls: [] as unknown[] }));
    const isEmpty = (c: { text: string; toolCalls?: unknown[] }) =>
      isEmptyCompletion(c.text) && (c.toolCalls === undefined || c.toolCalls.length === 0);
    const { attempts, recovered } = await completeWithEmptyRetry(complete, {
      maxAttempts: 3,
      isEmpty,
      ...noSleep,
    });
    expect(attempts).toBe(3);
    expect(recovered).toBe(false);
    expect(complete).toHaveBeenCalledTimes(3);
  });
});

describe("completeWithResilience (BKL-162 — completion-boundary error resilience)", () => {
  const genuinelyEmpty = (c: { text: string; toolCalls?: unknown[] }): boolean =>
    isEmptyCompletion(c.text) && (c.toolCalls === undefined || c.toolCalls.length === 0);

  it("returns ok:true on a first-attempt success without retrying", async () => {
    const complete = vi.fn(async () => ({ text: "olá!" }));
    const result = await completeWithResilience(complete, { maxAttempts: 2, ...noSleep });
    expect(result).toMatchObject({ ok: true, attempts: 1, recovered: false });
    if (result.ok) expect(result.completion.text).toBe("olá!");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("CAPTURES a thrown error and retries, recovering on a later success (never propagates)", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("Ollama 500: XML syntax error"))
      .mockResolvedValueOnce({ text: "recuperado" });
    // Explicit T: `completeWithResilience` is now unconstrained (it also wraps the
    // claim-planner's non-`{text}` ClaimPlan), so an untyped vi.fn no longer floors
    // T to `{text:string}` by inference — pin it for the `.completion.text` read.
    const result = await completeWithResilience<{ text: string }>(complete, { maxAttempts: 2, ...noSleep });
    expect(result).toMatchObject({ ok: true, attempts: 2, recovered: true });
    if (result.ok) expect(result.completion.text).toBe("recuperado");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("returns ok:false with the last error when every attempt throws (bounded)", async () => {
    const boom = new Error("Ollama 500: XML syntax error on line 3");
    const complete = vi.fn().mockRejectedValue(boom);
    const result = await completeWithResilience(complete, { maxAttempts: 2, ...noSleep });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(boom);
      expect(result.attempts).toBe(2);
    }
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not retry a throw when maxAttempts is 1 (retry disabled)", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("500"));
    const result = await completeWithResilience(complete, { maxAttempts: 1, ...noSleep });
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("default (no isEmpty) treats an empty-text completion as a VALID result — pure error-retry", async () => {
    // A structured/tool-call completion legitimately has empty text; it must not
    // be retried under the default predicate.
    const complete = vi.fn(async () => ({ text: "", toolCalls: [{ id: "a" }] }));
    const result = await completeWithResilience(complete, { maxAttempts: 3, ...noSleep });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("with an isEmpty predicate, retries a genuinely empty completion then returns ok:true with it (caller REFUSEs on empty)", async () => {
    const complete = vi.fn(async () => ({ text: "", toolCalls: [] as unknown[] }));
    const result = await completeWithResilience(complete, {
      maxAttempts: 2,
      isEmpty: genuinelyEmpty,
      ...noSleep,
    });
    expect(result).toMatchObject({ ok: true, attempts: 2, recovered: false });
    if (result.ok) expect(genuinelyEmpty(result.completion)).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("a trailing throw after an earlier empty yields ok:false (the error is the terminal state)", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ text: "", toolCalls: [] as unknown[] })
      .mockRejectedValueOnce(new Error("500"));
    const result = await completeWithResilience(complete, {
      maxAttempts: 2,
      isEmpty: genuinelyEmpty,
      ...noSleep,
    });
    expect(result.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("sleeps between retries using the injected sleep", async () => {
    const sleep = vi.fn(async () => {});
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("500"))
      .mockResolvedValueOnce({ text: "ok" });
    await completeWithResilience(complete, { maxAttempts: 3, sleep, delayForAttempt: (n) => n * 10 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10);
  });
});
