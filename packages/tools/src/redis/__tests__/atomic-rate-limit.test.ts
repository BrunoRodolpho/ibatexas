import { describe, it, expect, vi } from "vitest";
import { atomicIncr } from "../atomic-rate-limit.js";

function createMockRedis(evalResult: unknown = 1) {
  return {
    eval: vi.fn().mockResolvedValue(evalResult),
  };
}

describe("atomicIncr", () => {
  it("calls redis.eval with the Lua script, key and TTL", async () => {
    const redis = createMockRedis(1);
    const count = await atomicIncr(redis as never, "test:key", 3600);

    expect(count).toBe(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);

    const [script, options] = redis.eval.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(script).toContain("INCR");
    expect(script).toContain("EXPIRE");
    expect(options.keys).toEqual(["test:key"]);
    expect(options.arguments).toEqual(["3600"]);
  });

  it("returns the counter value as a number", async () => {
    const redis = createMockRedis(5);
    const count = await atomicIncr(redis as never, "test:key", 60);
    expect(count).toBe(5);
  });

  it("converts string result to number", async () => {
    // Some Redis clients return Lua numbers as strings
    const redis = createMockRedis("3");
    const count = await atomicIncr(redis as never, "test:key", 60);
    expect(count).toBe(3);
  });

  it("propagates Redis errors", async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error("NOSCRIPT")),
    };
    await expect(atomicIncr(redis as never, "test:key", 60)).rejects.toThrow("NOSCRIPT");
  });
});
