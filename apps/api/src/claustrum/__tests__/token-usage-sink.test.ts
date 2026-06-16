// token-usage-sink — ERDS-059 token→USD persistence.
//
// Proves the pricing map + estimate + the createPostgresTokenUsageSink seam:
//   1. estimateUsd applies the per-model rate, falls back to Sonnet for unmapped;
//   2. the sink persists a row with the prompt/completion split + total + USD;
//   3. FAIL-OPEN: a prisma throw is swallowed (the turn is never broken).

import { describe, expect, it, vi } from "vitest";
import {
  createPostgresTokenUsageSink,
  estimateUsd,
  priceForModel,
  PRICES,
  DEFAULT_PRICE,
  type TokenUsagePrisma,
} from "../token-usage-sink.js";

describe("pricing", () => {
  it("knows the current Sonnet + Opus rates (USD per MTok)", () => {
    expect(PRICES["claude-sonnet-4-6"]).toEqual({ promptPerM: 3, completionPerM: 15 });
    expect(PRICES["claude-opus-4-8"]).toEqual({ promptPerM: 5, completionPerM: 25 });
  });

  it("falls back to the Sonnet default for an unmapped model", () => {
    expect(priceForModel("some-future-model")).toEqual(DEFAULT_PRICE);
  });

  it("estimates USD = (prompt*promptPerM + completion*completionPerM)/1e6", () => {
    // 1M prompt @ $3 + 1M completion @ $15 = $18 on Sonnet.
    expect(estimateUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    // 2000 prompt + 500 completion on Opus 4.8 → (2000*5 + 500*25)/1e6 = 0.0225.
    expect(estimateUsd("claude-opus-4-8", 2000, 500)).toBeCloseTo(0.0225, 6);
  });
});

describe("createPostgresTokenUsageSink", () => {
  it("persists a row with the split, total, and 6dp USD estimate", async () => {
    const create = vi.fn(async () => ({ id: "x" }));
    const prisma = { llmTokenUsage: { create } } as unknown as TokenUsagePrisma;

    await createPostgresTokenUsageSink(prisma).record({
      sessionId: "conv-1",
      customerId: "cus-1",
      channel: "web",
      model: "claude-opus-4-8",
      promptTokens: 2000,
      completionTokens: 500,
      recordedAt: "2026-06-16T12:00:00.000Z",
    });

    expect(create).toHaveBeenCalledTimes(1);
    const [arg] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(arg.data.sessionId).toBe("conv-1");
    expect(arg.data.customerId).toBe("cus-1");
    expect(arg.data.channel).toBe("web");
    expect(arg.data.totalTokens).toBe(2500);
    expect(arg.data.estimatedUsd).toBe("0.022500");
  });

  it("maps omitted optional fields to null", async () => {
    const create = vi.fn(async () => ({}));
    const prisma = { llmTokenUsage: { create } } as unknown as TokenUsagePrisma;

    await createPostgresTokenUsageSink(prisma).record({
      sessionId: "conv-2",
      model: "claude-sonnet-4-6",
      promptTokens: 10,
      completionTokens: 0,
      recordedAt: "2026-06-16T12:00:00.000Z",
    });

    const [arg] = create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(arg.data.customerId).toBeNull();
    expect(arg.data.channel).toBeNull();
  });

  it("fails open when prisma throws (turn unaffected)", async () => {
    const create = vi.fn(async () => {
      throw new Error("pg down");
    });
    const prisma = { llmTokenUsage: { create } } as unknown as TokenUsagePrisma;

    await expect(
      createPostgresTokenUsageSink(prisma).record({
        sessionId: "conv-3",
        model: "claude-sonnet-4-6",
        promptTokens: 5,
        completionTokens: 5,
        recordedAt: "2026-06-16T12:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});
