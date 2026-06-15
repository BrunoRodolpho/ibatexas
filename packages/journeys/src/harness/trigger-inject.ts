// harness/trigger-inject.ts — the SINGLE allowlisted test-plane publish helper
// (plan-v2 T3-9, §9 governance critic).
//
// The journey test plane is otherwise subscribe-only on NATS (the NatsCapture
// oracle observes; check-bypass leg 8 fails ANY publish API call elsewhere in
// packages/journeys). A managed-agent journey, though, must WAKE the agent —
// the trigger bridge (T3-2) opens a capsule only on a real domain event. So
// this module is the one sanctioned publish surface, contained on four axes:
//
//   1. SINGLE PURPOSE — it publishes ONLY agent-trigger domain events (e.g.
//      `payment.status_changed` with a failed/expired PIX status); it is not a
//      generic publish escape hatch.
//   2. FINGERPRINT-GATED — `injectTriggerEvent` REFUSES unless
//      `IBX_TEST_FINGERPRINT` is set (only .env.test carries it; dev/prod never
//      do — D-010), so it can never fire against a real broker.
//   3. NOT IN THE DRIVER ACT-TOOL SET — the persona driver's acts are
//      {chat, http, fixture} only (DRIVER_ACT_TOOL_NAMES); this helper is NOT
//      one of them and the driver never imports it (grep-gated).
//   4. NOT IMPORTABLE FROM apps/* — check-bypass leg 6 already forbids apps/*
//      importing @ibatexas/journeys; this module rides that containment, and
//      leg 8's carve-out names it explicitly (the SECOND sanctioned publish
//      surface after nats-capture.ts, mirroring its containment posture).

import { publishNatsEvent } from "@ibatexas/nats-client"
import type { PaymentStatusChangedEvent } from "@ibatexas/types"
import { TEST_FINGERPRINT_ENV } from "./preflight.js"

/** Raised when the helper is invoked outside the fingerprinted test plane. */
export class TriggerInjectFingerprintRequiredError extends Error {
  constructor() {
    super(
      `injectTriggerEvent refused: ${TEST_FINGERPRINT_ENV} is not set. The agent-trigger ` +
        `injection helper is the test plane's ONLY sanctioned NATS publish and runs ONLY ` +
        `under the .env.test fingerprint (dev/prod never carry it) — see module header.`,
    )
    this.name = "TriggerInjectFingerprintRequiredError"
  }
}

function requireTestFingerprint(): void {
  const fingerprint = process.env[TEST_FINGERPRINT_ENV]
  if (fingerprint === undefined || fingerprint.trim() === "") {
    throw new TriggerInjectFingerprintRequiredError()
  }
}

export interface PixFailureTriggerOptions {
  /** Order the failed PIX charge belongs to (the agent's entity). */
  readonly orderId: string
  /** Payment id whose status changed. */
  readonly paymentId: string
  /** The failed transition the PIX agent triggers on. Default `payment.failed`. */
  readonly newStatus?: "failed" | "expired"
  /** Previous status (audit/event completeness). Default `processing`. */
  readonly previousStatus?: string
  /** Event version (monotonic per payment). Default 1. */
  readonly version?: number
  /** Injectable publisher (unit tests). Default: publishNatsEvent. */
  readonly publish?: (event: string, payload: Record<string, unknown>) => Promise<void>
}

/**
 * Inject a `payment.status_changed` (failed/expired PIX) event onto the bus to
 * WAKE the PIX remediation agent's trigger bridge in a journey. Short-form
 * subject (the client adds the `ibatexas.` prefix). REFUSES without the test
 * fingerprint. Returns the eventId published (the deterministic-nonce carrier
 * the agent turn dedups on).
 */
export async function injectPixFailureTrigger(
  options: PixFailureTriggerOptions,
): Promise<{ eventId: string }> {
  requireTestFingerprint()
  const newStatus = options.newStatus ?? "failed"
  // Deterministic, descriptive event id — the bridge keys redelivery dedup on it.
  const eventId = `pix-trigger:${options.paymentId}:${newStatus}`
  const payload: PaymentStatusChangedEvent = {
    orderId: options.orderId,
    paymentId: options.paymentId,
    previousStatus: options.previousStatus ?? "processing",
    newStatus,
    method: "pix",
    version: options.version ?? 1,
    timestamp: new Date().toISOString(),
  }
  const body = {
    ...payload,
    // The bridge stamps the trigger's stable broker id from this field.
    eventId,
  }
  // The default path literally calls publishNatsEvent so check-bypass leg 8
  // SEES this as a publish surface and the carve-out is grep-honest (this file
  // is named as the sanctioned exception); tests inject `publish` to assert the
  // payload without a broker.
  if (options.publish) {
    await options.publish("payment.status_changed", body)
  } else {
    await publishNatsEvent("payment.status_changed", body)
  }
  return { eventId }
}
