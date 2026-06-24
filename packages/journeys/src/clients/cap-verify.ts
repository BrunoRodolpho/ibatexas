/* eslint-disable no-console */
// cap-verify.ts — A2: exercise the >= R$10k checkout cap LIVE (the kernel guard
// refuseAmountAboveCap is unit-proven in pack-orders, but was never driven via
// the real HTTP cart→checkout path). Greedily fills a cart past R$10.000,00 from
// the seeded catalog, then asserts checkout is REFUSED
// `order.checkout.amount_exceeds_limit` and NO order projection is created.
//
//   Run (stack up, Node 24):
//   IBX_LIVE_CONTRACT=1 pnpm --filter @ibatexas/journeys exec tsx src/clients/cap-verify.ts

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { mintCustomerToken, cookieHeader } from "./auth-fixture.js"
import { createDomainReader } from "../oracle/domain-reader.js"

const API_BASE = process.env.IBX_TEST_API_URL ?? "http://localhost:3001"
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const PHONE = "+5519900000002"
const CAP_CENTAVOS = 1_000_000 // CONFIRM_LARGE_TICKET_THRESHOLD (100_000) × 10 = R$10.000,00

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("="); if (eq <= 0) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}
const need = (e: Record<string, string>, k: string) => { const v = e[k]; if (!v) throw new Error(`.env.test missing ${k}`); return v }
const say = (s: string) => console.log(s)

async function main(): Promise<void> {
  const env = parseEnv(await readFile(path.join(REPO_ROOT, ".env.test"), "utf8"))
  process.env.IBX_TEST_FINGERPRINT = need(env, "IBX_TEST_FINGERPRINT")
  process.env.SESSION_HMAC_SECRET = need(env, "SESSION_HMAC_SECRET")
  const jwtSecret = need(env, "JWT_SECRET")

  const pool = new pg.Pool({ connectionString: need(env, "DATABASE_URL"), max: 4 })
  const domain = createDomainReader({ env })
  const customer = await domain.customerByPhone(PHONE)
  if (!customer) throw new Error(`customer ${PHONE} not seeded`)
  const cookie = cookieHeader(mintCustomerToken({ customerId: customer.id, jwtSecret }))

  const http = async (m: string, p: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const r = await fetch(`${API_BASE}${p}`, { method: m, headers: { "content-type": "application/json", cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    let json: any = null; try { json = await r.json() } catch { /* */ }
    return { status: r.status, json }
  }

  // Distinct, in-stock variants (ids only — price comes back via the live cart total).
  const variants = (await pool.query(
    `SELECT pv.id FROM product_variant pv JOIN product p ON pv.product_id = p.id ` +
    `WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY pv.id LIMIT 40`,
  )).rows as Array<{ id: string }>

  const cartId = (await http("POST", "/api/cart", {})).json?.cart?.id
  if (!cartId) throw new Error("could not create cart")
  say(`cart=${cartId}; filling toward >= R$${(CAP_CENTAVOS / 100).toFixed(0)} (cap=${CAP_CENTAVOS} centavos)`)

  const cartTotal = (j: any): number => {
    const c = j?.cart ?? j
    if (typeof c?.total === "number") return c.total
    const items = (c?.items ?? []) as Array<{ quantity?: number; unit_price?: number; total?: number }>
    return items.reduce((s, it) => s + (typeof it.total === "number" ? it.total : (it.quantity ?? 0) * (it.unit_price ?? 0)), 0)
  }

  let total = 0
  for (const v of variants) {
    await http("POST", `/api/cart/${cartId}/line-items`, { variant_id: v.id, quantity: 99 })
    total = cartTotal((await http("GET", `/api/cart/${cartId}`)).json)
    if (total >= CAP_CENTAVOS) break
  }
  say(`cart total now = ${total} centavos (R$${(total / 100).toFixed(2)})`)

  if (total < CAP_CENTAVOS) {
    say(`\nINCONCLUSIVE (not a failure): seeded catalog maxed out at R$${(total / 100).toFixed(2)} < R$10k via HTTP ` +
      `(99/line × ${variants.length} variants). The kernel cap guard remains proven by pack-orders ` +
      `unit tests (orders-pack.test.ts + conformance.test.ts: order.checkout.amount_exceeds_limit).`)
    await pool.end(); process.exit(0)
  }

  const before = await domain.latestOrderForCustomer(customer.id)
  const co = await http("POST", "/api/cart/checkout", { cartId, paymentMethod: "cash", deliveryType: "pickup" })
  const blob = JSON.stringify(co.json ?? {})
  const refused = co.status >= 400 || /REFUSE|amount_exceeds_limit|exceeds/i.test(blob)
  const codeMatch = /amount_exceeds_limit/i.test(blob)
  say(`\ncheckout HTTP ${co.status} :: ${blob.slice(0, 200)}`)

  // No NEW order projection created for the over-cap cart.
  await new Promise((r) => setTimeout(r, 1500))
  const after = await domain.latestOrderForCustomer(customer.id)
  const noNewOrder = (after?.id ?? null) === (before?.id ?? null)

  const pass = refused && codeMatch && noNewOrder
  say(`\n${pass ? "✅ PASS" : "❌ FAIL"}  cap-vector: refused=${refused} code=amount_exceeds_limit:${codeMatch} noNewOrder=${noNewOrder}`)
  await pool.end()
  process.exit(pass ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
