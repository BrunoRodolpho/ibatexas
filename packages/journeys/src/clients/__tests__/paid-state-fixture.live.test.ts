// T2-1 LIVE contract test — the paid-state fixture against the REAL ephemeral
// test stack. Proves the full kernel-routed paid path end to end:
//
//   storefront HTTP seeds the order (cart → line-items → cash checkout — the
//   only executable order-assembly surface today, D-014)
//     → firePaidStateWebhook signs a payment_intent.succeeded locally with
//       the stack's STRIPE_WEBHOOK_SECRET and POSTs it to the REAL
//       signature-verified route (POST /api/webhooks/stripe)
//     → the route verifies + enqueues; the BullMQ processor (now booted on
//       the test stack — the T2-1 worker-gate prod-parity fix) runs
//       handlePaymentSucceeded → buildEnvelope(payment.status.reconcile,
//       actor.principal="system") → adjudicate → Payment projection PAID
//     → awaitPaidState observes status="paid" on the oracle plane
//     → intent_audit carries the payment transition envelope (system actor,
//       sessionId `stripe-webhook:<evt id>`, HASHED by the audit redactor —
//       D-012), i.e. the asserted paid state has audited envelopes and the
//       run namespace is untouched (D-015 reconciliation invariant).
//
// GATED twice (T1a-4 idiom): IBX_LIVE_CONTRACT=1 + the /health
// testFingerprint handshake against .env.test.
//
// How to run (serialize with other agents via /tmp/ibx-test-stack.lock.d):
//   ./scripts/test-stack-up.sh
//   IBX_LIVE_CONTRACT=1 pnpm --filter @ibatexas/journeys exec vitest run \
//     src/clients/__tests__/paid-state-fixture.live.test.ts
//   ./scripts/test-stack-down.sh   # ALWAYS — including after failures

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { mintCustomerToken, cookieHeader } from "../auth-fixture.js"
import { awaitPaidState, firePaidStateWebhook } from "../paid-state-fixture.js"
import { createAuditReader, type AuditReader } from "../../oracle/audit-reader.js"
import {
  createDomainReader,
  type DomainReader,
} from "../../oracle/domain-reader.js"
import pg from "pg"

const LIVE = process.env["IBX_LIVE_CONTRACT"] === "1"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const ENV_TEST_PATH = path.join(REPO_ROOT, ".env.test")

/** Test-profile api base (process-compose.test.yaml binds :3001). */
const API_BASE = process.env["IBX_TEST_API_URL"] ?? "http://localhost:3001"

/** SEED_CUSTOMERS — Maria Silva (packages/domain/src/seed-constants.ts). */
const SEED_PHONE = "+5519900000001"

/** The audit sink's salted-hash for actor.sessionId (D-012 mirror). */
function hashedSessionId(sessionId: string, redactSecret: string): string {
  const h = createHash("sha256")
  h.update(sessionId)
  h.update(redactSecret)
  return `hashed:${h.digest("hex").slice(0, 8)}`
}

/** Minimal KEY=VALUE parser for the gitignored .env.test (no dotenv dep). */
function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function requireVar(env: Record<string, string>, name: string): string {
  const value = env[name]
  if (value === undefined || value === "") {
    throw new Error(`.env.test is missing ${name} — regenerate with ./scripts/gen-env-test.sh`)
  }
  return value
}

async function postJson(
  pathname: string,
  body: unknown,
  cookie: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    /* surfaced via status assertions */
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`POST ${pathname} -> ${res.status} ${text.slice(0, 300)}`)
  }
  return { status: res.status, json }
}

