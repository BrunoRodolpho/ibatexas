// Unit tests for handoff-subscriber
// Exercises startHandoffSubscriber() by capturing the NATS callback and invoking it directly.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { startHandoffSubscriber } from "../subscribers/handoff-subscriber.js"

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn())
const mockGetWhatsAppSender = vi.hoisted(() => vi.fn())
// The subscriber now records escalation state (D2). Mock the store at its module
// boundary so it's a silent no-op here, leaving the dedup/notification paths
// (which is what these tests assert) byte-identical to before.
const mockRecordHandoff = vi.hoisted(() => vi.fn(async () => undefined))
// AUT-017 — the subscriber also projects a parked money intent onto the record.
const mockAppendPendingIntent = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
}))

vi.mock("@ibatexas/tools", () => ({
  getWhatsAppSender: mockGetWhatsAppSender,
}))

vi.mock("../escalation/escalation-store.js", () => ({
  getEscalationStore: vi.fn(async () => ({
    recordHandoff: mockRecordHandoff,
    appendPendingIntent: mockAppendPendingIntent,
  })),
}))

// W1 Phase-2: a handoff opening on a session with an OPEN incident auto-resolves
// it (HANDED_OFF). The seam is its own unit-tested module; stub it here so these
// subscriber tests stay isolated from the incident store / DB.
vi.mock("../incidents/incident-auto-close.js", () => ({
  resolveIncidentOnHandoff: vi.fn(async () => undefined),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Capture the NATS callback registered by startHandoffSubscriber */
async function getRegisteredCallback(): Promise<(payload: unknown) => Promise<void>> {
  await startHandoffSubscriber()
  expect(mockSubscribeNatsEvent).toHaveBeenCalledOnce()
  const [subject, callback] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]
  expect(subject).toBe("support.handoff_requested")
  return callback
}

function makeLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("handoff-subscriber", () => {
  let originalStaffPhone: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    originalStaffPhone = process.env.STAFF_NOTIFICATION_PHONE
  })

  afterEach(() => {
    if (originalStaffPhone !== undefined) {
      process.env.STAFF_NOTIFICATION_PHONE = originalStaffPhone
    } else {
      delete process.env.STAFF_NOTIFICATION_PHONE
    }
  })

  it("logs handoff request with session and reason", async () => {
    const log = makeLogger()
    delete process.env.STAFF_NOTIFICATION_PHONE

    const callback = await getRegisteredCallback()
    // Manually invoke with a logger argument by re-calling with log
    mockSubscribeNatsEvent.mockClear()
    await startHandoffSubscriber(log as never)
    const [, callbackWithLog] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callbackWithLog({ sessionId: "sess_abc123", reason: "dúvida sobre cardápio" })

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "sess_abc123", reason: "dúvida sobre cardápio" }),
      expect.stringContaining("support.handoff_requested"),
    )

    // Suppress unused variable warning
    void callback
  })

  it("records escalation state (D2) so the session is paused + enqueued", async () => {
    delete process.env.STAFF_NOTIFICATION_PHONE
    const callback = await getRegisteredCallback()
    await callback({ sessionId: "sess_takeover", reason: "falar com humano" })

    expect(mockRecordHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_takeover", reason: "falar com humano" }),
    )
  })

  it("logs handoff request without reason", async () => {
    const log = makeLogger()
    delete process.env.STAFF_NOTIFICATION_PHONE

    await startHandoffSubscriber(log as never)
    const [, callbackWithLog] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callbackWithLog({ sessionId: "sess_xyz" })

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "sess_xyz", reason: undefined }),
      expect.stringContaining("support.handoff_requested"),
    )
  })

  it("sends WhatsApp notification to staff when STAFF_NOTIFICATION_PHONE is configured", async () => {
    process.env.STAFF_NOTIFICATION_PHONE = "+5511999990001"

    const mockSendText = vi.fn().mockResolvedValue(undefined)
    mockGetWhatsAppSender.mockReturnValue({ sendText: mockSendText })

    const log = makeLogger()
    await startHandoffSubscriber(log as never)
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callback({ sessionId: "sess_notify", reason: "precisa de ajuda" })

    expect(mockGetWhatsAppSender).toHaveBeenCalled()
    expect(mockSendText).toHaveBeenCalledOnce()
    expect(mockSendText).toHaveBeenCalledWith(
      "whatsapp:+5511999990001",
      expect.objectContaining({ text: expect.stringContaining("sess_notify") }),
    )
  })

  it("includes reason in WhatsApp message when provided", async () => {
    process.env.STAFF_NOTIFICATION_PHONE = "+5511999990002"

    const mockSendText = vi.fn().mockResolvedValue(undefined)
    mockGetWhatsAppSender.mockReturnValue({ sendText: mockSendText })

    const log = makeLogger()
    await startHandoffSubscriber(log as never)
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callback({ sessionId: "sess_reason", reason: "problema no pedido" })

    const [, message] = mockSendText.mock.calls[0] as [string, { text: string }]
    expect(message.text).toContain("problema no pedido")
  })

  it("skips WhatsApp notification when STAFF_NOTIFICATION_PHONE is not set", async () => {
    delete process.env.STAFF_NOTIFICATION_PHONE

    const mockSendText = vi.fn()
    mockGetWhatsAppSender.mockReturnValue({ sendText: mockSendText })

    const log = makeLogger()
    await startHandoffSubscriber(log as never)
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callback({ sessionId: "sess_no_phone" })

    expect(mockSendText).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("STAFF_NOTIFICATION_PHONE not set"),
    )
  })

  it("skips WhatsApp notification when sender is not configured", async () => {
    process.env.STAFF_NOTIFICATION_PHONE = "+5511999990003"

    // getWhatsAppSender returns null — WhatsApp not configured
    mockGetWhatsAppSender.mockReturnValue(null)

    const log = makeLogger()
    await startHandoffSubscriber(log as never)
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callback({ sessionId: "sess_no_sender" })

    // No error thrown — graceful skip
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("WhatsApp sender not configured"),
    )
  })

  it("logs error when WhatsApp notification fails", async () => {
    process.env.STAFF_NOTIFICATION_PHONE = "+5511999990004"

    const mockSendText = vi.fn().mockRejectedValue(new Error("Twilio outage"))
    mockGetWhatsAppSender.mockReturnValue({ sendText: mockSendText })

    const log = makeLogger()
    await startHandoffSubscriber(log as never)
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as [string, (payload: unknown) => Promise<void>]

    await callback({ sessionId: "sess_fail" })

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "sess_fail" }),
      expect.stringContaining("Failed to send WhatsApp notification"),
    )
  })

  it("subscribes to the correct NATS subject", async () => {
    await startHandoffSubscriber()

    expect(mockSubscribeNatsEvent).toHaveBeenCalledWith(
      "support.handoff_requested",
      expect.any(Function),
      { queueGroup: "handoff-subscriber" },
    )
  })

  // ── AUT-017 — parked-money-intent projection + staff message enrichment ──────

  it("projects a parked money intent onto the record when parkToken/intentHash/intentKind are present", async () => {
    delete process.env.STAFF_NOTIFICATION_PHONE
    const callback = await getRegisteredCallback()
    await callback({
      sessionId: "admin:owner1",
      reason: "acima do limite",
      parkToken: "park-tok-1",
      intentHash: "sha256:abc",
      intentKind: "payment.refund.issue",
      summaryPtBr: "reembolso de R$ 1.500,00",
    })

    expect(mockAppendPendingIntent).toHaveBeenCalledWith(
      "admin:owner1",
      expect.objectContaining({
        token: "park-tok-1",
        intentHash: "sha256:abc",
        intentKind: "payment.refund.issue",
        summaryPtBr: "reembolso de R$ 1.500,00",
        status: "pending",
      }),
    )
  })

  it("does NOT project (or append) when no parkToken rides the event", async () => {
    delete process.env.STAFF_NOTIFICATION_PHONE
    const callback = await getRegisteredCallback()
    await callback({ sessionId: "sess_plain", reason: "dúvida" })
    expect(mockAppendPendingIntent).not.toHaveBeenCalled()
  })

  it("enriches the staff WhatsApp message with the pending-approval (OWNER) line", async () => {
    process.env.STAFF_NOTIFICATION_PHONE = "+5511999990005"
    const mockSendText = vi.fn().mockResolvedValue(undefined)
    mockGetWhatsAppSender.mockReturnValue({ sendText: mockSendText })

    const log = makeLogger()
    await startHandoffSubscriber(log as never)
    const [, callback] = mockSubscribeNatsEvent.mock.calls[0] as [
      string,
      (payload: unknown) => Promise<void>,
    ]

    await callback({
      sessionId: "admin:owner1",
      reason: "acima do limite",
      parkToken: "park-tok-1",
      intentHash: "sha256:abc",
      intentKind: "payment.refund.issue",
      summaryPtBr: "reembolso de R$ 1.500,00",
    })

    const [, message] = mockSendText.mock.calls[0] as [string, { text: string }]
    expect(message.text).toContain("Ação pendente de aprovação (OWNER)")
    expect(message.text).toContain("reembolso de R$ 1.500,00")
    expect(message.text).toContain("Escalações")
  })
})
