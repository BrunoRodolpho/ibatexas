/**
 * Wire Truth — the composed seam-1 test: "one model call in → one llm_wire
 * row out", through the REAL pieces at every hop (FE-T05b lesson: no
 * hand-mirrored doubles). The chain under test:
 *
 *   beginWireTurn → OllamaFetchClient.create (fetch stubbed at the HTTP
 *   boundary) → captureWireExchange (ALS) → emitModelCallTrace (stub
 *   TelemetryPort) → sealWireCall → flushWireExchanges → createLlmWireWriter
 *   (SQL-dispatch pool mock) → the INSERT params.
 *
 * Pinned here: wire fidelity (the stored request byte-equals the body the
 * relay POSTed, enrichment included), redaction asymmetry (user content
 * scrubbed, persona + tools verbatim, response reasoning scrubbed but
 * PRESENT), per-call attribution across retries, and failure isolation.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { OllamaFetchClient } from "../ollama-fetch-client.js";
import { emitModelCallTrace } from "../llm-trace.js";
import { beginWireTurn } from "../wire-capture.js";
import { createLlmWireWriter, flushWireExchanges } from "../llm-wire-writer.js";

interface Insert {
  sql: string;
  params: unknown[];
}

function poolMock(): { inserts: Insert[]; pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> } } {
  const inserts: Insert[] = [];
  return {
    inserts,
    pool: {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO llm_wire")) inserts.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    },
  };
}

function mockFetchOk(responseBody: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  }));
}

const telemetryStub = {
  emitLLMTrace: async () => {},
  emitTurn: async () => {},
  emitMemoryAccess: async () => {},
};

const RAW_RESPONSE = {
  id: "chatcmpl-1",
  model: "nemotron-3-nano:4b",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "",
        reasoning: "O operador disse oi. Telefone dele: (11) 99999-8888. Vou responder.",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 58, completion_tokens: 9 },
};

async function traceEmit(turnId: string): Promise<void> {
  await emitModelCallTrace({
    telemetry: telemetryStub,
    registry: undefined,
    turnId,
    model: "nemotron-3-nano:4b",
    fragmentManifest: ["ops/responder.persona"],
    completionText: "",
    inputTokens: 58,
    outputTokens: 9,
    durationMs: 100,
    at: "2026-07-21T03:00:00.000Z",
    temperature: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Wire Truth — composed capture pipeline", () => {
  it("persists one row per exchange: wire-faithful request, raw response, redacted, attributed", async () => {
    const fetchMock = mockFetchOk(RAW_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await beginWireTurn(async () => {
      await client.chat.completions.create({
        model: "nemotron-3-nano:4b",
        messages: [
          { role: "system", content: "Você é um atendente. Peça o telefone (11) 90000-0000 se precisar." },
          { role: "user", content: "oi, meu email é bruno@example.com" },
        ],
        temperature: 0,
        max_tokens: 1024,
      });
      await traceEmit("turn-pipe");
    });

    const { inserts, pool } = poolMock();
    await flushWireExchanges(createLlmWireWriter(pool), "turn-pipe", "conv-pipe");

    expect(inserts).toHaveLength(1);
    const p = inserts[0]!.params;
    // Columns: turn_id, seq, call_index, conversation_id, model, request, response,
    //          hash, req_trunc, resp_trunc, recorded_at
    expect(p[0]).toBe("turn-pipe");
    expect(p[1]).toBe(0);
    expect(p[2]).toBe(0);
    expect(p[3]).toBe("conv-pipe");
    expect(p[4]).toBe("nemotron-3-nano:4b");

    const storedRequest = JSON.parse(p[5] as string);
    const postedBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    // Wire fidelity: identical to the POSTed body — including the relay's
    // tool-less enrichment — except where redaction rewrote user content.
    expect(storedRequest.reasoning_effort).toBe("none");
    expect(postedBody.reasoning_effort).toBe("none");
    expect(storedRequest.model).toBe(postedBody.model);
    expect(storedRequest.temperature).toBe(postedBody.temperature);
    expect(storedRequest.max_tokens).toBe(postedBody.max_tokens);
    // Redaction covers EVERY message content — system included (the ops
    // system embeds raw staff history; review finding). The persona prose
    // survives, its embedded phone does not.
    expect(storedRequest.messages[0].content).toContain("Você é um atendente.");
    expect(storedRequest.messages[0].content).toContain("[REDACTED:PHONE]");
    expect(storedRequest.messages[0].content).not.toContain("90000-0000");
    // …user content scrubbed.
    expect(storedRequest.messages[1].content).toContain("[REDACTED:EMAIL]");
    expect(storedRequest.messages[1].content).not.toContain("bruno@example.com");

    const storedResponse = JSON.parse(p[6] as string);
    // The raw reasoning channel SURVIVES (the whole point) — scrubbed.
    expect(storedResponse.choices[0].message.reasoning).toContain("[REDACTED:PHONE]");
    expect(storedResponse.choices[0].message.reasoning).toContain("Vou responder.");
    expect(storedResponse.choices[0].finish_reason).toBe("stop");

    expect(p[7]).toMatch(/^[0-9a-f]{64}$/);
    expect(p[8]).toBe(false);
    expect(p[9]).toBe(false);
  });

  it("attributes retry attempts to one call and later calls to the next", async () => {
    const fetchMock = mockFetchOk(RAW_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });
    const body = {
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user" as const, content: "oi" }],
      temperature: 0,
    };

    await beginWireTurn(async () => {
      // call 0 — one attempt.
      await client.chat.completions.create(body);
      await traceEmit("turn-retry");
      // call 1 — the regenerate-on-empty loop: three attempts, one emit.
      await client.chat.completions.create(body);
      await client.chat.completions.create(body);
      await client.chat.completions.create(body);
      await traceEmit("turn-retry");
    });

    const { inserts, pool } = poolMock();
    await flushWireExchanges(createLlmWireWriter(pool), "turn-retry", "conv-r");
    expect(inserts.map((i) => [i.params[1], i.params[2]])).toEqual([
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ]);
  });

  it("swallows store failures — capture never breaks a turn", async () => {
    const fetchMock = mockFetchOk(RAW_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });
    await beginWireTurn(async () => {
      await client.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "oi" }],
        temperature: 0,
      });
      await traceEmit("turn-fail");
    });
    const failingPool = {
      query: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      flushWireExchanges(createLlmWireWriter(failingPool), "turn-fail", "conv-f"),
    ).resolves.toBeUndefined();
  });

  it("captures nothing outside a wire-turn context (live-check stays silent)", async () => {
    const fetchMock = mockFetchOk(RAW_RESPONSE);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });
    await client.chat.completions.create({
      model: "m",
      messages: [{ role: "user", content: "oi" }],
      temperature: 0,
    });
    await traceEmit("turn-ctxless");
    const { inserts, pool } = poolMock();
    await flushWireExchanges(createLlmWireWriter(pool), "turn-ctxless", "conv-x");
    expect(inserts).toHaveLength(0);
  });
});
