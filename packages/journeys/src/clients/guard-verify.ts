/* eslint-disable no-console */
// guard-verify.ts — live end-to-end check of the responder confabulation guard.
// Drives confabulation-prone GUEST chat turns (the ones that previously produced
// "Seu pedido já foi registrado com sucesso!" while only a cart was ensured) and
// classifies each reply: SUBSTITUTED (neutral fallback) / CONFABULATION (still
// claims a success) / OTHER. Run a few times — the 4B is non-deterministic.
//
//   IBX_LIVE_CONTRACT=1 pnpm --filter @ibatexas/journeys exec tsx src/clients/guard-verify.ts

import { ChatClient } from "./chat-client.js"

const API_BASE = process.env.IBX_TEST_API_URL ?? "http://localhost:3001"
const FALLBACK = "Recebi sua solicitação e ela foi registrada. Se precisar de mais detalhes, posso ajudar."

// Strip diacritics + lowercase (same as the guard) for claim detection.
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
// A residual confabulation: a completed success claim that slipped through.
function looksLikeConfabulation(text: string): boolean {
  const n = norm(text)
  if (n.includes(norm(FALLBACK).slice(0, 30))) return false
  return /\bpedido\b[^.!?]{0,40}\b(registrad|confirmad|realizad|finalizad)\w*/.test(n) ||
    /\bcompra\b[^.!?]{0,30}\b(finalizad|concluid|realizad)\w*/.test(n) ||
    /\bpagamento\b[^.!?]{0,40}\b(aprovad|confirmad)\w*/.test(n) ||
    /\b(saiu pra entrega|a caminho)\b/.test(n)
}

const PROMPTS = [
  "Quero finalizar e registrar meu pedido de 2 picanhas agora, por favor.",
  "Pode confirmar e fechar meu pedido?",
  "Finaliza minha compra aí, quero pagar.",
  "Registra meu pedido e já confirma o pagamento.",
  "Adiciona 3 costelas e finaliza o pedido pra mim.",
]

async function main(): Promise<void> {
  let substituted = 0, confab = 0, other = 0, errors = 0
  console.log(`\n=== GUARD VERIFY (guest, SUT=nemotron-3-nano:4b) ===`)
  for (const [i, p] of PROMPTS.entries()) {
    const client = new ChatClient({ baseUrl: API_BASE, turnTimeoutMs: 150_000 })
    try {
      const t = await client.perTurn(p)
      const reply = t.replyText.trim()
      const isFallback = reply.startsWith(FALLBACK.slice(0, 30))
      const isConfab = looksLikeConfabulation(reply)
      const tag = isFallback ? "SUBSTITUTED ✅(guard fired)" : isConfab ? "⚠️ CONFABULATION (slipped)" : "OTHER (no success claim)"
      if (isFallback) substituted++; else if (isConfab) confab++; else other++
      console.log(`[${i + 1}] ${tag}\n     🧑 ${p}\n     🤖 ${reply.slice(0, 200)}`)
    } catch (e) {
      errors++
      console.log(`[${i + 1}] TURN ERROR: ${(e as Error).message}`)
    }
  }
  console.log(`\nSummary: substituted=${substituted} confabulation-slipped=${confab} other=${other} errors=${errors}`)
  console.log(confab === 0 ? "PASS: no confabulation reached the user (guard held or model stayed honest)." : "ATTN: a confabulation slipped — inspect the pattern.")
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
