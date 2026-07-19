// JetStream stream provisioning (at-least-once migration, Phase 0) — unit tests.
//
// No network/Docker: ensureStreams is driven with a fake NatsConnection whose
// jetstreamManager() returns a stub StreamAPI. The taxonomy invariants (full
// domain coverage + disjoint subjects) are the load-bearing checks — a missed
// or overlapping domain would silently drop events once consumers migrate.

import { describe, it, expect, vi } from "vitest"
import type { NatsConnection } from "nats"
import {
  STREAM_DEFS,
  ensureStreams,
  streamConfig,
  streamForSubject,
} from "../streams.js"

// Every event domain published/subscribed across the app (first subject segment).
// MUST mirror the real publishNatsEvent/subscribeNatsEvent call sites — a domain
// here with no owning STREAM_DEF (or vice-versa) is a coverage gap that silently
// drops events once consumers migrate to JetStream. ("follow-up" was such a gap:
// follow-up.due is published by follow-up-poller.ts / consumed by
// cart-intelligence.ts but had no stream, so js.publish fell back to ephemeral
// Core publish under JetStream — now owned by IBX_NOTIFY.)
const ALL_DOMAINS = [
  "order", "cart", "payment", "reservation", "intent", "conversation",
  "support", "product", "search", "review", "notification", "outreach",
  "follow-up", "customer", "analytics", "audit",
]

describe("STREAM_DEFS taxonomy", () => {
  it("covers every event domain exactly once with disjoint, well-formed subjects", () => {
    const seen = new Map<string, string>() // domain -> owning stream
    for (const def of STREAM_DEFS) {
      for (const subj of def.subjects) {
        expect(subj.startsWith("ibatexas.")).toBe(true)
        expect(subj.endsWith(".>")).toBe(true)
        const domain = subj.slice("ibatexas.".length, -2)
        // Disjoint: JetStream rejects a subject claimed by two streams.
        expect(seen.has(domain)).toBe(false)
        seen.set(domain, def.name)
      }
    }
    for (const d of ALL_DOMAINS) {
      expect(seen.has(d)).toBe(true)
    }
  })

  it("has unique stream names", () => {
    const names = STREAM_DEFS.map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("streamForSubject", () => {
  it("resolves wire subjects to their owning stream", () => {
    expect(streamForSubject("ibatexas.order.placed")).toBe("IBX_ORDERS")
    expect(streamForSubject("ibatexas.cart.abandoned")).toBe("IBX_ORDERS")
    expect(streamForSubject("ibatexas.payment.status_changed")).toBe("IBX_PAYMENTS")
    expect(streamForSubject("ibatexas.review.submitted")).toBe("IBX_CATALOG")
    expect(streamForSubject("ibatexas.audit.intent.decision.v1")).toBe("IBX_AUDIT")
    // Regression: follow-up.due had no owning stream (fell back to ephemeral
    // Core publish under JetStream). It belongs to the notify/outreach domain.
    expect(streamForSubject("ibatexas.follow-up.due")).toBe("IBX_NOTIFY")
  })

  it("resolves every real production event subject to a stream (no coverage gap)", () => {
    // Mirrors the literal (publish|subscribe)NatsEvent("…") call sites in the app.
    // A new event whose domain lacks a STREAM_DEF will fail here before it can
    // silently fall back to a non-durable Core publish once JetStream is on.
    const PRODUCTION_SUBJECTS = [
      "analytics.event", "cart.abandoned", "cart.item_added",
      "conversation.message.appended", "customer.anonymize.medusa.pending",
      "follow-up.due", "intent.defer.timeout", "notification.send",
      "order.address_changed", "order.canceled", "order.disputed",
      "order.note_added", "order.payment_failed",
      "order.placed", "order.refunded", "order.status_changed", "order.type_changed",
      "outreach.sent", "payment.method_changed", "payment.status_changed",
      "product.intelligence.purge", "product.viewed", "reservation.cancelled",
      "reservation.created", "reservation.modified", "reservation.no_show",
      "review.prompt", "review.prompt.schedule", "review.submitted",
      "search.results_viewed", "support.handoff_requested",
    ]
    for (const ev of PRODUCTION_SUBJECTS) {
      expect(streamForSubject(`ibatexas.${ev}`)).toBeDefined()
    }
  })

  it("returns undefined for an unknown subject", () => {
    expect(streamForSubject("ibatexas.unknown.thing")).toBeUndefined()
  })
})

describe("streamConfig", () => {
  it("converts maxAgeMs to nanoseconds and uses Limits retention", () => {
    const def = STREAM_DEFS.find((d) => d.name === "IBX_PAYMENTS")!
    const cfg = streamConfig(def)
    expect(cfg.name).toBe("IBX_PAYMENTS")
    expect(cfg.subjects).toEqual(["ibatexas.payment.>"])
    expect(cfg.retention).toBe("limits")
    expect(cfg.max_age).toBe(def.maxAgeMs * 1_000_000) // ms → ns
    expect(cfg.duplicate_window).toBe(2 * 60 * 60 * 1000 * 1_000_000)
  })
})

function fakeNc(existing: Set<string>) {
  const add = vi.fn(async (cfg: { name: string }) => {
    existing.add(cfg.name)
  })
  const update = vi.fn(async () => {})
  const info = vi.fn(async (name: string) => {
    if (!existing.has(name)) throw new Error(`stream not found: ${name}`)
    return { config: { name } }
  })
  const nc = {
    jetstreamManager: vi.fn(async () => ({ streams: { add, update, info } })),
  } as unknown as NatsConnection
  return { nc, add, update, info }
}

describe("ensureStreams", () => {
  it("ADDs every stream when none exist", async () => {
    const { nc, add, update } = fakeNc(new Set())
    const res = await ensureStreams(nc)
    expect(add).toHaveBeenCalledTimes(STREAM_DEFS.length)
    expect(update).not.toHaveBeenCalled()
    expect(res.added).toEqual(STREAM_DEFS.map((d) => d.name))
    expect(res.updated).toEqual([])
  })

  it("UPDATEs existing streams (idempotent re-provision, no duplicate ADD)", async () => {
    const existing = new Set(STREAM_DEFS.map((d) => d.name))
    const { nc, add, update } = fakeNc(existing)
    const res = await ensureStreams(nc)
    expect(update).toHaveBeenCalledTimes(STREAM_DEFS.length)
    expect(add).not.toHaveBeenCalled()
    expect(res.updated).toHaveLength(STREAM_DEFS.length)
  })

  it("mixes ADD + UPDATE for a partially-provisioned cluster", async () => {
    const { nc, add } = fakeNc(new Set(["IBX_ORDERS", "IBX_PAYMENTS"]))
    const res = await ensureStreams(nc)
    expect(res.updated).toEqual(expect.arrayContaining(["IBX_ORDERS", "IBX_PAYMENTS"]))
    expect(add).toHaveBeenCalledTimes(STREAM_DEFS.length - 2)
  })
})
