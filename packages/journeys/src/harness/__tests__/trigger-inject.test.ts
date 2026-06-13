// T3-9 — trigger-injection helper containment + payload.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  TriggerInjectFingerprintRequiredError,
  injectPixFailureTrigger,
} from "../trigger-inject.js"

afterEach(() => vi.unstubAllEnvs())

describe("injectPixFailureTrigger — containment", () => {
  it("REFUSES without IBX_TEST_FINGERPRINT (cannot fire against a real broker)", async () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "")
    await expect(
      injectPixFailureTrigger({ orderId: "ord_1", paymentId: "pay_1", publish: async () => {} }),
    ).rejects.toBeInstanceOf(TriggerInjectFingerprintRequiredError)
  })

  it("publishes a failed-PIX payment.status_changed with a deterministic eventId when fingerprinted", async () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "test-fp")
    const published: Array<{ event: string; payload: Record<string, unknown> }> = []
    const { eventId } = await injectPixFailureTrigger({
      orderId: "ord_456",
      paymentId: "pay_9",
      publish: async (event, payload) => {
        published.push({ event, payload })
      },
    })

    expect(eventId).toBe("pix-trigger:pay_9:failed")
    expect(published).toHaveLength(1)
    expect(published[0]!.event).toBe("payment.status_changed")
    expect(published[0]!.payload).toMatchObject({
      orderId: "ord_456",
      paymentId: "pay_9",
      newStatus: "failed",
      method: "pix",
      eventId: "pix-trigger:pay_9:failed",
    })
  })

  it("supports the expired transition", async () => {
    vi.stubEnv("IBX_TEST_FINGERPRINT", "test-fp")
    const { eventId } = await injectPixFailureTrigger({
      orderId: "ord_1",
      paymentId: "pay_2",
      newStatus: "expired",
      publish: async () => {},
    })
    expect(eventId).toBe("pix-trigger:pay_2:expired")
  })
})
