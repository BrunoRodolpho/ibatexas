// P1-I — Pre-fix reproduction: refund drip cap TOCTOU race.
//
// This script reproduces the EXACT bug pattern that existed in
// apps/api/src/routes/admin/payments.ts before P1-I-TRUE:
//   1. GET current daily total
//   2. compute projected (current + amount)
//   3. if projected ≤ cap, proceed (simulated executeRefund delay)
//   4. INCRBY by amount
//
// With N=5 concurrent refunds at 8000 centavos and cap 20000 centavos:
//   - floor(20000/8000) = 2 → at most 2 should pass.
//   - The race lets ALL 5 read total=0, all see projected=8000 ≤ 20000,
//     all proceed, all INCRBY → final total = 40000 (2× cap).
//
// Usage: node correctness-remediation/scripts/p1i-before-race.mjs
//
// Requires Redis on localhost:6380 (the W1C cluster's container).

import { createClient } from "redis"

const REDIS_URL = process.env.REDIS_TEST_URL ?? "redis://localhost:6380"
const client = createClient({ url: REDIS_URL })
client.on("error", () => {})
await client.connect()

const KEY = `test-w1c:before-race:refund:daily-total:staff_demo:${Date.now()}`

// Clean.
await client.del(KEY)

const N = 5
const AMOUNT = 8000
const CAP = 20000
const TTL = 25 * 60 * 60

async function racyReserve(key, amount, cap, ttl) {
  // Step 1: GET (mirrors readDailyRefundTotal)
  const raw = await client.get(key)
  const current = raw ? Number.parseInt(raw, 10) : 0
  // Step 2: compute projected
  const projected = current + amount
  // Step 3: cap check
  if (projected > cap) {
    return { kind: "refused", current }
  }
  // Step 4: simulated delay between check and INCR (mirrors
  // executeRefund's kernel + Prisma + NATS round-trip).
  await new Promise((resolve) => setTimeout(resolve, 5))
  // Step 5: INCRBY post-execute (mirrors incrementDailyRefundTotal).
  const newTotal = await client.incrBy(key, amount)
  await client.expire(key, ttl)
  return { kind: "allowed", newTotal }
}

// Fire N concurrent racy reservations.
const results = await Promise.all(
  Array.from({ length: N }, () => racyReserve(KEY, AMOUNT, CAP, TTL)),
)

const allowed = results.filter((r) => r.kind === "allowed").length
const refused = results.filter((r) => r.kind === "refused").length
const finalTotal = Number.parseInt((await client.get(KEY)) ?? "0", 10)
const expectedMaxAllowed = Math.floor(CAP / AMOUNT)

console.log("=== P1-I PRE-FIX TOCTOU RACE REPRODUCTION ===")
console.log(`N=${N} concurrent reservations`)
console.log(`amount=${AMOUNT} centavos (R$${(AMOUNT / 100).toFixed(2)})`)
console.log(`cap=${CAP} centavos (R$${(CAP / 100).toFixed(2)})`)
console.log(`expected max allowed (floor(cap/amount)) = ${expectedMaxAllowed}`)
console.log(``)
console.log(`actual allowed: ${allowed}`)
console.log(`actual refused: ${refused}`)
console.log(`final stored total: ${finalTotal} centavos`)
console.log(``)
if (allowed > expectedMaxAllowed) {
  console.log(`*** RACE EXPLOITED ***`)
  console.log(`Cap bypassed: ${allowed}× allowed when only ${expectedMaxAllowed}× should have been.`)
  console.log(`Final total ${finalTotal} > cap ${CAP} (overshoot of ${finalTotal - CAP} centavos = R$${((finalTotal - CAP) / 100).toFixed(2)})`)
  process.exit(1)
} else {
  console.log(`No race observed (cap held). Re-run with higher concurrency or smaller delay.`)
  process.exit(0)
}
