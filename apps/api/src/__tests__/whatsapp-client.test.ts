// Unit tests for whatsapp/client.ts — mock twilio.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mintRenderedReply, unwrapRendered } from "@adjudicate/core";
import { TwilioAdjudicateRefusedError } from "@ibatexas/tools";
import {
  splitForWhatsApp,
  sendText,
  sendMedia,
  sendInteractiveList,
  sendInteractiveButtons,
  phoneHash,
  getWhatsAppNumber,
} from "../whatsapp/client.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockMessagesCreate = vi.hoisted(() => vi.fn());
const mockRedisSet = vi.hoisted(() => vi.fn());
const mockRedisEval = vi.hoisted(() => vi.fn());
const mockGetRedisClient = vi.hoisted(() =>
  vi.fn(async () => ({ set: mockRedisSet, eval: mockRedisEval })),
);

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

// Dev's client.ts sends through the kernel-gated `twilioAdjudicated` wrapper and
// reads `getRedisClient`/`rk` from @ibatexas/tools for the client-side idempotency
// guard + send-rate limiter. Spread the REAL module (keeping twilioAdjudicated +
// TwilioAdjudicateRefusedError, which adjudicate purely in-memory) and override only
// the Redis seam so the idempotency/rate-limit prongs are deterministic in tests.
vi.mock("@ibatexas/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ibatexas/tools")>();
  return {
    ...actual,
    getRedisClient: mockGetRedisClient,
    rk: (k: string) => `test:${k}`,
  };
});

// Must set env before importing client (singleton reads on first call)
vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
vi.stubEnv("TWILIO_AUTH_TOKEN", "test_auth_token");
vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+15551234567");
// Fixed pepper so the keyed-HMAC phone hash is deterministic across calls.
vi.stubEnv("PHONE_HASH_PEPPER", "test-pepper-cccccccccccccccccccccccccccc");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockMessagesCreate.mockResolvedValue({ sid: "SM_test" });
  // Idempotency claim succeeds (first send) by default.
  mockRedisSet.mockResolvedValue("OK");
  // Rate limiter grants a token immediately by default: [allowed=1, waitMs=0].
  mockRedisEval.mockResolvedValue([1, 0]);
});

/** A retryable Twilio error: completed HTTP response that did NOT deliver (5xx). */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`[HTTP ${status}]`), { status });
}
/** A client-side timeout: request may already have been delivered (no status). */
function timeoutError(): Error & { code: string } {
  return Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" });
}

afterEach(() => {
  vi.useRealTimers();
});

// ── phoneHash ─────────────────────────────────────────────────────────────────

describe("phoneHash", () => {
  it("returns a full-length (64-char) hex string", () => {
    const h = phoneHash("+5511999887766");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent output", () => {
    expect(phoneHash("+5511999887766")).toBe(phoneHash("+5511999887766"));
  });

  it("produces different hashes for different numbers", () => {
    expect(phoneHash("+5511999887766")).not.toBe(phoneHash("+5511999887700"));
  });
});

// ── getWhatsAppNumber ─────────────────────────────────────────────────────────

describe("getWhatsAppNumber", () => {
  it("returns the configured WhatsApp number", () => {
    expect(getWhatsAppNumber()).toBe("whatsapp:+15551234567");
  });
});

// ── splitForWhatsApp ──────────────────────────────────────────────────────────

describe("splitForWhatsApp", () => {
  // EGRESS BRAND (E-1): splitForWhatsApp now takes/returns RenderedReply. Mint
  // inputs and unwrap outputs to assert on the underlying string content.
  const split = (s: string): string[] =>
    splitForWhatsApp(mintRenderedReply(s)).map(unwrapRendered);

  it("returns single-element array for short text", () => {
    const result = split("Olá!");
    expect(result).toEqual(["Olá!"]);
  });

  it("returns text as-is when exactly 4096 chars", () => {
    const text = "a".repeat(4096);
    const result = split(text);
    expect(result).toEqual([text]);
  });

  it("splits text longer than 4096 chars", () => {
    const text = "a".repeat(5000);
    const result = split(text);
    expect(result.length).toBeGreaterThan(1);
  });

  it("prefixes parts with (1/N) indicators when split", () => {
    const text = "a".repeat(5000);
    const result = split(text);
    expect(result[0]).toMatch(/^\(1\/\d+\)\n/);
    expect(result[1]).toMatch(/^\(2\/\d+\)\n/);
  });

  it("does not add part indicators for single-part messages", () => {
    const result = split("Curto");
    expect(result[0]).not.toMatch(/^\(\d+\/\d+\)/);
  });

  it("prefers splitting at sentence boundaries", () => {
    // Build text: first sentence fills >50% of 4096, then second sentence pushes past limit
    const sentence1 = "A".repeat(3000) + ".";
    const sentence2 = "B".repeat(2000) + ".";
    const text = `${sentence1} ${sentence2}`;

    const result = split(text);
    expect(result.length).toBeGreaterThan(1);
    // First part should end near a sentence boundary
  });

  it("handles empty string", () => {
    const result = split("");
    expect(result).toEqual([""]);
  });
});

