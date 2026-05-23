// Unit tests for conversation-archiver subscriber governance — Task 16.
//
// What's under test:
//   1. Each message in a batch becomes a separate conversation.message.append
//      envelope (SYSTEM taint, deterministic nonce per message).
//   2. EXECUTE persists; REFUSE pushes DLQ + skips persistence.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IntentEnvelope } from "@adjudicate/core";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockSubscribeNatsEvent = vi.hoisted(() => vi.fn());
const mockFindOrCreateBySessionId = vi.hoisted(() => vi.fn());
const mockAppendMessageFromEnvelope = vi.hoisted(() => vi.fn());
const mockPushToDlq = vi.hoisted(() => vi.fn());
const mockGetAuditSinkEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@ibatexas/nats-client", () => ({
  subscribeNatsEvent: mockSubscribeNatsEvent,
}));

vi.mock("@ibatexas/domain", () => ({
  createConversationService: () => ({
    findOrCreateBySessionId: mockFindOrCreateBySessionId,
    appendMessageFromEnvelope: mockAppendMessageFromEnvelope,
  }),
}));

vi.mock("@ibatexas/llm-provider", () => ({
  getAuditSink: () => ({ emit: mockGetAuditSinkEmit }),
}));

vi.mock("../../subscribers/dlq.js", () => ({
  pushToDlq: mockPushToDlq,
}));

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  };
}

async function getRegisteredCallback() {
  mockSubscribeNatsEvent.mockClear();
  const { startConversationArchiver } = await import(
    "../../subscribers/conversation-archiver.js"
  );
  await startConversationArchiver(makeLogger() as never);
  expect(mockSubscribeNatsEvent).toHaveBeenCalledOnce();
  const [subject, callback] = mockSubscribeNatsEvent.mock.calls[0] as [
    string,
    (payload: unknown) => Promise<void>,
  ];
  expect(subject).toBe("conversation.message.appended");
  return callback;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("conversation-archiver governance (task 16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrCreateBySessionId.mockResolvedValue({ id: "conv_01", isNew: true });
    mockAppendMessageFromEnvelope.mockResolvedValue({
      decision: { kind: "EXECUTE", basis: [] },
      result: { id: "msg_01" },
    });
  });

  it("builds conversation.message.append envelope per message with SYSTEM actor", async () => {
    const callback = await getRegisteredCallback();
    await callback({
      sessionId: "sess_01",
      customerId: "cust_01",
      channel: "whatsapp",
      messages: [
        { role: "user", content: "Olá", sentAt: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "Como posso ajudar?", sentAt: "2026-01-01T00:00:05.000Z" },
      ],
    });

    expect(mockAppendMessageFromEnvelope).toHaveBeenCalledTimes(2);

    const [env1] = mockAppendMessageFromEnvelope.mock.calls[0] as [
      IntentEnvelope,
      unknown,
    ];
    expect(env1.kind).toBe("conversation.message.append");
    expect(env1.actor.principal).toBe("system");
    expect(env1.taint).toBe("SYSTEM");
    expect(env1.nonce).toBe("sess_01:2026-01-01T00:00:00.000Z:0");
    expect(env1.payload).toMatchObject({
      conversationId: "conv_01",
      role: "user",
      content: "Olá",
    });

    const [env2] = mockAppendMessageFromEnvelope.mock.calls[1] as [
      IntentEnvelope,
      unknown,
    ];
    expect(env2.nonce).toBe("sess_01:2026-01-01T00:00:05.000Z:1");
    expect(env2.payload).toMatchObject({ role: "assistant", content: "Como posso ajudar?" });
  });

  it("on REFUSE: pushes message-level DLQ entry, does not abort other messages", async () => {
    // First message REFUSED, second EXECUTES
    mockAppendMessageFromEnvelope
      .mockResolvedValueOnce({
        decision: {
          kind: "REFUSE",
          refusal: {
            code: "taint.system_only",
            userFacing: "Operação restrita ao sistema.",
            class: "TAINT",
          },
          basis: [],
        },
      })
      .mockResolvedValueOnce({
        decision: { kind: "EXECUTE", basis: [] },
        result: { id: "msg_02" },
      });

    const callback = await getRegisteredCallback();
    await callback({
      sessionId: "sess_02",
      customerId: null,
      channel: "web",
      messages: [
        { role: "user", content: "Ola", sentAt: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", content: "Resposta", sentAt: "2026-01-01T00:00:01.000Z" },
      ],
    });

    expect(mockAppendMessageFromEnvelope).toHaveBeenCalledTimes(2);
    expect(mockPushToDlq).toHaveBeenCalledOnce();
    const [dlqEvent, dlqPayload] = mockPushToDlq.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(dlqEvent).toBe("conversation.message.appended");
    expect(dlqPayload.sessionId).toBe("sess_02");
  });
});
