// Audit sink wiring — Phase H.
//
// Bridges @ibatexas/nats-client.publishNatsEvent into the framework-agnostic
// AuditSink interface. Keeps @adjudicate/intent-audit domain-independent — this file
// is the IbateXas-specific adapter.
//
// Every intent capture emits one structured AuditRecord to
//   subject: "audit.intent.decision.v1"
// The event is additive — existing NATS consumers ignore it until they
// subscribe.

import {
  createConsoleSink,
  createNatsSink,
  multiSink,
  type AuditSink,
} from "@adjudicate/intent-audit"
import { publishNatsEvent } from "@ibatexas/nats-client"

let _sink: AuditSink | null = null

function loadSink(): AuditSink {
  if (_sink) return _sink
  // ConsoleSink for visibility in dev; NatsSink for the durable streaming
  // trail consumed by audit subscribers. Falls open: failure in either is
  // non-blocking via multiSink's Promise.allSettled.
  const nats = createNatsSink({
    publisher: {
      async publish(subject, payload) {
        // publishNatsEvent expects a "domain.action"-shaped event name without
        // the "audit." prefix? Actually our subject IS "audit.intent.decision.v1"
        // — publishNatsEvent prepends "ibatexas." so the resulting subject is
        // "ibatexas.audit.intent.decision.v1", which is fine. Subscribers
        // filter on the full subject.
        await publishNatsEvent(subject, payload as Record<string, unknown>)
      },
    },
  })
  const console = createConsoleSink({ prefix: "[ibx-audit]" })
  _sink = multiSink(console, nats)
  return _sink
}

/** @internal — for test isolation */
export function _resetAuditSink(): void {
  _sink = null
}

/** Return the configured audit sink. Always available; sinks are best-effort. */
export function getAuditSink(): AuditSink {
  return loadSink()
}
