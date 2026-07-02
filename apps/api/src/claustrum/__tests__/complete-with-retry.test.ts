/**
 * F6 — regenerate-on-empty (BKL-031). Proves the responder's completion retry:
 * retries while empty up to maxAttempts, stops on the first non-empty, returns
 * the last (empty) completion when all attempts fail so the holding fallback
 * still fires, and never retries a first-attempt non-empty.
 */
import { describe, it, expect, vi } from "vitest";
import { completeWithEmptyRetry, isEmptyCompletion } from "../complete-with-retry.js";

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
