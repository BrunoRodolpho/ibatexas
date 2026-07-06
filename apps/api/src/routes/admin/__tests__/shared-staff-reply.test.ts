// Unit coverage for the ONE shared staff take-over reply flow both admin routes
// (incidents `/reply` + escalations `/reply`) now call. Locks the common core:
//   - the reply is recorded in the transcript tagged via:staff_takeover, with the
//     caller's extra metadata (incidents adds incidentId) + staffId merged in;
//   - a guest / not-yet-archived session (conversation === null) skips the append
//     but STILL delivers;
//   - only a WhatsApp channel with a resolved recipient AND a live sender counts
//     as delivered;
//   - a delivered reply closes the incident as STAFF (staff:<id>, or admin-key
//     when unauthenticated), NEVER AUTO/system — the P1-3 metric-honesty rule;
//   - delivery is fail-open: a thrown send is caught, logged, and does NOT close.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The route mints via mintBroadcastReply; assert against the structurally-equal
// mintRenderedReply (same opaque brand) as the existing incidents suite does.
import { mintRenderedReply } from "@adjudicate/core";
// SUT. vitest hoists the vi.mock/vi.hoisted calls below above these imports, so
// the mocked @ibatexas/tools + incident-auto-close are in place when it loads.
import { staffTakeoverReply, type StaffTakeoverReplyInput } from "../_shared-staff-reply.js";

const mockSendText = vi.hoisted(() => vi.fn());
const mockGetSender = vi.hoisted(() => vi.fn());
const mockCloseStaff = vi.hoisted(() => vi.fn());

vi.mock("@ibatexas/tools", () => ({
  getWhatsAppSender: mockGetSender,
}));

vi.mock("../../../incidents/incident-auto-close.js", () => ({
  closeIncidentOnStaffReply: mockCloseStaff,
}));

const appendMessage = vi.fn();
const logError = vi.fn();
const log: StaffTakeoverReplyInput["log"] = {
  info: vi.fn(),
  warn: vi.fn(),
  error: logError,
};
const service: StaffTakeoverReplyInput["service"] = { appendMessage };

/** A fully-delivered WhatsApp base input; each test overrides what it needs. */
function baseInput(): StaffTakeoverReplyInput {
  return {
    service,
    sessionId: "sess_1",
    text: "oi",
    channel: "whatsapp",
    to: "whatsapp:+5511988887777",
    staffId: "staff_mgr_01",
    conversation: { id: "conv_1" },
    logLabel: "incidents",
    log,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendMessage.mockResolvedValue({ id: "m1" });
  mockGetSender.mockReturnValue({ sendText: mockSendText });
  mockSendText.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("staffTakeoverReply — delivered path", () => {
  it("records the reply, delivers the minted text, and closes as STAFF", async () => {
    const delivered = await staffTakeoverReply({
      ...baseInput(),
      metadata: { incidentId: "inc_1" },
    });

    expect(delivered).toBe(true);

    // Transcript record: assistant-side, tagged via:staff_takeover + the caller's
    // metadata (incidentId) + staffId.
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0][0]).toMatchObject({
      conversationId: "conv_1",
      role: "assistant",
      content: "oi",
      metadata: { via: "staff_takeover", incidentId: "inc_1", staffId: "staff_mgr_01" },
    });

    // Delivered as the branded reply.
    expect(mockSendText).toHaveBeenCalledWith(
      "whatsapp:+5511988887777",
      mintRenderedReply("oi"),
    );

    // Closed as STAFF (staff identity), NOT AUTO/system, with the same LogFn.
    expect(mockCloseStaff).toHaveBeenCalledTimes(1);
    expect(mockCloseStaff.mock.calls[0][0]).toBe("sess_1");
    expect(mockCloseStaff.mock.calls[0][1]).toBe("staff:staff_mgr_01");
    expect(mockCloseStaff.mock.calls[0][3]).toBe(log);
  });

  it("skips the transcript append for a guest (conversation === null) but still delivers + closes", async () => {
    const delivered = await staffTakeoverReply({
      ...baseInput(),
      conversation: null,
      staffId: null, // unauthenticated → admin-key
      logLabel: "escalations",
    });

    expect(delivered).toBe(true);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(mockSendText).toHaveBeenCalledWith(
      "whatsapp:+5511988887777",
      mintRenderedReply("oi"),
    );
    // staffId null → resolvedBy "admin-key".
    expect(mockCloseStaff.mock.calls[0][1]).toBe("admin-key");
  });
});

describe("staffTakeoverReply — not-delivered paths", () => {
  it("records but does not deliver/close on a non-WhatsApp channel", async () => {
    const delivered = await staffTakeoverReply({
      ...baseInput(),
      channel: "web",
      to: null,
    });

    expect(delivered).toBe(false);
    expect(appendMessage).toHaveBeenCalledTimes(1); // recorded regardless
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockCloseStaff).not.toHaveBeenCalled();
  });

  it("does not deliver/close when no sender is configured", async () => {
    mockGetSender.mockReturnValue(null);

    const delivered = await staffTakeoverReply(baseInput());

    expect(delivered).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockCloseStaff).not.toHaveBeenCalled();
  });

  it("is fail-open: a thrown send is caught + logged and never closes the incident", async () => {
    mockSendText.mockRejectedValue(new Error("twilio down"));

    const delivered = await staffTakeoverReply(baseInput());

    expect(delivered).toBe(false);
    expect(appendMessage).toHaveBeenCalledTimes(1); // recorded before the send throw
    expect(logError).toHaveBeenCalledTimes(1);
    expect(mockCloseStaff).not.toHaveBeenCalled();
  });
});
