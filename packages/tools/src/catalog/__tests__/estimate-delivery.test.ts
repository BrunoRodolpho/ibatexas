// Tests for estimate_delivery tool
//
// Validates:
//   1. Valid CEP returns delivery estimate
//   2. Invalid CEP returns appropriate error
//   3. ViaCEP timeout gracefully degrades (returns fallback response)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { estimateDelivery } from "../estimate-delivery.js";

// ── Mock domain service ──────────────────────────────────────────────────────

const mockFindActiveByPrefix = vi.fn();

vi.mock("@ibatexas/domain", () => ({
  createDeliveryZoneService: () => ({
    findActiveByPrefix: mockFindActiveByPrefix,
  }),
}));

// ── Mock global fetch for ViaCEP ─────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("estimateDelivery", () => {
  it("returns delivery estimate for a valid CEP in a covered zone", async () => {
    // ViaCEP returns valid address
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ cep: "01001-000", logradouro: "Praça da Sé" }), { status: 200 }),
    );
    // Delivery zone match
    mockFindActiveByPrefix.mockResolvedValue({
      name: "Centro SP",
      feeInCentavos: 1200,
      estimatedMinutes: 45,
    });

    const result = await estimateDelivery({ cep: "01001000" });

    expect(result.success).toBe(true);
    expect(result.cep).toBe("01001000");
    expect(result.zoneName).toBe("Centro SP");
    expect(result.feeInCentavos).toBe(1200);
    expect(result.estimatedMinutes).toBe(45);
    expect(result.message).toContain("Centro SP");
    expect(result.message).toContain("R$12,00");
  });

  it("returns error for invalid CEP format (non-numeric)", async () => {
    const result = await estimateDelivery({ cep: "ABCDE" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("CEP inválido");
    // Should not call ViaCEP or zone service
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFindActiveByPrefix).not.toHaveBeenCalled();
  });

  it("returns error for CEP with wrong number of digits", async () => {
    const result = await estimateDelivery({ cep: "12345" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("CEP inválido");
  });

  it("returns error when ViaCEP says CEP does not exist (erro: true)", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ erro: true }), { status: 200 }),
    );

    const result = await estimateDelivery({ cep: "99999999" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("CEP não encontrado");
    // Zone service should NOT be called
    expect(mockFindActiveByPrefix).not.toHaveBeenCalled();
  });

  it("gracefully degrades when ViaCEP times out — proceeds with zone matching", async () => {
    // Simulate timeout / network error
    mockFetch.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    // Zone match succeeds
    mockFindActiveByPrefix.mockResolvedValue({
      name: "Zona Leste",
      feeInCentavos: 1500,
      estimatedMinutes: 60,
    });

    const result = await estimateDelivery({ cep: "08000000" });

    expect(result.success).toBe(true);
    expect(result.zoneName).toBe("Zona Leste");
    expect(result.feeInCentavos).toBe(1500);
  });

  it("returns out-of-area message when CEP is valid but not in any delivery zone", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ cep: "50000-000", logradouro: "Recife" }), { status: 200 }),
    );
    mockFindActiveByPrefix.mockResolvedValue(null);

    const result = await estimateDelivery({ cep: "50000000" });

    expect(result.success).toBe(false);
    expect(result.message).toContain("não entregamos");
    expect(result.message).toContain("50000000");
  });

  it("strips non-numeric characters from CEP before processing", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ cep: "01001-000" }), { status: 200 }),
    );
    mockFindActiveByPrefix.mockResolvedValue({
      name: "Centro",
      feeInCentavos: 1000,
      estimatedMinutes: 30,
    });

    const result = await estimateDelivery({ cep: "01001-000" });

    expect(result.success).toBe(true);
    expect(result.cep).toBe("01001000");
    // fetch should be called with digits-only CEP
    expect(mockFetch).toHaveBeenCalledWith(
      "https://viacep.com.br/ws/01001000/json/",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
