// Unit tests for whatsapp/formatter.ts — pure async generator consumer, no mocks needed.

import { describe, it, expect } from "vitest";
import type { StreamChunk } from "@ibatexas/types";
import { collectAgentResponse } from "../whatsapp/formatter.js";

// ── Helper: create an async generator from an array of chunks ─────────────────

async function* fakeGenerator(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ── collectAgentResponse ──────────────────────────────────────────────────────

describe("collectAgentResponse", () => {
  it("collects text_delta chunks into a single string", async () => {
    const chunks: StreamChunk[] = [
      { type: "text_delta", delta: "Olá, " },
      { type: "text_delta", delta: "bem-vindo " },
      { type: "text_delta", delta: "ao IbateXas!" },
      { type: "done" },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.text).toBe("Olá, bem-vindo ao IbateXas!");
    expect(result.toolsUsed).toEqual([]);
  });

  it("tracks tool_start events in toolsUsed array", async () => {
    const chunks: StreamChunk[] = [
      { type: "tool_start", toolName: "search_products", toolUseId: "tu_1" },
      { type: "text_delta", delta: "Encontrei 3 produtos." },
      { type: "tool_start", toolName: "get_cart", toolUseId: "tu_2" },
      { type: "done" },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.toolsUsed).toEqual(["search_products", "get_cart"]);
    expect(result.text).toBe("Encontrei 3 produtos.");
  });

  it("extracts token counts from done chunk", async () => {
    const chunks: StreamChunk[] = [
      { type: "text_delta", delta: "Resposta." },
      { type: "done", inputTokens: 150, outputTokens: 42 },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.inputTokens).toBe(150);
    expect(result.outputTokens).toBe(42);
  });

  it("leaves token counts undefined when done has no token info", async () => {
    const chunks: StreamChunk[] = [
      { type: "text_delta", delta: "Sem tokens." },
      { type: "done" },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it("returns empty text when generator has no text_delta chunks", async () => {
    const chunks: StreamChunk[] = [
      { type: "tool_start", toolName: "noop", toolUseId: "tu_1" },
      { type: "done" },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.text).toBe("");
    expect(result.toolsUsed).toEqual(["noop"]);
  });

  it("returns empty result from empty generator", async () => {
    const result = await collectAgentResponse(fakeGenerator([]));

    expect(result.text).toBe("");
    expect(result.toolsUsed).toEqual([]);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it("throws on error chunk", async () => {
    const chunks: StreamChunk[] = [
      { type: "text_delta", delta: "Parcial..." },
      { type: "error", message: "Falha no agente" },
    ];

    await expect(collectAgentResponse(fakeGenerator(chunks))).rejects.toThrow(
      "Falha no agente",
    );
  });

  it("handles tool_result chunks without breaking (ignored by formatter)", async () => {
    const chunks: StreamChunk[] = [
      { type: "tool_start", toolName: "search", toolUseId: "tu_1" },
      { type: "tool_result", toolName: "search", toolUseId: "tu_1", success: true },
      { type: "text_delta", delta: "Resultado." },
      { type: "done", inputTokens: 10, outputTokens: 5 },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.text).toBe("Resultado.");
    expect(result.toolsUsed).toEqual(["search"]);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it("concatenates many small deltas correctly", async () => {
    const chars = "Resposta longa com vários caracteres especiais: ção ã é".split("");
    const chunks: StreamChunk[] = [
      ...chars.map((c) => ({ type: "text_delta" as const, delta: c })),
      { type: "done" },
    ];

    const result = await collectAgentResponse(fakeGenerator(chunks));

    expect(result.text).toBe("Resposta longa com vários caracteres especiais: ção ã é");
  });
});