describe.skipIf(!LIVE)(
  "paid-state fixture live contract (IBX_LIVE_CONTRACT=1, test stack up)",
  () => {
    let testEnv: Record<string, string>
    let webhookSecret: string
    let redactSecret: string
    let cookie: string
    let domain: DomainReader
    let auditPool: pg.Pool
    let audit: AuditReader
    let customerId: string
    let testStart: Date

    beforeAll(async () => {
      testEnv = parseEnvFile(await readFile(ENV_TEST_PATH, "utf8"))
      const jwtSecret = requireVar(testEnv, "JWT_SECRET")
      const fingerprint = requireVar(testEnv, "IBX_TEST_FINGERPRINT")
      webhookSecret = requireVar(testEnv, "STRIPE_WEBHOOK_SECRET")
      redactSecret = requireVar(testEnv, "AUDIT_REDACT_SECRET")

      // Containment gate (D-010): the harness process carries the stack's
      // fingerprint — minting JWTs + signing webhooks both require it.
      vi.stubEnv("IBX_TEST_FINGERPRINT", fingerprint)
      vi.stubEnv("ORACLE_DATABASE_URL", requireVar(testEnv, "ORACLE_DATABASE_URL"))

      // Stack handshake — refuse to drive anything but THIS test stack.
      const health = await fetch(`${API_BASE}/health`).catch(() => {
        throw new Error(`no test stack at ${API_BASE} — run ./scripts/test-stack-up.sh first`)
      })
      const healthBody = (await health.json()) as { testFingerprint?: string }
      if (healthBody.testFingerprint !== fingerprint) {
        throw new Error(
          `health.testFingerprint mismatch — the stack at ${API_BASE} was not booted from this .env.test`,
        )
      }

      // 2s DB-clock slack — same convention as the harness runner.
      testStart = new Date(Date.now() - 2_000)

      domain = createDomainReader()
      const customer = await domain.customerByPhone(SEED_PHONE)
      if (customer === null) {
        throw new Error(`seeded customer ${SEED_PHONE} missing — run \`ibx test seed\``)
      }
      customerId = customer.id
      cookie = cookieHeader(mintCustomerToken({ customerId, jwtSecret }))

      auditPool = new pg.Pool({
        connectionString: requireVar(testEnv, "ORACLE_DATABASE_URL"),
        max: 2,
      })
      audit = createAuditReader({ pool: auditPool })
    }, 60_000)

    afterAll(async () => {
      await domain?.close()
      await auditPool?.end().catch(() => undefined)
      vi.unstubAllEnvs()
    })

    it(
      "drives a storefront-seeded order's payment to PAID through the real signed webhook route, " +
        "with the transition audited as a system-actor envelope",
      async () => {
        // ── Seed the order via the PUBLIC storefront surface (D-014 path) ──
        const variant = await domain.variantByHandle("costela-bovina-defumada", "1kg")
        expect(variant, "seeded catalog variant").not.toBeNull()

        const cart = await postJson("/api/cart", {}, cookie)
        const cartId = (cart.json["cart"] as { id?: string } | undefined)?.id
        expect(typeof cartId, "cart.id from POST /api/cart").toBe("string")

        await postJson(
          `/api/cart/${encodeURIComponent(cartId as string)}/line-items`,
          { variant_id: variant!.id, quantity: 1 },
          cookie,
        )
        await postJson(
          "/api/cart/checkout",
          { cartId, paymentMethod: "cash", deliveryType: "pickup" },
          cookie,
        )

        // The run's own order (projection plane, created after testStart).
        let orderId: string | undefined
        const orderDeadline = Date.now() + 30_000
        for (;;) {
          const latest = await domain.latestOrderForCustomer(customerId, testStart)
          if (latest !== null) {
            orderId = latest.id
            break
          }
          if (Date.now() >= orderDeadline) throw new Error("order projection never appeared")
          await new Promise((r) => setTimeout(r, 500))
        }

        const before = await domain.activePaymentByOrderId(orderId as string)
        expect(before, "active payment row after checkout").not.toBeNull()
        expect(before!.status).toBe("cash_pending")

        // ── Fire the locally signed webhook (the kernel-routed paid path) ──
        const fired = await firePaidStateWebhook({
          baseUrl: API_BASE,
          webhookSecret,
          orderId: orderId as string,
          amountInCentavos: before!.amountInCentavos,
          customerId,
        })
        expect(fired.duplicate).toBe(false)

        // ── Projection shows paid ──────────────────────────────────────────
        const paid = await awaitPaidState(domain, orderId as string)
        expect(paid.status).toBe("paid")
        expect(paid.id).toBe(before!.id)
        expect(paid.version).toBeGreaterThan(before!.version)

        // ── intent_audit carries the payment transition envelope ───────────
        // System actor: sessionId `stripe-webhook:<evt id>` — hashed by the
        // audit redactor (D-012); structurally OUTSIDE any run namespace
        // (D-015), so journey reconciliation never sees it.
        const auditScope = hashedSessionId(`stripe-webhook:${fired.eventId}`, redactSecret)
        const records = await audit.fetchRecords(
          { sessionIds: [auditScope] },
          { since: testStart },
        )
        const reconcile = records.filter((r) => r.envelope.kind === "payment.status.reconcile")
        expect(reconcile, "payment.status.reconcile envelope in the system namespace").toHaveLength(
          1,
        )
        expect(reconcile[0]!.decision.kind).toBe("EXECUTE")
        expect(reconcile[0]!.envelope.actor.principal).toBe("system")
        const payload = reconcile[0]!.envelope.payload as {
          paymentId?: string
          newStatus?: string
          stripeEventId?: string
          expectedOrderId?: string
        }
        expect(payload.paymentId).toBe(before!.id)
        expect(payload.newStatus).toBe("paid")
        expect(payload.stripeEventId).toBe(fired.eventId)
        expect(payload.expectedOrderId).toBe(orderId)

        // A re-fired event id is deduped by the route (Redis NX) — the
        // fixture's per-call fresh evt ids are what keep deliveries live.
        const refire = await firePaidStateWebhook({
          baseUrl: API_BASE,
          webhookSecret,
          orderId: orderId as string,
          amountInCentavos: before!.amountInCentavos,
          customerId,
          eventId: fired.eventId,
        })
        expect(refire.duplicate).toBe(true)
      },
      120_000,
    )
  },
)
