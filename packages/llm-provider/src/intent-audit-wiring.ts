// Audit sink wiring — Phase H + Task 18 (M4).
//
// Bridges @ibatexas/nats-client.publishNatsEvent into the framework-agnostic
// AuditSink interface. Keeps @adjudicate/audit domain-independent — this file
// is the IbateXas-specific adapter.
//
// Every intent capture emits one structured AuditRecord to
//   subject: "audit.intent.decision.v1"
// The event is additive — existing NATS consumers ignore it until they
// subscribe.
//
// Task 18 (M4 Audit & observability): the exposed sink wraps the fan-out
// multiSink with an AuditRedactor. Every record passes through the redactor
// BEFORE any concrete sink (console, NATS, future Postgres) sees it.
// Investigation 08 §"P0 #1" — without this wrap, `set_pix_details` payloads
// publish plaintext CPF/email/phone to NATS subject
// `ibatexas.audit.intent.decision.v1` and any subscriber with permission
// reads PII in cleartext.
//
// Composition order (top-down):
//   sink (exported)
//     └─ redactor.redact(record)
//         └─ innerSink = multiSink(consoleSink, natsSink)
//
// Bypass-detection: the only public entry point is `getAuditSink()`. Every
// IbateXas call site routes through this getter, so no caller can construct
// a raw multiSink and bypass the redactor. The grep-test
// (audit-redaction-contract.test.ts) asserts this invariant.

import type { AuditRecord } from "@adjudicate/core"
import {
  createConsoleSink,
  createNatsSink,
  multiSink,
  type AuditSink,
} from "@adjudicate/audit"
import { publishNatsEvent } from "@ibatexas/nats-client"
import { createAuditRedactor, type AuditRedactor } from "./audit-redactor.js"

let _sink: AuditSink | null = null
let _redactor: AuditRedactor | null = null

function loadRedactor(): AuditRedactor {
  if (_redactor) return _redactor
  // AUDIT_REDACT_SECRET MUST be set in production — see .env.example. Empty
  // is legal in dev; createAuditRedactor emits a console.warn on boot when
  // the salt is empty so the operator sees the warning during local runs.
  _redactor = createAuditRedactor({
    hashSecret: process.env.AUDIT_REDACT_SECRET ?? "",
  })
  return _redactor
}

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
  const console_ = createConsoleSink({ prefix: "[ibx-audit]" })
  const innerSink = multiSink(console_, nats)
  const redactor = loadRedactor()

  // Task 18 wrap — redactor MUST run before fan-out. Once a record reaches
  // `innerSink`, both the console line AND the NATS payload are downstream
  // copies; we cannot reach in and patch them. So we patch ONCE here,
  // in-process, on the record handed to `innerSink.emit`.
  _sink = {
    async emit(record: AuditRecord): Promise<void> {
      const redacted = redactor.redact(record)
      await innerSink.emit(redacted)
    },
  }
  return _sink
}

/** @internal — for test isolation */
export function _resetAuditSink(): void {
  _sink = null
  _redactor = null
}

/** @internal — for test access to the redactor used by the wired sink. */
export function _getAuditRedactor(): AuditRedactor {
  return loadRedactor()
}

/** Return the configured audit sink. Always available; sinks are best-effort. */
export function getAuditSink(): AuditSink {
  return loadSink()
}
