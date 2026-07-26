// LE2-030 AC1 + AC5 — the send path captures the Twilio SID, and does nothing
// else differently.
//
// Mirrors the mocking posture of `src/__tests__/whatsapp-client.test.ts` (twilio
// + the Redis seam of @ibatexas/tools), and additionally injects a fake pool
// into the delivery store so the capture is observable without a DB.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintRenderedReply } from "@adjudicate/core";
import { sendText, sendMedia } from "../client.js";
import { __setDeliveryStorePoolForTests } from "../delivery-store.js";

const mockMessagesCreate = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisEval = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(async () => ({ set: mockRedisSet, eval: mockRedisEval })),
);

vi.mock("twilio", () => ({
  default: vi.fn(() => ({ messages: { create: mockMessagesCreate } })),
}));

vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return { ...actual, getRedisClient: mockGetRedisClient, rk: (k: string) => `test:${k}` };
});

vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
vi.stubEnv("TWILIO_AUTH_TOKEN", "test_auth_token");
vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+15551234567");
vi.stubEnv("PHONE_HASH_PEPPER", "test-pepper-cccccccccccccccccccccccccccc");

interface Insert {
  sid: string;
  turnId: unknown;
  conversationId: unknown;
  partIndex: unknown;
  phoneHash: unknown;
  source: unknown;
}

let inserts: Insert[];

/** Drive a send to completion under fake timers (the 600ms typing delay + the
 *  200ms inter-part delay). Same idiom as `__tests__/whatsapp-client.test.ts`. */
async function drive(p: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
  return p;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  inserts = [];
  mockRedisSet.mockResolvedValue("OK");
  mockRedisEval.mockResolvedValue([1, 0]);
  __setDeliveryStorePoolForTests({
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      if (sql.includes("INSERT INTO whatsapp_delivery")) {
        inserts.push({
          sid: params[0] as string,
          turnId: params[1],
          conversationId: params[2],
          partIndex: params[3],
          phoneHash: params[4],
          source: params[5],
        });
      }
      return { rowCount: 1, rows: [] };
    },
  });
});

afterEach(() => {
  __setDeliveryStorePoolForTests(null);
  vi.useRealTimers();
});

describe("send path — SID capture (LE2-030 AC1)", () => {
  it("persists the SID of a single-part reply against its turn", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: "SM_single" });

    await drive(
      sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"), {
        turnId: "turn-1",
        conversationId: "conv-1",
      }),
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      sid: "SM_single",
      turnId: "turn-1",
      conversationId: "conv-1",
      partIndex: 0,
      source: "send",
    });
    // Never the raw phone — only the salted hash the send logs already carry.
    expect(String(inserts[0]!.phoneHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists one row per PART, indexed, when the reply is split", async () => {
    mockMessagesCreate
      .mockResolvedValueOnce({ sid: "SM_p0" })
      .mockResolvedValueOnce({ sid: "SM_p1" });

    // > 4096 chars forces splitForWhatsApp into two parts.
    const long = `${"a".repeat(4000)}. ${"b".repeat(2000)}`;
    await drive(
      sendText("whatsapp:+5511999887766", mintRenderedReply(long), { turnId: "turn-2" }),
    );

    expect(inserts.map((i) => [i.sid, i.partIndex])).toEqual([
      ["SM_p0", 0],
      ["SM_p1", 1],
    ]);
  });

  it("records a send with no correlation (job/alert) as a NULL turn_id", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: "SM_job" });
    await drive(sendText("whatsapp:+5511999887766", mintRenderedReply("Alerta")));
    expect(inserts[0]).toMatchObject({ sid: "SM_job", turnId: null, conversationId: null });
  });

  it("tags a media send with its own source", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: "SM_media" });
    await drive(
      sendMedia(
        "whatsapp:+5511999887766",
        "https://cdn.example/qr.png",
        mintRenderedReply("QR Code PIX"),
        { turnId: "turn-3", conversationId: "conv-3" },
      ),
    );
    expect(inserts[0]).toMatchObject({ sid: "SM_media", source: "sendMedia", turnId: "turn-3" });
  });
});

describe("send path — behaviour is otherwise unchanged (LE2-030 AC5)", () => {
  it("passes the SAME create payload as before — no statusCallback, no new field", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: "SM_payload" });
    await drive(
      sendText("whatsapp:+5511999887766", mintRenderedReply("Oi"), { turnId: "turn-4" }),
    );

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const [payload] = mockMessagesCreate.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(payload).sort()).toEqual(["body", "from", "to"]);
  });

  it("does not retry, resend, or throw when the delivery store is down", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: "SM_store_down" });
    __setDeliveryStorePoolForTests({
      async query() {
        throw new Error("connection refused");
      },
    });

    await expect(
      drive(sendText("whatsapp:+5511999887766", mintRenderedReply("Oi"), { turnId: "turn-5" })),
    ).resolves.toBeUndefined();
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("still sends — and records nothing — when Twilio returns no SID", async () => {
    mockMessagesCreate.mockResolvedValue({});
    await drive(
      sendText("whatsapp:+5511999887766", mintRenderedReply("Oi"), { turnId: "turn-6" }),
    );
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(0);
  });

  it("records nothing when the idempotency guard suppresses a duplicate send", async () => {
    mockMessagesCreate.mockResolvedValue({ sid: "SM_dup" });
    mockRedisSet.mockResolvedValue(null); // claim already held → deduped

    await drive(
      sendText("whatsapp:+5511999887766", mintRenderedReply("Oi"), { turnId: "turn-7" }),
    );

    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});
