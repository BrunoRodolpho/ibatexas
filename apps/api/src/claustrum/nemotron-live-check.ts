/**
 * Phase 0 (ibatexas-sut): live validation of the Ollama model path
 * (OpenAIProvider over OllamaFetchClient) against the FROZEN @claustrum/core
 * ModelProvider contract + live protocol checks + the embed() not_implemented
 * contract (failSafeGrounding relies on it).
 *
 *   Run: pnpm -F @ibatexas/api exec tsx src/claustrum/nemotron-live-check.ts
 *   (set LLM_BASE_URL to the Ollama endpoint, e.g. http://192.168.1.80:11434/v1)
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runModelProviderContract } from "@claustrum/core/test-doubles"
import { CompletionError, type CompletionRequest, type ModelProvider } from "@claustrum/core"
import { OpenAIProvider } from "@claustrum/openai"
import { OllamaFetchClient } from "./ollama-fetch-client.js"

const ARTIFACTS = process.env.NEMO_ARTIFACTS ?? join(homedir(), "projects", "validation_artifacts")
const PV_DIR = join(ARTIFACTS, "provider-validation")
mkdirSync(PV_DIR, { recursive: true })
const MODEL = process.env.LLM_MODEL ?? process.env.NEMOTRON_MODEL ?? "nemotron-3-nano:4b"
const BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1"

/** OpenAIProvider over the local Ollama endpoint, with the served model pinned
 *  so the contract harness hits MODEL regardless of the req.model it sends. */
const makeProvider = (): ModelProvider =>
  new OpenAIProvider({ client: new OllamaFetchClient({ baseUrl: BASE_URL, model: MODEL }) })

const results: Array<{ id: string; group: string; pass: boolean; error?: string; detail?: unknown }> = []
const queue: Array<{ name: string; body: () => void | Promise<void> }> = []
const surface = {
  describe(_n: string, b: () => void) { b() },
  it(name: string, body: () => void | Promise<void>) { queue.push({ name, body }) },
  expect<T>(actual: T) {
    return {
      toBeDefined() { if (actual === undefined || actual === null) throw new Error(`expected defined, got ${String(actual)}`) },
      toBe(e: T) { if (actual !== e) throw new Error(`expected ${String(e)}, got ${String(actual)}`) },
      toBeGreaterThan(e: number) { if (!((actual as unknown as number) > e)) throw new Error(`expected > ${e}, got ${String(actual)}`) },
      toContain(e: unknown) { const ok = Array.isArray(actual) ? actual.includes(e) : String(actual).includes(String(e)); if (!ok) throw new Error(`expected contain ${String(e)}`) },
    }
  },
}

async function runQueued(group: string) {
  for (const q of queue.splice(0, queue.length)) {
    try { await q.body(); results.push({ id: q.name, group, pass: true }); console.log(`✓ [${group}] ${q.name}`) }
    catch (e) { results.push({ id: q.name, group, pass: false, error: String((e as Error).message) }); console.log(`✗ [${group}] ${q.name} — ${(e as Error).message}`) }
  }
}

const REFUND_TOOL = { name: "express_intent", description: "Express an intent. capability + payload.", inputSchema: { type: "object", properties: { capability: { type: "string" }, payload: { type: "object" } }, required: ["capability", "payload"] } }

async function record(id: string, fn: () => Promise<{ pass: boolean; detail?: unknown }>) {
  try { const { pass, detail } = await fn(); results.push({ id, group: "protocol-live", pass, detail }); console.log(`${pass ? "✓" : "✗"} [protocol-live] ${id}`) }
  catch (e) { results.push({ id, group: "protocol-live", pass: false, error: String((e as Error).message) }); console.log(`✗ [protocol-live] ${id} — ${(e as Error).message}`) }
}

async function main(): Promise<void> {
  const provider = makeProvider()

  runModelProviderContract({ factory: makeProvider, surface, skipEmbed: true })
  await runQueued("contract")

  // PL1 stop-reason normalization (plain -> end_turn/max_tokens)
  await record("SUT-PL1-stopreason", async () => {
    const r = await provider.complete({ model: MODEL, messages: [{ role: "user", content: "Reply with one word." }], maxTokens: 24 } as CompletionRequest)
    return { pass: r.stopReason === "end_turn" || r.stopReason === "max_tokens", detail: { stopReason: r.stopReason, tokens: [r.inputTokens, r.outputTokens] } }
  })

  // PL2 complete() tool call -> tool_use + structured toolCalls
  await record("SUT-PL2-complete-toolcall", async () => {
    const r = await provider.complete({ model: MODEL, system: "When asked to refund, call express_intent with capability='pix.refund' and payload {chargeId, amountCents}. No prose.", messages: [{ role: "user", content: "Refund charge cha-5 for R$ 9,00." }], tools: [REFUND_TOOL], maxTokens: 256 } as CompletionRequest)
    const tc = r.toolCalls?.[0]
    return { pass: r.stopReason === "tool_use" && !!tc && typeof tc.id === "string" && tc.name === "express_intent", detail: { stopReason: r.stopReason, toolCall: tc } }
  })

  // PL3 stream() tool-call reassembly by index
  await record("SUT-PL3-stream-reassembly", async () => {
    const stream = provider.stream({ model: MODEL, system: "When asked to refund, call express_intent with capability and payload. No prose.", messages: [{ role: "user", content: "Refund charge cha-7 for R$ 4,00." }], tools: [REFUND_TOOL], maxTokens: 256 } as CompletionRequest)
    const seen: string[] = []
    let name: string | undefined
    for await (const c of stream) {
      seen.push(c.type)
      if (c.type === "tool_use_start") { name = c.name }
      if (c.type === "done" || c.type === "cancelled") { break }
    }
    const terminals = seen.filter((t) => t === "done" || t === "cancelled")
    return { pass: terminals.length === 1 && seen.at(-1) === terminals[0] && name === "express_intent", detail: { events: seen, name } }
  })

  // PL4 embed() throws CompletionError("not_implemented") — failSafeGrounding contract
  await record("SUT-PL4-embed-not_implemented", async () => {
    try { await provider.embed("x"); return { pass: false, detail: "embed did not throw" } }
    catch (e) { const ok = e instanceof CompletionError && e.code === "not_implemented"; return { pass: ok, detail: { code: (e as CompletionError).code } } }
  })

  // PL5 mid-flight cancel observable
  await record("SUT-PL5-stream-cancel", async () => {
    const stream = provider.stream({ model: MODEL, messages: [{ role: "user", content: "Write a long paragraph about rivers." }], maxTokens: 512 } as CompletionRequest)
    let n = 0
    for await (const _c of stream) { n += 1; if (n >= 2) { stream.cancel(); break } }
    for await (const _c of stream) { /* drain remaining chunks after cancel */ }
    return { pass: stream.aborted === true, detail: { chunks: n } }
  })

  const passed = results.filter((r) => r.pass).length
  console.log(`\nibatexas-sut provider validation: ${passed}/${results.length}`)
  writeFileSync(join(PV_DIR, "ibatexas-sut.json"), JSON.stringify({ adapter: "apps/api/src/claustrum/ollama-fetch-client.ts", subject: MODEL, baseUrl: BASE_URL, ranAt: new Date().toISOString(), passed, total: results.length, results }, null, 2))
  if (passed !== results.length) { console.error("\nibatexas-sut PROVIDER VALIDATION RED"); process.exit(1) }
  console.log("@claustrum/core ModelProvider contract + live protocol GREEN for OpenAIProvider over Ollama.")
  process.exit(0)
}

try {
  await main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