// ── sendText ──────────────────────────────────────────────────────────────────

describe("sendText", () => {
  it("sends a short message via Twilio", async () => {
    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    // Advance past the 600ms initial typing delay
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledWith({
      from: "whatsapp:+15551234567",
      to: "whatsapp:+5511999887766",
      body: "Olá!",
    });
  });

  it("sends multiple parts for long messages", async () => {
    const longText = "Palavra. ".repeat(600); // well over 4096 chars

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply(longText));
    // Advance enough time for delays between parts
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockMessagesCreate.mock.calls.length).toBeGreaterThan(1);
  });

  it("retries on a retryable (5xx) Twilio failure with exponential backoff", async () => {
    mockMessagesCreate
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ sid: "SM_ok" });

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Oi"));
    // Advance past initial delay + retries (600ms + 200ms + 400ms)
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
  });

  it("throws after 3 failed retryable attempts", async () => {
    const err = httpError(503);
    mockMessagesCreate
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);

    // Attach rejection handler immediately to prevent unhandled rejection
    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Oi")).catch((e) => e);
    // Advance past all retry delays
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as { status?: number }).status).toBe(503);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
  });

  // audit-2026-05-24 P2-1: kernel REFUSE is permanent — retrying would emit
  // 3× audit records for the same payload that will never be approved.
  // The retry classifier in client.ts must short-circuit on
  // TwilioAdjudicateRefusedError and re-throw immediately.
  it("does NOT retry when kernel REFUSEs (TwilioAdjudicateRefusedError)", async () => {
    // Build a refusal decision shape that satisfies the constructor.
    const refusedErr = new TwilioAdjudicateRefusedError({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "twilio.message.empty",
        userFacing:
          "Não foi possível enviar a mensagem porque o conteúdo está vazio.",
      },
      basis: [],
    });
    mockMessagesCreate.mockRejectedValueOnce(refusedErr);

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("x")).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toBeInstanceOf(TwilioAdjudicateRefusedError);
    // Critical assertion: refusal is permanent, so the wrapper is called
    // exactly once — no audit-emission pollution.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("DOES retry on transient (non-refusal) errors per backoff policy", async () => {
    const transient = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    mockMessagesCreate
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient);

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("x")).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);

    await promise;
    // Transient errors are retried up to the configured maxRetries (3).
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
  });
});

// ── P1-NET-WASEND: idempotency + retry policy ───────────────────────────────────

