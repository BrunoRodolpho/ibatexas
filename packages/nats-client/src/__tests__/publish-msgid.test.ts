// publishMsgId — deterministic Nats-Msg-Id for JetStream publish-level dedup
// (jetstream-at-least-once-plan §3.4). Pure: no network / Docker.

import { describe, it, expect } from "vitest"
import { publishMsgId } from "../index.js"

describe("publishMsgId", () => {
  const data = JSON.stringify({ orderId: "o_1", total: 8900 })

  it("is deterministic for the same event + payload (a retry / outbox re-publish dedups)", () => {
    expect(publishMsgId("order.placed", data)).toBe(publishMsgId("order.placed", data))
  })

  it("differs when the payload differs", () => {
    expect(publishMsgId("order.placed", data)).not.toBe(
      publishMsgId("order.placed", JSON.stringify({ orderId: "o_2", total: 8900 })),
    )
  })

  it("differs when the event differs (no cross-subject collision)", () => {
    expect(publishMsgId("order.placed", data)).not.toBe(publishMsgId("order.canceled", data))
  })

  it("does not alias across the event/data field boundary", () => {
    // "a" + "bc" must not hash the same as "ab" + "c".
    expect(publishMsgId("a", "bc")).not.toBe(publishMsgId("ab", "c"))
  })

  it("returns a sha256 hex digest (64 lowercase hex chars)", () => {
    expect(publishMsgId("order.placed", data)).toMatch(/^[0-9a-f]{64}$/)
  })
})
