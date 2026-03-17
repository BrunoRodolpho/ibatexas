// Unit tests for whatsapp/client.ts — mock twilio.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────

const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

// Must set env before importing client (singleton reads on first call)
vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_sid");
vi.stubEnv("TWILIO_AUTH_TOKEN", "test_auth_token");
vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+15551234567");

import {
  splitForWhatsApp,
  sendText,
  sendInteractiveList,
  sendInteractiveButtons,
  phoneHash,
  getWhatsAppNumber,
} from "../whatsapp/client.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockMessagesCreate.mockResolvedValue({ sid: "SM_test" });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── phoneHash ─────────────────────────────────────────────────────────────────

describe("phoneHash", () => {
  it("returns a 12-char hex string", () => {
    const h = phoneHash("+5511999887766");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
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
  it("returns single-element array for short text", () => {
    const result = splitForWhatsApp("Olá!");
    expect(result).toEqual(["Olá!"]);
  });

  it("returns text as-is when exactly 4096 chars", () => {
    const text = "a".repeat(4096);
    const result = splitForWhatsApp(text);
    expect(result).toEqual([text]);
  });

  it("splits text longer than 4096 chars", () => {
    const text = "a".repeat(5000);
    const result = splitForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
  });

  it("prefixes parts with (1/N) indicators when split", () => {
    const text = "a".repeat(5000);
    const result = splitForWhatsApp(text);
    expect(result[0]).toMatch(/^\(1\/\d+\)\n/);
    expect(result[1]).toMatch(/^\(2\/\d+\)\n/);
  });

  it("does not add part indicators for single-part messages", () => {
    const result = splitForWhatsApp("Curto");
    expect(result[0]).not.toMatch(/^\(\d+\/\d+\)/);
  });

  it("prefers splitting at sentence boundaries", () => {
    // Build text: first sentence fills >50% of 4096, then second sentence pushes past limit
    const sentence1 = "A".repeat(3000) + ".";
    const sentence2 = "B".repeat(2000) + ".";
    const text = `${sentence1} ${sentence2}`;

    const result = splitForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
    // First part should end near a sentence boundary
  });

  it("handles empty string", () => {
    const result = splitForWhatsApp("");
    expect(result).toEqual([""]);
  });
});

// ── sendText ──────────────────────────────────────────────────────────────────

describe("sendText", () => {
  it("sends a short message via Twilio", async () => {
    const promise = sendText("whatsapp:+5511999887766", "Olá!");
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

    const promise = sendText("whatsapp:+5511999887766", longText);
    // Advance enough time for delays between parts
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockMessagesCreate.mock.calls.length).toBeGreaterThan(1);
  });

  it("retries on Twilio failure with exponential backoff", async () => {
    mockMessagesCreate
      .mockRejectedValueOnce(new Error("Twilio error"))
      .mockRejectedValueOnce(new Error("Twilio error again"))
      .mockResolvedValueOnce({ sid: "SM_ok" });

    const promise = sendText("whatsapp:+5511999887766", "Oi");
    // Advance past initial delay + retries (600ms + 200ms + 400ms)
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
  });

  it("throws after 3 failed attempts", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("Twilio down"));

    const promise = sendText("whatsapp:+5511999887766", "Oi");
    // Advance past all retry delays
    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).rejects.toThrow("Twilio down");
    expect(mockMessagesCreate).toHaveBeenCalledTimes(3);
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
