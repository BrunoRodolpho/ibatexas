/**
 * NemotronModelProvider — a LOCAL @claustrum/core ModelProvider for a local
 * Ollama OpenAI-compatible /v1 endpoint (e.g. nemotron-3-nano:4b).
 *
 * Implemented in apps/api (not via @claustrum/openai) to avoid adding a new
 * registry dependency (plan C1). Pure `fetch` — no `openai` SDK. Normalizes:
 *   - non-stream: choices[0].message -> Completion (text + toolCalls + tokens)
 *   - stream: OpenAI flat deltas with tool-arg fragments addressed by `index`
 *     -> CompletionChunk union (tool_use_start once per index, then
 *     tool_input_delta per fragment, terminal done/cancelled).
 *   - embed(): throws CompletionError("not_implemented") — the 4B is not an
 *     embedder; the bootstrap's failSafeGrounding catches it and degrades to
 *     empty retrieval (grounding-required intents then fail CLOSED).
 *
 * Selected in claustrum-bootstrap.ts when LLM_PROVIDER=ollama.
 */

import {
  CompletionError,
  type CancellableStream,
  type Completion,
  type CompletionChunk,
  type CompletionRequest,
  type ModelProvider,
  type StopReason,
} from "@claustrum/core"

export interface NemotronModelProviderOptions {
  baseUrl?: string
  model?: string
  apiKey?: string
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function normalizeStop(raw: string | null | undefined, hasToolUse: boolean): StopReason {
  switch (raw) {
    case "tool_calls":
    case "function_call":
      return "tool_use"
    case "length":
      return "max_tokens"
    case "content_filter":
      return "error"
    case "stop":
      return hasToolUse ? "tool_use" : "end_turn"
    default:
      return hasToolUse ? "tool_use" : "end_turn"
  }
}

function mapHttpError(status: number, body: string): CompletionError {
  if (status === 429) return new CompletionError("rate_limit", "Ollama rate limited", { vendorStatus: status, vendorMessage: body })
  if (status === 401 || status === 403) return new CompletionError("auth", "Ollama auth failed", { vendorStatus: status })
  if (status === 400) return new CompletionError("bad_request", "Ollama bad request", { vendorStatus: status, vendorMessage: body })
  if (status >= 500) return new CompletionError("vendor_5xx", `Ollama ${status}`, { vendorStatus: status, vendorMessage: body })
  return new CompletionError("unknown", `Ollama ${status}`, { vendorStatus: status, vendorMessage: body })
}

export class NemotronModelProvider implements ModelProvider {
  private readonly baseUrl: string
  private readonly model: string
  private readonly apiKey: string

  constructor(options: NemotronModelProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.LLM_BASE_URL ?? "http://192.168.1.80:11434/v1"
    this.model = options.model ?? process.env.LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? "nemotron-3-nano:4b"
    this.apiKey = options.apiKey ?? process.env.LLM_API_KEY ?? "ollama"
  }

  private body(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const messages: Array<{ role: string; content: string; tool_call_id?: string }> = []
    if (req.system !== undefined && req.system.length > 0) messages.push({ role: "system", content: req.system })
    for (const m of req.messages) messages.push({ role: m.role, content: m.content })
    return {
      model: this.model,
      messages,
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.stopSequences !== undefined ? { stop: req.stopSequences } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    }
  }