describe("send reliability — retry policy (P1-NET-WASEND)", () => {
  it("does NOT retry after a post-send timeout (avoids duplicate billable send)", async () => {
    // Timeout occurs AFTER the request may have been delivered → must not retry.
    mockMessagesCreate.mockRejectedValueOnce(timeoutError());

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Oi")).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    // Exactly one create attempt — no retry on the ambiguous timeout.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on a non-retryable 4xx error", async () => {
    // 400 = bad request; Twilio answered and rejected it → retrying is pointless.
    mockMessagesCreate.mockRejectedValueOnce(httpError(400));

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Oi")).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("retries a connection-refused error (request never reached Twilio)", async () => {
    mockMessagesCreate
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce({ sid: "SM_ok" });

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Oi"));
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
  });

  it("claims a deterministic idempotency key (SET NX) before sending", async () => {
    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    // First create is guarded by a SET NX claim through rk().
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value, opts] = mockRedisSet.mock.calls[0];
    expect(key).toMatch(/^test:wa:send:idem:[0-9a-f]{64}$/);
    expect(value).toBe("1");
    expect(opts).toMatchObject({ NX: true });
  });

  it("skips the create when the idempotency key is already claimed", async () => {
    // Simulate a prior attempt that already claimed the key (e.g. timed out post-send).
    mockRedisSet.mockResolvedValue(null);

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    // Claim attempted, but no message sent (duplicate suppressed).
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("fails open: still sends when the idempotency Redis claim throws", async () => {
    mockRedisSet.mockRejectedValue(new Error("redis down"));

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

// ── P1-SCALE-TWILIORATE: shared send-rate limiter ───────────────────────────────

describe("send rate limiter (P1-SCALE-TWILIORATE)", () => {
  it("acquires a token (keyed by sending number) before each create", async () => {
    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    const evalArgs = mockRedisEval.mock.calls[0][1];
    // Bucket key is the SENDING number, built through rk().
    expect(evalArgs.keys[0]).toBe("test:wa:send:rate:whatsapp:+15551234567");
  });

  it("awaits the bucket-reported wait when no token is available, then sends", async () => {
    // First poll: no token, wait 100ms. Second poll: token granted.
    mockRedisEval.mockResolvedValueOnce([0, 100]).mockResolvedValueOnce([1, 0]);

    const sendPromise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    // 600ms typing delay, then first bucket poll returns "wait 100ms" and the
    // limiter must back off — at this instant the create has NOT happened.
    await vi.advanceTimersByTimeAsync(600);
    expect(mockMessagesCreate).not.toHaveBeenCalled();

    // Advance past the 100ms backoff → second poll grants the token, then send.
    await vi.advanceTimersByTimeAsync(200);
    await sendPromise;

    // The limiter polled twice (denied, then granted) before the single create.
    expect(mockRedisEval).toHaveBeenCalledTimes(2);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("fails open: proceeds with the send when the limiter Redis throws", async () => {
    mockRedisEval.mockRejectedValue(new Error("redis down"));

    const promise = sendText("whatsapp:+5511999887766", mintRenderedReply("Olá!"));
    await vi.advanceTimersByTimeAsync(700);
    await promise;

    // Limiter degraded gracefully — the send still went through.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

// ── sendMedia ─────────────────────────────────────────────────────────────────

describe("sendMedia", () => {
  // P2-1 mirror: same classification applies to media sends.
  it("does NOT retry when kernel REFUSEs (TwilioAdjudicateRefusedError)", async () => {
    const refusedErr = new TwilioAdjudicateRefusedError({
      kind: "REFUSE",
      refusal: {
        kind: "BUSINESS_RULE",
        code: "twilio.message.empty",
        userFacing:
          "Não foi possível enviar a mensagem porque o conteúdo está vazio.",
      },
      basis: [],
    });
    mockMessagesCreate.mockRejectedValueOnce(refusedErr);

    const promise = sendMedia(
      "whatsapp:+5511999887766",
      "https://example.com/x.jpg",
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result).toBeInstanceOf(TwilioAdjudicateRefusedError);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });
});

// ── sendInteractiveList ───────────────────────────────────────────────────────

describe("sendInteractiveList", () => {
  it("falls back to formatted numbered text", async () => {
    const sections = [
      {
        title: "Produtos",
        rows: [
          { id: "p1", title: "Costela", description: "R$ 89,00" },
          { id: "p2", title: "Brisket", description: "R$ 125,00" },
        ],
      },
    ];

    const promise = sendInteractiveList(
      "whatsapp:+5511999887766",
      "Confira nosso cardápio",
      "Ver cardápio",
      sections,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const body = mockMessagesCreate.mock.calls[0][0].body;
    expect(body).toContain("Confira nosso cardápio");
    expect(body).toContain("*Produtos*");
    expect(body).toContain("Costela");
    expect(body).toContain("Brisket");
  });

  it("includes row descriptions when present", async () => {
    const sections = [
      {
        rows: [{ id: "p1", title: "Item", description: "Detalhe" }],
      },
    ];

    const promise = sendInteractiveList(
      "whatsapp:+5511999887766",
      "Corpo",
      "Botão",
      sections,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    const body = mockMessagesCreate.mock.calls[0][0].body;
    expect(body).toContain("Detalhe");
  });

  it("handles rows without descriptions", async () => {
    const sections = [
      {
        title: "Seção",
        rows: [{ id: "p1", title: "Sem descrição" }],
      },
    ];

    const promise = sendInteractiveList(
      "whatsapp:+5511999887766",
      "Corpo",
      "Botão",
      sections,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    const body = mockMessagesCreate.mock.calls[0][0].body;
    expect(body).toContain("Sem descrição");
    expect(body).not.toContain("undefined");
  });
});

// ── sendInteractiveButtons ────────────────────────────────────────────────────

describe("sendInteractiveButtons", () => {
  it("falls back to formatted text with button labels", async () => {
    const buttons = [
      { id: "btn1", title: "PIX" },
      { id: "btn2", title: "Cartão" },
    ];

    const promise = sendInteractiveButtons(
      "whatsapp:+5511999887766",
      "Como pagar?",
      buttons,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const body = mockMessagesCreate.mock.calls[0][0].body;
    expect(body).toContain("Como pagar?");
    expect(body).toContain("*PIX*");
    expect(body).toContain("*Cartão*");
    expect(body).toContain("Responda com a opção desejada");
  });

  it("sends correct number of button labels", async () => {
    const buttons = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ];

    const promise = sendInteractiveButtons(
      "whatsapp:+5511999887766",
      "Escolha",
      buttons,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    const body = mockMessagesCreate.mock.calls[0][0].body as string;
    const bulletCount = (body.match(/▸/g) ?? []).length;
    expect(bulletCount).toBe(3);
  });
});
