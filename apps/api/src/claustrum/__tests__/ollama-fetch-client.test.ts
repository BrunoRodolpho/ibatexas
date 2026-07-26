/**
 * FE-T01 — wire-body assertions for OllamaFetchClient.
 *
 * Covers acceptance criterion 1 ("the outbound /v1 request body carries an
 * explicit temperature and a response_format/JSON-mode field, asserted by an
 * integration test on the wire payload") by stubbing `fetch` and inspecting
 * the EXACT JSON body this relay POSTs to Ollama's OpenAI-compat endpoint —
 * the same seam `@claustrum/openai`'s `OpenAIProvider` calls via
 * `chat.completions.create()`.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { OllamaFetchClient } from "../ollama-fetch-client.js";

function mockFetchOk(responseBody: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  }));
}

const FAKE_COMPLETION = {
  id: "chatcmpl-1",
  model: "nemotron-3-nano:4b",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "", tool_calls: [] },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

const EXPRESS_INTENT_TOOL = {
  type: "function" as const,
  function: {
    name: "express_intent",
    description: "Express an intent.",
    parameters: { type: "object", properties: {} },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaFetchClient — wire body (FE-T01)", () => {
  it("forwards an explicit temperature on the outbound body when the caller sets one", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "oi" }],
      temperature: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://box:11434/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.temperature).toBe(0);
  });

  it("enriches a tool-bearing body with response_format: json_object", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "refund cha-1" }],
      tools: [EXPRESS_INTENT_TOOL],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.tools).toEqual([EXPRESS_INTENT_TOOL]);
  });

  it("does NOT add response_format when no tools are present (the responder's synthesis calls)", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "oi" }],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("does NOT add response_format for an empty tools array", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "oi" }],
      tools: [],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("disables thinking on a tool-less body via reasoning_effort: none (the responder's synthesis calls)", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "oi boa noite" }],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reasoning_effort).toBe("none");
  });

  it("treats an empty tools array as tool-less: reasoning_effort none, no response_format", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "oi" }],
      tools: [],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reasoning_effort).toBe("none");
    expect(body.response_format).toBeUndefined();
  });

  it("does NOT add reasoning_effort to a tool-bearing body (the planner keeps thinking)", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    await client.chat.completions.create({
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user", content: "refund cha-1" }],
      tools: [EXPRESS_INTENT_TOOL],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("still pins the served model override alongside the new fields (pre-existing behavior preserved)", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({
      baseUrl: "http://box:11434/v1",
      model: "nemotron-3-nano:4b",
    });

    await client.chat.completions.create({
      model: "some-other-model-id",
      messages: [{ role: "user", content: "oi" }],
      tools: [EXPRESS_INTENT_TOOL],
      temperature: 0,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("nemotron-3-nano:4b");
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
