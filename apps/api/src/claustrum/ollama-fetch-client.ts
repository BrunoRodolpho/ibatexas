/**
 * OllamaFetchClient — a structural `OpenAIClientLike` (no `openai` SDK) for a
 * local Ollama OpenAI-compatible `/v1` endpoint (e.g. nemotron-3-nano:4b).
 *
 * Pure transport: `@claustrum/openai`'s `OpenAIProvider` owns the FROZEN
 * `ModelProvider` contract — body assembly, stop-reason normalization, non-stream
 * parsing, and the per-index tool_call reassembly. This client only POSTs the
 * pre-built OpenAI wire body and yields parsed SSE chunks. HTTP failures throw a
 * `{ status }`-shaped error that `OpenAIProvider` runs through `translateOpenAIError`.
 *
 * Selected in claustrum-bootstrap.ts when LLM_PROVIDER=ollama (replaces the
 * hand-rolled NemotronModelProvider, which duplicated the OpenAI wire contract).
 */

import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionsBody,
  OpenAIClientLike,
  OpenAIEmbeddingResponse,
} from "@claustrum/openai";
import { CompletionError } from "@claustrum/core";

export interface OllamaFetchClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** When set, pins the served model, overriding req.model in the wire body.
   *  The bootstrap leaves this unset (it stamps the correct chatModelId on the
   *  request); the live-check sets it so the contract harness hits the local
   *  model regardless of the model id the harness puts on the request. */
  model?: string;
}

interface HttpError extends Error {
  status: number;
}

function httpError(status: number, body: string): HttpError {
  const err = new Error(`Ollama ${status}: ${body}`.slice(0, 500)) as HttpError;
  err.status = status;
  return err;
}

export class OllamaFetchClient implements OpenAIClientLike {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string | undefined;

  constructor(options: OllamaFetchClientOptions = {}) {
    // Default to a localhost Ollama; LLM_BASE_URL overrides. No hardcoded LAN IP
    // (CLAUDE.md Hard Rule #3 — config from process.env).
    this.baseUrl = options.baseUrl ?? process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "ollama";
    this.model = options.model;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  /** Pin the served model when a model override was configured. */
  private wireBody(body: OpenAIChatCompletionsBody): OpenAIChatCompletionsBody {
    return this.model !== undefined ? { ...body, model: this.model } : body;
  }

  readonly chat = {
    completions: {
      create: (async (
        body: OpenAIChatCompletionsBody & { readonly stream?: boolean },
        options?: { signal?: AbortSignal },
      ): Promise<OpenAIChatCompletionResponse | AsyncIterable<OpenAIChatCompletionChunk>> => {
        const url = `${this.baseUrl}/chat/completions`;
        const wire = this.wireBody(body);
        if (body.stream === true) {
          return this.streamChat(url, wire, options?.signal);
        }
        const res = await fetch(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(wire),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (!res.ok) throw httpError(res.status, await res.text());
        return (await res.json()) as OpenAIChatCompletionResponse;
      }) as OpenAIClientLike["chat"]["completions"]["create"],
    },
  };

  readonly embeddings = {
    create: async (): Promise<OpenAIEmbeddingResponse> => {
      // Local Ollama chat models are not embedders. Surface not_implemented so
      // OpenAIProvider.embed re-throws it and the bootstrap capability probe /
      // failSafeGrounding degrades to a designed no-op (DEF-005).
      throw new CompletionError(
        "not_implemented",
        "Ollama chat model has no embedding capability; grounding uses fail-safe (empty) retrieval",
      );
    },
  };

  private async streamChat(
    url: string,
    body: OpenAIChatCompletionsBody,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<OpenAIChatCompletionChunk>> {
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw httpError(res.status, await res.text());
    const reader = res.body as unknown as AsyncIterable<Uint8Array> | null;
    return (async function* parse(): AsyncGenerator<OpenAIChatCompletionChunk> {
      if (reader === null) return;
      const decoder = new TextDecoder();
      let buf = "";
      for await (const part of reader) {
        buf += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as OpenAIChatCompletionChunk;
          } catch {
            // ignore malformed keep-alive / partial SSE lines
          }
        }
      }
    })();
  }
}