  async complete(req: CompletionRequest): Promise<Completion> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(this.body(req, false)),
        signal: req.signal,
      })
    } catch (err) {
      if ((err as Error)?.name === "AbortError") throw new CompletionError("cancelled", "aborted")
      throw new CompletionError("network", "Ollama network error", { cause: err })
    }
    if (!res.ok) throw mapHttpError(res.status, await res.text())
    const json = (await res.json()) as OpenAIChatResponse
    const message = json.choices?.[0]?.message
    const text = typeof message?.content === "string" ? message.content : ""
    const toolCalls = (message?.tool_calls ?? []).map((tc) => {
      let input: unknown
      try {
        input = tc.function.arguments.length > 0 ? JSON.parse(tc.function.arguments) : {}
      } catch {
        input = { __raw: tc.function.arguments }
      }
      return { id: tc.id, name: tc.function.name, input }
    })
    return {
      model: this.model,
      stopReason: normalizeStop(json.choices?.[0]?.finish_reason, toolCalls.length > 0),
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    }
  }

  stream(req: CompletionRequest): CancellableStream<CompletionChunk> {
    const controller = new AbortController()
    let aborted = false
    if (req.signal) {
      if (req.signal.aborted) { aborted = true; controller.abort() }
      else req.signal.addEventListener("abort", () => { aborted = true; controller.abort() }, { once: true })
    }
    const url = `${this.baseUrl}/chat/completions`
    const headers = { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }
    const payload = JSON.stringify(this.body(req, true))

    async function* gen(): AsyncGenerator<CompletionChunk> {
      let inputTokens = 0
      let outputTokens = 0
      let finish: string | null = null
      let sawTool = false
      const started = new Map<number, { id: string; name: string; emitted: boolean }>()
      try {
        const res = await fetch(url, { method: "POST", headers, body: payload, signal: controller.signal })
        if (!res.ok) throw mapHttpError(res.status, await res.text())
        const reader = res.body as unknown as AsyncIterable<Uint8Array> | null
        if (reader) {
          const decoder = new TextDecoder()
          let buf = ""
          for await (const part of reader) {
            buf += decoder.decode(part, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith("data:")) continue
              const data = line.slice(5).trim()
              if (data === "[DONE]") { buf = ""; break }
              let json: {
                choices?: Array<{
                  delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
                  finish_reason?: string | null
                }>
                usage?: { prompt_tokens?: number; completion_tokens?: number }
              }
              try { json = JSON.parse(data) } catch { continue }
              const choice = json.choices?.[0]
              if (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0) {
                yield { type: "text_delta", text: choice.delta.content }
              }
              for (const tc of choice?.delta?.tool_calls ?? []) {
                sawTool = true
                let entry = started.get(tc.index)
                if (!entry) { entry = { id: tc.id ?? "", name: tc.function?.name ?? "", emitted: false }; started.set(tc.index, entry) }
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name = tc.function.name
                if (!entry.emitted && entry.id !== "" && entry.name !== "") {
                  entry.emitted = true
                  yield { type: "tool_use_start", id: entry.id, name: entry.name }
                }
                if (tc.function?.arguments !== undefined && tc.function.arguments.length > 0 && entry.emitted) {
                  yield { type: "tool_input_delta", id: entry.id, delta: tc.function.arguments }
                }
              }
              if (choice?.finish_reason) finish = choice.finish_reason
              if (json.usage) {
                inputTokens = json.usage.prompt_tokens ?? inputTokens
                outputTokens = json.usage.completion_tokens ?? outputTokens
              }
            }
          }
        }
        if (aborted) { yield { type: "cancelled", inputTokens, outputTokens }; return }
        yield { type: "done", stopReason: normalizeStop(finish, sawTool), inputTokens, outputTokens }
      } catch (err) {
        if (aborted || (err as Error)?.name === "AbortError") { yield { type: "cancelled", inputTokens, outputTokens }; return }
        throw err instanceof CompletionError ? err : new CompletionError("network", "Ollama stream error", { cause: err })
      }
    }

    const iterator = gen()
    return {
      [Symbol.asyncIterator]() { return iterator },
      cancel(): void { if (!aborted) { aborted = true; controller.abort() } },
      get aborted(): boolean { return aborted },
    }
  }

  async embed(_text: string): Promise<number[]> {
    throw new CompletionError("not_implemented", "nemotron-3-nano:4b has no embedding capability; grounding uses fail-safe (empty) retrieval")
  }
}
