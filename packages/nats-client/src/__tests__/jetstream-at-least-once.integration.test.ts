// JetStream consumer at-least-once — REAL NATS integration (Phase 2 verification).
//
// Proves the actual C1/C2 fix end-to-end against a real nats:2.11 JetStream
// server (testcontainers, Docker required):
//   - a SUCCEEDING handler is ack'd exactly once (no spurious redelivery);
//   - a THROWING handler is REDELIVERED via nak and, after max_deliver, the
//     event lands in the DLQ via term() (terminal poison, stops redelivery);
//   - a handler that throws-then-succeeds RECOVERS (redelivered until it acks).
//
// This is the soak/integration gate the migration plan requires before the
// consumer cutover. It runs against the same nats:2.11 image as prod and dev.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers"
import {
  closeNatsConnection,
  ensureStreams,
  getNatsConnection,
  publishNatsEvent,
  setDlqHandler,
  subscribeNatsEvent,
} from "../index.js"

let container: StartedTestContainer
const dlqEvents: string[] = []

beforeAll(async () => {
  container = await new GenericContainer("nats:2.11-alpine")
    .withCommand(["-js"]) // JetStream, no auth (NODE_ENV=test ⇒ getNatsConnection allows it)
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .start()

  process.env.NATS_URL = `nats://${container.getHost()}:${container.getMappedPort(4222)}`
  process.env.NATS_JETSTREAM_ENABLED = "true"
  process.env.NATS_JS_MAX_DELIVER = "3"
  process.env.NATS_JS_ACK_WAIT_MS = "1000" // fast ack timeout
  process.env.NATS_JS_NAK_BASE_MS = "100" // fast redelivery
  process.env.NATS_JS_NAK_MAX_MS = "200"
  delete process.env.NATS_NKEY_SEED
  delete process.env.NATS_CREDS_PATH

  await closeNatsConnection()
  const nc = await getNatsConnection()
  await ensureStreams(nc)
  // Capture terminal (post-max-deliver) failures.
  setDlqHandler((event) => {
    dlqEvents.push(event)
    return Promise.resolve()
  })
}, 180_000)

afterAll(async () => {
  await closeNatsConnection()
  await container?.stop()
  for (const k of [
    "NATS_URL",
    "NATS_JETSTREAM_ENABLED",
    "NATS_JS_MAX_DELIVER",
    "NATS_JS_ACK_WAIT_MS",
    "NATS_JS_NAK_BASE_MS",
    "NATS_JS_NAK_MAX_MS",
  ]) {
    delete process.env[k]
  }
})

function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        reject(new Error("waitFor timed out"))
      }
    }, 50)
  })
}

describe("JetStream consumer — at-least-once (real NATS)", () => {
  it("ACKs a succeeding handler exactly once (no redelivery)", async () => {
    const calls: unknown[] = []
    const sub = await subscribeNatsEvent(
      "order.placed",
      async (p) => {
        calls.push(p)
      },
      { queueGroup: "it-ack" },
    )
    await publishNatsEvent("order.placed", { orderId: "ack-1" })
    await waitFor(() => calls.length >= 1)
    // Give a (wrong) redelivery time to fire — it must not.
    await new Promise((r) => setTimeout(r, 1500))
    expect(calls).toHaveLength(1)
    sub.unsubscribe()
  }, 30_000)

  it("REDELIVERS a throwing handler, then DLQs after max_deliver (throw→nak→term)", async () => {
    let attempts = 0
    const before = dlqEvents.filter((e) => e === "order.refunded").length
    const sub = await subscribeNatsEvent(
      "order.refunded",
      async () => {
        attempts += 1
        throw new Error("always fails")
      },
      { queueGroup: "it-fail" },
    )
    await publishNatsEvent("order.refunded", { orderId: "fail-1" })
    await waitFor(
      () => dlqEvents.filter((e) => e === "order.refunded").length > before,
      15_000,
    )
    // max_deliver=3 → delivered exactly 3 times, then terminal → DLQ once.
    expect(attempts).toBe(3)
    expect(dlqEvents.filter((e) => e === "order.refunded")).toHaveLength(before + 1)
    sub.unsubscribe()
  }, 30_000)

  it("RECOVERS: throws once, is redelivered, then succeeds (acks)", async () => {
    let attempts = 0
    const ok: unknown[] = []
    const sub = await subscribeNatsEvent(
      "order.canceled",
      async (p) => {
        attempts += 1
        if (attempts < 2) throw new Error("transient")
        ok.push(p)
      },
      { queueGroup: "it-recover" },
    )
    await publishNatsEvent("order.canceled", { orderId: "rec-1" })
    await waitFor(() => ok.length >= 1, 15_000)
    expect(attempts).toBe(2) // failed once → redelivered → succeeded
    expect(ok).toHaveLength(1)
    sub.unsubscribe()
  }, 30_000)
})
