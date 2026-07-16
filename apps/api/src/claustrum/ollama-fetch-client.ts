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
import { createAuditRedactor } from "@ibatexas/audit-sink";
import { logger } from "../lib/logger.js";

// An OpenAI-compatible error body (esp. from a proxy/gateway in front of the
// local model) can echo a fragment of the REQUEST — system prompt + the
// customer's raw message — so scrub cpf/email/phone/card before it reaches the
// 7-day log store. Lazy singleton: errors are rare, so build on first use.
let _errorBodyRedactor: ReturnType<typeof createAuditRedactor> | undefined;
function scrubErrorBody(body: string): string {
  _errorBodyRedactor ??= createAuditRedactor({
    hashSecret: process.env.AUDIT_REDACT_SECRET ?? "",
  });
  try {
    const scrubbed = _errorBodyRedactor.redactPayload(body);
    return (typeof scrubbed === "string" ? scrubbed : JSON.stringify(scrubbed)).slice(0, 300);
  } catch {
    return "[REDACTED:unavailable]";
  }
}

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

/**
 * FE-T01 (D4) — the FROZEN `OpenAIChatCompletionsBody` (from `@claustrum/openai`)
 * has no `response_format` field. This widens it for the ONE outbound `fetch`
 * call this relay makes; the frozen type itself is never touched.
 */
type OllamaWireBody = OpenAIChatCompletionsBody & {
  readonly response_format?: { readonly type: "json_object" };
};

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
    // CLAUDE.md Hard Rule #3 — config from process.env, never a hardcoded value.
    // Default is the ABSENCE of a key (""), not the literal "ollama": a stock Ollama
    // ignores the bearer, while an authenticated gateway gets a real key from
    // LLM_API_KEY (documented in .env.example) instead of silently 401-ing on a
    // hardcoded credential.
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "";
    this.model = options.model;
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` };
  }

  /**
   * Pin the served model when a model override was configured, and (FE-T01,
   * D4) enrich a tool-bearing body with Ollama's OpenAI-compat JSON mode.
   *
   * `@claustrum/openai`'s `OpenAIChatCompletionsBody` (the FROZEN wire type)
   * has no `response_format` field, so this in-repo relay is the only seam
   * that can add it. Scoped to bodies carrying `tools` (extraction/tool-call
   * requests) — never the responder's tool-less synthesis calls, which must
   * stay free-form pt-BR prose.
   *
   * LIVE-VERIFIED against nemotron-3-nano:4b (192.168.1.80): when the model
   * DOES call a tool, `response_format: json_object` is a no-op — identical
   * `tool_calls` id/name/arguments and `finish_reason` with or without it.
   * When the model does NOT call a tool (the planner's tool-bearing calls
   * legitimately hit this on every no-intent/small-talk turn — see
   * `ibatexas-planner.ts`), `response_format: json_object` does NOT break
   * tool-call emission, but it visibly degrades that branch: the model can no
   * longer emit free-form `content`, and on this model that manifests as a
   * fabricated tool-call-shaped JSON blob in `content` instead of prose (e.g.
   * a plain "Oi, bom dia!" greeting produced `{"capability":"pix.refund",
   * "payload":{"chargeId":"","amountCents":0}}` in `content` with NO
   * `tool_calls` populated). That text never reaches the customer (the
   * responder's synthesis call carries no `tools`, so it is unaffected) and
   * never becomes an envelope (`toolCalls` stays empty either way), but it is
   * real degradation of the planner's internal read-loop re-prompt context.
   * Reported as a residual in the FE-T01 PR — applying this per the ticket
   * (bodies carrying `tools`) is safe for the acceptance-critical path
   * (tool_calls emission + REFUSE-on-malformed/empty), at the cost of that
   * narrower, non-customer-facing quality hit.
   */
  private wireBody(body: OpenAIChatCompletionsBody): OllamaWireBody {
    const modelPinned = this.model === undefined ? body : { ...body, model: this.model };
    const wantsJsonMode = body.tools !== undefined && body.tools.length > 0;
    return wantsJsonMode
      ? { ...modelPinned, response_format: { type: "json_object" } }
      : modelPinned;
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
        if (!res.ok) {
          const errBody = await res.text();
          // SIGNAL-5: the wire boundary was silent — surface local-model HTTP
          // failures (nemotron box offline / 500 / auth) so they are queryable in
          // VictoriaLogs (component:llm event:error) instead of only resurfacing
          // downstream as an unexplained empty/failed turn.
          logger.error(
            {
              component: "llm",
              event: "error",
              httpStatus: res.status,
              model: wire.model,
              body: scrubErrorBody(errBody),
            },
            `llm HTTP ${res.status} from local model endpoint`,
          );
          throw httpError(res.status, errBody);
        }
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
    body: OllamaWireBody,
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
