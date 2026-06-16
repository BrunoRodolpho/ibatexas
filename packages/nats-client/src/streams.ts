// JetStream stream provisioning — at-least-once migration, Phase 0.
//
// One durable stream per bounded-context domain. Every event published via
// publishNatsEvent() lands on the wire subject `ibatexas.{domain}.{action}`
// (the client adds the `ibatexas.` prefix), so each stream captures
// `ibatexas.{domain}.>`. Subjects are DISJOINT by domain — no two streams claim
// the same subject (JetStream rejects overlapping stream subjects).
//
// This module is ADDITIVE and delivery-neutral: provisioning streams does not
// change how messages are delivered. The Core NATS subscribers keep working;
// the streams simply begin durably CAPTURING the subjects they already see, so
// later phases can attach JetStream consumers (manual ack → real redelivery).
//
// Provisioning is idempotent: an absent stream is ADDED, a present one is
// UPDATED to the declared subjects/limits. Safe to call at every boot /
// `ibx db provision`.
//
// See ~/projects/jetstream-at-least-once-plan.md for the full migration plan.

import type { NatsConnection, StreamConfig } from "nats"
import { DiscardPolicy, nanos, RetentionPolicy, StorageType } from "nats"

const DAY_MS = 24 * 60 * 60 * 1000
// JetStream's publish-level dedup window (keyed on the Nats-Msg-Id header set in
// a later publish phase). 2h comfortably covers a publisher retry / outbox sweep.
const DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000

export interface StreamDef {
  readonly name: string
  /** Wire subjects (already `ibatexas.`-prefixed) this stream captures. */
  readonly subjects: ReadonlyArray<string>
  /** Max message age before discard (ms). */
  readonly maxAgeMs: number
}

// Per-domain streams. KEEP SUBJECTS DISJOINT (one domain → exactly one stream);
// the disjointness invariant is asserted by streams.test.ts. The domain set is
// the complete list of subjects published/subscribed across the app — adding a
// new event domain means adding it here (and the drift test will catch a miss
// once that phase lands).
export const STREAM_DEFS: ReadonlyArray<StreamDef> = [
  { name: "IBX_ORDERS", subjects: ["ibatexas.order.>", "ibatexas.cart.>"], maxAgeMs: 14 * DAY_MS },
  { name: "IBX_PAYMENTS", subjects: ["ibatexas.payment.>"], maxAgeMs: 30 * DAY_MS },
  { name: "IBX_RESERVATIONS", subjects: ["ibatexas.reservation.>"], maxAgeMs: 14 * DAY_MS },
  { name: "IBX_INTENT", subjects: ["ibatexas.intent.>"], maxAgeMs: 14 * DAY_MS },
  { name: "IBX_CONVERSATION", subjects: ["ibatexas.conversation.>"], maxAgeMs: 7 * DAY_MS },
  { name: "IBX_SUPPORT", subjects: ["ibatexas.support.>"], maxAgeMs: 14 * DAY_MS },
  { name: "IBX_CATALOG", subjects: ["ibatexas.product.>", "ibatexas.search.>", "ibatexas.review.>"], maxAgeMs: 7 * DAY_MS },
  { name: "IBX_NOTIFY", subjects: ["ibatexas.notification.>", "ibatexas.outreach.>"], maxAgeMs: 7 * DAY_MS },
  { name: "IBX_CUSTOMER", subjects: ["ibatexas.customer.>"], maxAgeMs: 30 * DAY_MS },
  { name: "IBX_ANALYTICS", subjects: ["ibatexas.analytics.>"], maxAgeMs: 7 * DAY_MS },
  { name: "IBX_AUDIT", subjects: ["ibatexas.audit.>"], maxAgeMs: 30 * DAY_MS },
  { name: "IBX_LEARNING", subjects: ["ibatexas.learning.>"], maxAgeMs: 30 * DAY_MS },
]

/**
 * Resolve the stream that owns a wire subject (e.g. "ibatexas.order.placed").
 * Returns undefined when no stream claims it (a coverage gap — every published
 * subject MUST resolve once consumers are migrated).
 */
export function streamForSubject(subject: string): string | undefined {
  for (const def of STREAM_DEFS) {
    for (const pattern of def.subjects) {
      // Patterns end in ".>"; match the domain prefix ("ibatexas.order.").
      const base = pattern.slice(0, -1)
      if (subject.startsWith(base)) return def.name
    }
  }
  return undefined
}

/** The desired JetStream config for a stream def (ms → ns conversions applied). */
export function streamConfig(def: StreamDef): Partial<StreamConfig> {
  return {
    name: def.name,
    subjects: [...def.subjects],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    discard: DiscardPolicy.Old,
    max_age: nanos(def.maxAgeMs),
    duplicate_window: nanos(DUPLICATE_WINDOW_MS),
    num_replicas: 1,
  }
}

export interface EnsureStreamsResult {
  readonly added: ReadonlyArray<string>
  readonly updated: ReadonlyArray<string>
}

/**
 * Idempotently provision every declared stream — ADD when absent, UPDATE the
 * subjects/limits when present. Returns which streams were added vs updated.
 *
 * Must run before any JetStream consumer is created (later phases) and is safe
 * to run on every boot. Does NOT change delivery for existing Core NATS
 * subscribers.
 */
export async function ensureStreams(nc: NatsConnection): Promise<EnsureStreamsResult> {
  const jsm = await nc.jetstreamManager()
  const added: string[] = []
  const updated: string[] = []
  for (const def of STREAM_DEFS) {
    const config = streamConfig(def)
    let exists = true
    try {
      await jsm.streams.info(def.name)
    } catch {
      exists = false
    }
    if (exists) {
      await jsm.streams.update(def.name, config)
      updated.push(def.name)
    } else {
      await jsm.streams.add(config)
      added.push(def.name)
    }
  }
  return { added, updated }
}
