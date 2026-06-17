// llm_token_usage durable persistence (ERDS-059).
//
// Alongside the existing per-turn telemetry (the JSONL `llm.call` emit + the
// in-memory TokenUsageStore), this sink persists a DURABLE `llm_token_usage`
// row per llm.call: prompt/completion token split, the model, and an estimated
// USD cost derived from a per-model pricing map. The cost dashboards aggregate
// these rows by session and by customer.
//
// Determinism: this is TELEMETRY, strictly OUTSIDE the kernel decision boundary
// — Date.now / timestamps are fine, and every write is best-effort / FAIL-OPEN
// (a persistence failure logs and is swallowed so it can never affect a turn or
// a decision). Wired where the conductor consumes a completed turn's token total
// (the same emitTurn hook that already calls emitLlmCall).

import { logger } from "../lib/logger.js";

/**
 * Per-model pricing, USD per MILLION tokens. Current Anthropic rates
 * (claude-api skill, cached 2026-06-04): Sonnet 4.6 = $3 in / $15 out;
 * Opus 4.8/4.7 = $5 in / $25 out. Keyed by the exact model id the runtime
 * stamps (process.env.ANTHROPIC_MODEL — default claude-sonnet-4-6). A model
 * absent from this map falls back to DEFAULT_PRICE (Sonnet rates) so an
 * unmapped model still produces a non-zero, order-of-magnitude estimate rather
 * than 0 — the estimate is telemetry, never money-of-record.
 */
export interface ModelPrice {
  /** USD per 1,000,000 prompt (input) tokens. */
  readonly promptPerM: number;
  /** USD per 1,000,000 completion (output) tokens. */
  readonly completionPerM: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { promptPerM: 3, completionPerM: 15 },
  "claude-opus-4-8": { promptPerM: 5, completionPerM: 25 },
  "claude-opus-4-7": { promptPerM: 5, completionPerM: 25 },
  "claude-haiku-4-5": { promptPerM: 1, completionPerM: 5 },
};

/** Fallback when the model id is unmapped — Sonnet-tier rates. */
export const DEFAULT_PRICE: ModelPrice = { promptPerM: 3, completionPerM: 15 };

/** Resolve the pricing for a model id, falling back to the Sonnet default. */
export function priceForModel(model: string): ModelPrice {
  return PRICES[model] ?? DEFAULT_PRICE;
}

/**
 * Estimate the USD cost of a call. `(prompt*promptPerM + completion*completionPerM)/1e6`.
 * Returned as a number; the Decimal column stores it with 6-decimal precision.
 */
export function estimateUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = priceForModel(model);
  return (
    (promptTokens * price.promptPerM + completionTokens * price.completionPerM) /
    1_000_000
  );
}

/** The fields a single llm.call contributes to a durable usage row. */
export interface TokenUsageRecord {
  readonly sessionId: string;
  readonly customerId?: string;
  readonly channel?: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** ISO time the call was recorded (passed in — never read the clock here). */
  readonly recordedAt: string;
}

export interface TokenUsageSink {
  record(usage: TokenUsageRecord): void | Promise<void>;
}

/**
 * Minimal structural slice of the domain PrismaClient the sink needs: an
 * `llmTokenUsage.create`. The real `prisma` from `@ibatexas/domain` satisfies
 * this; tests inject a fake.
 */
export interface TokenUsagePrisma {
  llmTokenUsage: {
    create(args: {
      data: {
        sessionId: string;
        customerId?: string | null;
        channel?: string | null;
        model: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimatedUsd: number | string;
        recordedAt: string | Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * Durable token-usage sink backed by the `llm_token_usage` Postgres table.
 * Splits prompt/completion from the call metadata, applies the pricing map, and
 * persists one row per llm.call. Best-effort / FAIL-OPEN: a write failure logs
 * and is swallowed — cost telemetry must never break a turn.
 */
export function createPostgresTokenUsageSink(
  prisma: TokenUsagePrisma,
): TokenUsageSink {
  return {
    async record(usage) {
      try {
        const totalTokens = usage.promptTokens + usage.completionTokens;
        const estimatedUsd = estimateUsd(
          usage.model,
          usage.promptTokens,
          usage.completionTokens,
        );
        await prisma.llmTokenUsage.create({
          data: {
            sessionId: usage.sessionId,
            customerId: usage.customerId ?? null,
            channel: usage.channel ?? null,
            model: usage.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens,
            // Stored as a string so the pg Decimal column preserves full
            // precision regardless of JS float representation.
            estimatedUsd: estimatedUsd.toFixed(6),
            recordedAt: usage.recordedAt,
          },
        });
      } catch (err) {
        logger.warn(
          {
            component: "token-usage",
            sessionId: usage.sessionId,
            model: usage.model,
            err: (err as Error).message,
          },
          "llm_token_usage write failed (swallowed — turn unaffected)",
        );
      }
    },
  };
}
