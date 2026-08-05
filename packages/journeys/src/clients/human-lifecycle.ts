/* eslint-disable no-console */
// human-lifecycle.ts — Claude drives the FULL working money loop as a real
// customer would: build a cart on the storefront (HTTP — the only surface that
// can assemble an order today, per JOURNEY-001's verified spec), amend it,
// checkout, then ask to cancel in CHAT (the kernel's confirm gate), and confirm
// the cancel via the public HTTP route. Prints the KERNEL DECISION at each
// mutation, read from intent_audit. SUT runs on the local Nemotron 4B.
//
//   Run (stack up, Node 24):
//   IBX_LIVE_CONTRACT=1 pnpm --filter @ibatexas/journeys exec tsx \
//     src/clients/human-lifecycle.ts

import { createHash } from "node:crypto"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import type { AuditRecord } from "@adjudicate/core"
import { mintCustomerToken, cookieHeader } from "./auth-fixture.js"
import { ChatClient } from "./chat-client.js"
import { createAuditReader, type AuditReader } from "../oracle/audit-reader.js"
import {
  createDomainReader,
  type DomainReader,
  type DomainOrderProjectionRow,
} from "../oracle/domain-reader.js"

const API_BASE = process.env.IBX_TEST_API_URL ?? "http://localhost:3001"
const BASE_ORIGIN = new URL(API_BASE).origin
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const ENV_TEST_PATH = path.join(REPO_ROOT, ".env.test")
const OUT_DIR = path.join(homedir(), "projects", "validation_artifacts", "human-drive")
const PHONE = "+5519900000001" // Maria Silva (JOURNEY-001's seeded customer)
const HANDLE = "costela-bovina-defumada"
const VARIANT_TITLE = "1kg"

type Say = (s: string) => void

// The slice of the cart/checkout API's JSON body this driver actually reads.
// Every field is optional: the driver hits the LIVE api and must stay standing
// on an error body (it reports `status` and the stringified blob instead).
interface ApiCart {
  id?: string
  items?: Array<{ id?: string; quantity?: number; title?: string; variant_id?: string }>
}
interface ApiBody {
  cart?: ApiCart
  orderId?: string
}

type Http = (method: string, p: string, body?: unknown) => Promise<{ status: number; json: ApiBody | null }>
type ShowDecisions = (scopes: string[], label: string) => Promise<void>

// Strip CR/LF from values that get interpolated into a log line so they can't
// forge log entries (S5145). Behaviour-preserving for ordinary values.
const logSafe = (x: unknown): string => String(x).replace(/[\r\n]+/g, " ")

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq <= 0) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}
const need = (e: Record<string, string>, k: string): string => { const v = e[k]; if (!v) { throw new Error(`.env.test missing ${k}`) } return v }
function hashScope(sessionId: string, secret: string): string {
  const h = createHash("sha256"); h.update(sessionId); h.update(secret); return `hashed:${h.digest("hex").slice(0, 8)}`
}
function decisionStr(r: AuditRecord): string {
  const d = r.decision as { kind: string; refusal?: { code?: string }; prompt?: string; to?: string; reason?: string; signal?: string }
  if (d.kind === "REFUSE") return `REFUSE (${d.refusal?.code ?? "?"})`
  if (d.kind === "REQUEST_CONFIRMATION") return `REQUEST_CONFIRMATION ("${(d.prompt ?? "").slice(0, 80)}")`
  if (d.kind === "ESCALATE") return `ESCALATE -> ${d.to ?? "?"}`
  if (d.kind === "DEFER") return `DEFER (${d.signal ?? "?"})`
  if (d.kind === "REWRITE") return `REWRITE`
  return d.kind
}

function summarizeCart(items: Array<{ quantity: number; title?: string; variant_id?: string }>): string {
  return items.map((it) => `${it.quantity}× ${it.title ?? it.variant_id ?? "item"}`).join(", ")
}

