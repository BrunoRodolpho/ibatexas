/**
 * NatsSink — streaming governance trail.
 *
 * Publishes each AuditRecord to a stable NATS subject. Adopters wire their
 * own NATS publisher behind the `NatsPublisher` interface — the IbateXas
 * adopter passes a wrapper around its `publishNatsEvent()`. Framework-
 * agnostic: any pub/sub system that accepts (subject, payload) works.
 *
 * P0-g: burst-failure detection. Audit is fail-open on the hot path, but a
 * sustained NATS outage means we silently buffer audit records in memory,
 * which becomes invisible data loss. After `failureThreshold` consecutive
 * publish failures the sink transitions to a "tripped" state and throws
 * `NatsSinkError` from `emit()` so the caller's error path fires loudly.
 * One successful publish resets the counter.
 */

import type { AuditRecord } from "@adjudicate/core";
import type { AuditSink } from "./sink.js";

export interface NatsPublisher {
  publish(subject: string, payload: unknown): Promise<void>;
}

export interface NatsSinkOptions {
  readonly publisher: NatsPublisher;
  /** Defaults to "audit.intent.decision.v1". */
  readonly subject?: string;
  /**
   * Consecutive failures before NatsSinkError is thrown. Default 10 — small
   * enough to fail loud quickly, large enough to absorb transient NATS hiccups.
   */
  readonly failureThreshold?: number;
  /**
   * Optional callback fired on each failure (so the caller can route into
   * Sentry/console without the sink itself depending on those packages).
   */
  readonly onFailure?: (event: NatsSinkFailureEvent) => void;
}

export interface NatsSinkFailureEvent {
  readonly subject: string;
  readonly errorClass: string;
  readonly consecutiveFailures: number;
}

export class NatsSinkError extends Error {
  constructor(
    public readonly subject: string,
    public readonly consecutiveFailures: number,
    public readonly cause: Error,
  ) {
    super(
      `NatsSink tripped after ${consecutiveFailures} consecutive failures on subject "${subject}"`,
    );
    this.name = "NatsSinkError";
  }
}

const DEFAULT_FAILURE_THRESHOLD = 10;

export function createNatsSink(opts: NatsSinkOptions): AuditSink {
  const subject = opts.subject ?? "audit.intent.decision.v1";
  const threshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  let consecutiveFailures = 0;

  return {
    async emit(record: AuditRecord) {
      try {
        await opts.publisher.publish(subject, record);
        // Success — reset the counter
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        const error = err instanceof Error ? err : new Error(String(err));
        opts.onFailure?.({
          subject,
          errorClass: error.name,
          consecutiveFailures,
        });
        if (consecutiveFailures >= threshold) {
          // Reset counter so the next attempt isn't preemptively tripped if
          // the publisher recovers; the throw signals the burst.
          const failuresAtTrip = consecutiveFailures;
          consecutiveFailures = 0;
          throw new NatsSinkError(subject, failuresAtTrip, error);
        }
        // Below threshold — log via callback (already done) and continue.
        // Throw so multiSink's Promise.allSettled records the failure.
        throw error;
      }
    },
  };
}
