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
  it("upserts (idempotent on turnId) with the split, total, and 6dp USD estimate", async () => {
    const upsert = vi.fn(async () => ({ id: "x" }));
    const prisma = { llmTokenUsage: { upsert } } as unknown as TokenUsagePrisma;

    await createPostgresTokenUsageSink(prisma).record({
      turnId: "turn-1",
      sessionId: "conv-1",
      customerId: "cus-1",
      channel: "web",
      model: "claude-opus-4-8",
      promptTokens: 2000,
      completionTokens: 500,
      recordedAt: "2026-06-16T12:00:00.000Z",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const [arg] = upsert.mock.calls[0] as unknown as [
      {
        where: { turnId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      },
    ];
    expect(arg.where).toEqual({ turnId: "turn-1" });
    expect(arg.create.turnId).toBe("turn-1");
    expect(arg.create.sessionId).toBe("conv-1");
    expect(arg.create.customerId).toBe("cus-1");
    expect(arg.create.channel).toBe("web");
    expect(arg.create.totalTokens).toBe(2500);
    expect(arg.create.estimatedUsd).toBe("0.022500");
    // The update block carries the same mutable data (a retry overwrites
    // identically) and must NOT include the turnId key itself.
    expect(arg.update.totalTokens).toBe(2500);
    expect(arg.update).not.toHaveProperty("turnId");
  });

  it("is idempotent on turnId: a retry keys the upsert on the same turnId", async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma = { llmTokenUsage: { upsert } } as unknown as TokenUsagePrisma;
    const sink = createPostgresTokenUsageSink(prisma);
    const rec = {
      turnId: "turn-dup",
      sessionId: "conv-1",
      model: "claude-sonnet-4-6",
      promptTokens: 10,
      completionTokens: 5,
      recordedAt: "2026-06-16T12:00:00.000Z",
    };
    await sink.record(rec);
    await sink.record(rec); // a BullMQ/turn retry of the SAME turn

    // Both calls key on the same turnId, so the DB collapses them to one row.
    expect(upsert).toHaveBeenCalledTimes(2);
    const whereOf = (i: number) =>
      (upsert.mock.calls[i] as unknown as [{ where: { turnId: string } }])[0]
        .where;
    expect(whereOf(0)).toEqual({ turnId: "turn-dup" });
    expect(whereOf(1)).toEqual({ turnId: "turn-dup" });
  });

  it("maps omitted optional fields to null", async () => {
    const upsert = vi.fn(async () => ({}));
    const prisma = { llmTokenUsage: { upsert } } as unknown as TokenUsagePrisma;

    await createPostgresTokenUsageSink(prisma).record({
      turnId: "turn-2",
      sessionId: "conv-2",
      model: "claude-sonnet-4-6",
      promptTokens: 10,
      completionTokens: 0,
      recordedAt: "2026-06-16T12:00:00.000Z",
    });

    const [arg] = upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown> }];
    expect(arg.create.customerId).toBeNull();
    expect(arg.create.channel).toBeNull();
  });

  it("fails open when prisma throws (turn unaffected)", async () => {
    const upsert = vi.fn(async () => {
      throw new Error("pg down");
    });
    const prisma = { llmTokenUsage: { upsert } } as unknown as TokenUsagePrisma;

    await expect(
      createPostgresTokenUsageSink(prisma).record({
        turnId: "turn-3",
        sessionId: "conv-3",
        model: "claude-sonnet-4-6",
        promptTokens: 5,
        completionTokens: 5,
        recordedAt: "2026-06-16T12:00:00.000Z",
      }),
    ).resolves.toBeUndefined();
  });
});