function createHttp(cookie: string): Http {
  return async function http(method, p, body) {
    // Pin the request to the configured API origin — the path is built from
    // run-time ids, so reject anything that would escape the base (S7044/S8476).
    const url = new URL(p, API_BASE)
    if (url.origin !== BASE_ORIGIN) {
      throw new Error("request URL escaped the expected API origin")
    }
    const res = await fetch(url, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    let json: ApiBody | null = null
    try { json = (await res.json()) as ApiBody } catch { json = null }
    return { status: res.status, json }
  }
}

function createShowDecisions(deps: { reader: AuditReader; seen: Set<string>; say: Say }): ShowDecisions {
  const { reader, seen, say } = deps
  return async function showDecisions(scopes, label) {
    // small grace for the audit write
    let fresh: AuditRecord[] = []
    const deadline = Date.now() + 8000
    for (;;) {
      const recs = await reader.fetchRecords({ sessionIds: scopes })
      fresh = recs.filter((r) => !seen.has(`${r.envelope.kind}:${r.envelope.intentHash}`))
      if (fresh.length > 0 || Date.now() >= deadline) {
        for (const r of recs) { seen.add(`${r.envelope.kind}:${r.envelope.intentHash}`) }
        break
      }
      await new Promise((r) => setTimeout(r, 800))
    }
    if (fresh.length === 0) {
      say(`     ⚖️  kernel: (no new ${label} envelope in audit scope)`)
    } else {
      for (const r of fresh) {
        const outcome = r.decision.kind === "EXECUTE" ? "EXECUTE ✅" : logSafe(decisionStr(r))
        say(`     ⚖️  kernel: ${logSafe(r.envelope.kind).padEnd(22)} -> ${outcome}`)
      }
    }
  }
}

async function waitForLatestOrder(
  domain: DomainReader,
  customerId: string,
  timeoutMs: number,
): Promise<DomainOrderProjectionRow | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const order = await domain.latestOrderForCustomer(customerId)
    if (order || Date.now() >= deadline) return order
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function waitForCanceledStatus(
  domain: DomainReader,
  customerId: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const o = await domain.latestOrderForCustomer(customerId)
    const finalStatus = o?.fulfillmentStatus
    if (finalStatus === "canceled" || Date.now() >= deadline) return finalStatus
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function confirmCancelStep(ctx: {
  http: Http
  say: Say
  showDecisions: ShowDecisions
  domain: DomainReader
  customerId: string
  custScope: string
  chatScope: string
  order: DomainOrderProjectionRow | null
}): Promise<void> {
  const { http, say, showDecisions, domain, customerId, custScope, chatScope, order } = ctx
  if (!order) {
    say(`\n[6] (no projected order to cancel — skipped)`)
    return
  }
  // 6. CONFIRM CANCEL via HTTP — explicit order id, within PONR -> EXECUTE
  say(`\n[6] 🧑 (confirms the cancellation) → public cancel route.`)
  const canRes = await http("POST", `/api/orders/${order.id}/cancel`, { reason: "Mudei de ideia, cancelar." })
  say(`     → POST /api/orders/${logSafe(order.id.slice(0, 10))}…/cancel  HTTP ${canRes.status}`)
  await showDecisions([custScope, chatScope], "cancel(http)")
  // final state
  const finalStatus = await waitForCanceledStatus(domain, customerId, 12000)
  const mark = finalStatus === "canceled" ? " ✅ CANCELED" : ""
  say(`\n[final] order ${logSafe(order.id.slice(0, 12))}… fulfillmentStatus = ${logSafe(finalStatus)}${mark}`)
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const env = parseEnv(await readFile(ENV_TEST_PATH, "utf8"))
  process.env.IBX_TEST_FINGERPRINT = need(env, "IBX_TEST_FINGERPRINT")
  process.env.SESSION_HMAC_SECRET = need(env, "SESSION_HMAC_SECRET")
  const jwtSecret = need(env, "JWT_SECRET")
  const redactSecret = env.AUDIT_REDACT_SECRET ?? ""

  const health = await (await fetch(`${API_BASE}/health`)).json() as { testFingerprint?: string }
  if (health.testFingerprint !== process.env.IBX_TEST_FINGERPRINT) throw new Error("wrong stack — fingerprint mismatch")

  const domain = createDomainReader({ env })
  const customer = await domain.customerByPhone(PHONE)
  if (!customer) throw new Error(`seeded customer ${PHONE} not found`)
  const variant = await domain.variantByHandle(HANDLE, VARIANT_TITLE)
  if (!variant) throw new Error(`variant ${HANDLE}/${VARIANT_TITLE} not found — catalog seeded?`)
  const customerId = customer.id

  const reader: AuditReader = createAuditReader({ env })
  const cookie = cookieHeader(mintCustomerToken({ customerId, jwtSecret }))
  const custScope = hashScope(customerId, redactSecret)

  const seen = new Set<string>()
  const log: string[] = []
  function say(s: string): void { console.log(s); log.push(s) }
  const http = createHttp(cookie)
  const showDecisions = createShowDecisions({ reader, seen, say })

  say("\n══════════════════════════════════════════════════════════════════════")
  say(`  LIVE HUMAN MONEY-LOOP — customer "${logSafe(customer.name)}" · SUT = nemotron-3-nano:4b`)
  say(`  product: ${HANDLE} (${VARIANT_TITLE}) variant ${logSafe(String(variant.id).slice(0, 16))}…`)
  say("══════════════════════════════════════════════════════════════════════")

  // 1. ORDER — open a cart on the website
  say(`\n[1] 🧑 I open the shop and start a cart.`)
  const cartRes = await http("POST", "/api/cart", {})
  const cartId = cartRes.json?.cart?.id as string | undefined
  say(`     → POST /api/cart  HTTP ${cartRes.status}  cartId=${logSafe(cartId ?? "(none)")}`)
  if (!cartId) throw new Error(`cart create failed: ${JSON.stringify(cartRes.json).slice(0, 200)}`)
  await showDecisions([custScope], "cart")

  // 2. ORDER — add 2 of the costela
  say(`\n[2] 🧑 "Add 2 units of Costela Bovina Defumada (1kg)."`)
  const addRes = await http("POST", `/api/cart/${cartId}/line-items`, { variant_id: variant.id, quantity: 2 })
  say(`     → POST .../line-items {variant, qty:2}  HTTP ${addRes.status}`)
  // resolve the line item id for the amend
  const getCart1 = await http("GET", `/api/cart/${cartId}`)
  const items1 = (getCart1.json?.cart?.items ?? []) as Array<{ id: string; quantity: number; title?: string; variant_id?: string }>
  const lineItem = items1.find((it) => it.variant_id === variant.id) ?? items1.at(-1)
  const summary1 = summarizeCart(items1) || "(empty)"
  say(`     cart now: ${logSafe(summary1)}`)

  // 3. AMEND — change quantity 2 -> 3
  say(`\n[3] 🧑 "Actually, make it 3 units."`)
  if (lineItem) {
    const patchRes = await http("PATCH", `/api/cart/${cartId}/line-items/${lineItem.id}`, { quantity: 3 })
    say(`     → PATCH .../line-items/${logSafe(lineItem.id.slice(0, 10))}… {qty:3}  HTTP ${patchRes.status}`)
    const getCart2 = await http("GET", `/api/cart/${cartId}`)
    const items2 = (getCart2.json?.cart?.items ?? []) as Array<{ quantity: number; title?: string; variant_id?: string }>
    const summary2 = summarizeCart(items2)
    say(`     cart now: ${logSafe(summary2)}`)
  } else {
    say(`     (could not resolve a line item to amend)`)
  }

  // 4. CHECKOUT — cash on pickup
  say(`\n[4] 🧑 "Finalize my order — cash, pickup."`)
  const coRes = await http("POST", "/api/cart/checkout", { cartId, paymentMethod: "cash", deliveryType: "pickup" })
  say(`     → POST /api/cart/checkout {cash, pickup}  HTTP ${coRes.status}  orderId=${logSafe(coRes.json?.orderId ?? "(pending)")}`)
  await showDecisions([custScope], "checkout")

  // resolve the order projection (projector lag tolerant)
  const order = await waitForLatestOrder(domain, customerId, 15000)
  const orderProj = order
    ? `${logSafe(order.id.slice(0, 12))}… status=${logSafe(order.fulfillmentStatus)}`
    : "(not yet projected)"
  say(`     order projection: ${orderProj}`)

  // 5. CANCEL via CHAT — the confirm gate (no order id quoted)
  say(`\n[5] 🧑 (in chat) "Quero cancelar meu pedido, por favor."`)
  const chat = new ChatClient({ baseUrl: API_BASE, cookie, turnTimeoutMs: 180_000 })
  const chatScope = hashScope(chat.sessionId, redactSecret)
  try {
    const t = await chat.perTurn("Quero cancelar meu pedido, por favor. É o meu pedido mais recente.")
    say(`     🤖 bot: ${logSafe(t.replyText.trim().slice(0, 200))}`)
  } catch (e) { say(`     ⚠️ chat turn error: ${logSafe((e as Error).message)}`) }
  await showDecisions([chatScope, custScope], "cancel(chat)")

  await confirmCancelStep({ http, say, showDecisions, domain, customerId, custScope, chatScope, order })

  say("══════════════════════════════════════════════════════════════════════\n")

  await writeFile(path.join(OUT_DIR, "lifecycle.log"), log.join("\n") + "\n")
  await reader.close().catch(() => undefined)
  process.exit(0)
}

try {
  await main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
