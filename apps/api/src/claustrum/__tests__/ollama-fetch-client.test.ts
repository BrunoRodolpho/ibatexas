/**
 * FE-T01 / LE2-006 — wire-body assertions for OllamaFetchClient.
 *
 * Stubs `fetch` and inspects the EXACT JSON body this relay POSTs to Ollama's
 * OpenAI-compat endpoint — the same seam `@claustrum/openai`'s `OpenAIProvider`
 * calls via `chat.completions.create()`.
 *
 * FE-T01 pinned an explicit temperature on the outbound body, plus a JSON-mode
 * `response_format` on tool-bearing bodies. LE2-006 (wire constraint V1) removed
 * the latter on measured evidence, so `response_format` is now pinned ABSENT on
 * BOTH branches: the assertions below are the standing guard that nothing
 * re-adds it. Rationale + experiment pointers live on `wireBody`'s doc comment
 * in ../ollama-fetch-client.ts.
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

  it("sends a tool-bearing body UNCONSTRAINED — no response_format (LE2-006 V1)", async () => {
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
    expect(body.response_format).toBeUndefined();
    expect(body.tools).toEqual([EXPRESS_INTENT_TOOL]);
  });

  it("adds NO wire constraint of any spelling to a tool-bearing body (LE2-006 V1)", async () => {
    const fetchMock = mockFetchOk(FAKE_COMPLETION);
    vi.stubGlobal("fetch", fetchMock);
    const client = new OllamaFetchClient({ baseUrl: "http://box:11434/v1" });

    const caller = {
      model: "nemotron-3-nano:4b",
      messages: [{ role: "user" as const, content: "refund cha-1" }],
      tools: [EXPRESS_INTENT_TOOL],
      temperature: 0,
    };
    await client.chat.completions.create(caller);

    // The relay must forward the caller's body verbatim on this branch. Pinned
    // as an exact key set rather than field-by-field absence: on this engine an
    // unsupported constraint is accepted with a 200 and silently ignored, so a
    // future `tool_choice`/`grammar`/`format` experiment left in by accident
    // would never surface as an error — only as an unexplained behaviour shift.
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(Object.keys(caller).sort());
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
    expect(body.response_format).toBeUndefined();
  });

  it("still pins the served model override on a tool-bearing body (pre-existing behavior preserved)", async () => {
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
    expect(body.response_format).toBeUndefined();
  });
});
