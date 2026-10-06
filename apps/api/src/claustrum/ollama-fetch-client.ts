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
import { captureWireExchange } from "./wire-capture.js";

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
 * has no `reasoning_effort` field. This widens it for the ONE outbound `fetch`
 * call this relay makes; the frozen type itself is never touched.
 *
 * LE2-006 narrowed this: it also carried `response_format?: {type:"json_object"}`
 * until wire-constraint V1 removed the only site that set it. The field is gone
 * from the type on purpose — the type states what this relay can send.
 */
export type OllamaWireBody = OpenAIChatCompletionsBody & {
  readonly reasoning_effort?: "none";
};

/**
 * The relay's outbound-body transform as a pure function (Wire Truth spec):
 * exported so wire capture can store a request byte-identical to what this
 * relay POSTs. Tool-bearing bodies (the planner's extraction calls) are sent
 * UNCONSTRAINED — see `wireBody` for the LE2-006 evidence; tool-less bodies
 * (responder synthesis) gain `reasoning_effort: "none"`; `model` pins the
 * served model when an override is configured. Any change to what this relay
 * sends MUST go through this function — it is the single source of truth for
 * the wire shape.
 */
export function toOllamaWireBody(
  body: OpenAIChatCompletionsBody,
  model?: string | undefined,
): OllamaWireBody {
  const modelPinned = model === undefined ? body : { ...body, model };
  const toolBearing = body.tools !== undefined && body.tools.length > 0;
  return toolBearing ? modelPinned : { ...modelPinned, reasoning_effort: "none" };
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
   * Pin the served model when a model override was configured, and disable
   * thinking on tool-less bodies. Tool-bearing bodies are sent UNCONSTRAINED.
   *
   * WIRE CONSTRAINT V1 (LE2-006, adopted 2026-07-26) — this relay no longer
   * adds `response_format: { type: "json_object" }` to tool-bearing bodies.
   * FE-T01 (D4) added it to push the planner's extraction calls toward JSON;
   * two measured experiments on the pinned engine showed it bought nothing on
   * the path that matters and cost real damage on the path beside it:
   *
   *   - LE2-001 emission baseline (338 drives, 4 passes,
   *     `scratch/language-engine-2/results/01-emission-baseline-2026-07-25.md`):
   *     under json_object the model cannot emit free-form `content`, so on a
   *     no-action turn it emits a capability-shaped JSON blob instead of prose
   *     — 12.2% of no-action turns, ALL of them fabricated (a plain "Oi"
   *     greeting produced a stranded `order.note.add`; a delivery-coverage
   *     question produced a stranded `order.cart.ensure`).
   *   - LE2-004 wire-constraint probe (434 exchanges,
   *     `…/results/04-wire-constraint-probe-2026-07-25.md`): removing it drives
   *     stranded capability-JSON and prose-smuggled JSON both 6.5% → 0.0%,
   *     while action-turn `tool_calls` payloads stay BYTE-IDENTICAL. That last
   *     part is structural, not luck: `response_format` governs the content
   *     channel, which the model only uses when it emits no tool call.
   *
   * So the constraint was inert whenever the planner did its job and harmful
   * whenever it correctly declined to. The debris was never customer-visible
   * (`…/results/06-gate1-leak-path-audit-2026-07-25.md` proves planner text has
   * no carrier to a reply — `Plan` has no text field, `TurnOutcome` has no
   * planner field, and the customer sentence is a different model call), but it
   * did poison the planner's own pass-2 re-prompt, which replays pass-1's text
   * in the assistant slot. Under V1 that slot receives ordinary prose.
   *
   * The after-measure is in `…/results/06-adoption-after-measure-2026-07-26.md`.
   * NOTE for anyone reaching for a different constraint here: on this engine
   * `tool_choice` is silently INERT in every spelling (even a nonsense value
   * returns 200), and unsupported constraints never error — so a wire
   * constraint can only be validated by BEHAVIOUR, never by status code.
   *
   * Tool-LESS bodies (the responder's pt-BR synthesis calls) get
   * `reasoning_effort: "none"`. nemotron-3-nano:4b thinks by default and
   * Ollama's `/v1` splits that pass into `message.reasoning`, which the FROZEN
   * `@claustrum/openai` provider never reads — so on short prompts the answer
   * either starves inside the thinking budget (`finish_reason: length`, empty
   * `content`) or lands wholesale in `reasoning` (`finish_reason: stop`, empty
   * `content`). Either way the responder sees an empty completion, and with
   * temperature pinned to 0 (FE-T01) every regenerate-on-empty retry replays
   * the identical result, exhausting to the customer-facing holding fallback.
   * NOTE: Ollama's native `think: false` toggle is silently IGNORED on the
   * `/v1` OpenAI-compat path — `reasoning_effort: "none"` is the honored
   * spelling there (live-verified: the greeting reply arrives in ~12 tokens
   * with an empty reasoning field). Scoped to tool-less bodies: the planner's
   * tool-bearing wire keeps thinking enabled, unchanged.
   */
  private wireBody(body: OpenAIChatCompletionsBody): OllamaWireBody {
    return toOllamaWireBody(body, this.model);
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
        const parsed = (await res.json()) as OpenAIChatCompletionResponse;
        // Wire Truth — record the exact exchange (post-enrichment request +
        // the raw body the frozen provider will parse-and-discard) into the
        // ambient turn context. No context (live-check, diagnostics) → no-op.
        // The streaming path is deliberately uncaptured: nothing on the
        // conductor turn path streams.
        captureWireExchange({
          model: wire.model,
          request: wire,
          response: parsed,
          at: new Date().toISOString(),
        });
        return parsed;
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
