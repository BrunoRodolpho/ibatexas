// live/seed-refundable-order.ts — the WS9 ops live suite's GOVERNED seed CLI.
//
// Drives a fresh order to a PAID, refundable payment through the domain
// command services' `*FromEnvelope` entry points with SYSTEM-actor envelopes
// — the SAME path apps/api/src/subscribers/cart-intelligence.ts uses. NO raw
// money-table SQL: every write is kernel-adjudicated (a decision that is not
// EXECUTE/REWRITE aborts the seed).
//
//   tsx packages/journeys/src/live/seed-refundable-order.ts \
//       --amount-reais 100            # or --amount-centavos 10000
//   -> {"orderId":"order_ws9_refund_...","displayId":90xxxx,
//       "paymentId":"...","amountInCentavos":10000,"refundableBalanceCentavos":10000,
//       "method":"cash","status":"paid","decisions":{...}}
//
// DEV-ONLY: refuses when NODE_ENV=production (this writes real money rows).
// Requires DATABASE_URL in env (the bash suite sources the dev .env first).
//
// Audit sink: a NO-OP. `getAuditSink()` needs the api's DI bootstrap, which a
// standalone seed process never runs; the adjudication decision (the gate)
// still runs — only the audit RECORD is dropped, which is correct for a seed
// (the OPS turns under test go through the running api's real sink).
//
// pt-BR: operator output is en per the script idiom (CLAUDE.md rule #4 governs
// customer-facing copy; this is a dev tool).

import { randomInt, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { buildEnvelope, type AuditSink, type IntentEnvelope } from "@adjudicate/core"
import {
  createOrderCommandService,
  createPaymentCommandService,
  prisma,
} from "@ibatexas/domain"
import {
  buildRefundableOrderSeed,
  WS9_DISPLAY_ID_BASE,
  type SeedPaymentMethod,
} from "./seed-input.js"

const NOOP_SINK: AuditSink = { emit: async () => {} } as unknown as AuditSink

/** Mirror of apps/api's buildSystemEnvelope (can't import across the leg-7 line). */
function systemEnvelope<K extends string, P>(
  kind: K,
  payload: P,
  sourceSubject: string,
  eventId: string,
): IntentEnvelope<K, P> {
  return buildEnvelope({
    kind,
    payload,
    actor: { principal: "system", sessionId: `${sourceSubject}:${eventId}` },
    taint: "SYSTEM",
    nonce: eventId,
  }) as IntentEnvelope<K, P>
}

interface SeedArgs {
  amountInCentavos: number
  method: SeedPaymentMethod
  customerId: string | null
  displayId: number | undefined
}

function parseArgs(argv: readonly string[]): SeedArgs {
  let amountCentavos: number | undefined
  let amountReais: number | undefined
  let method: SeedPaymentMethod = "cash"
  let customerId: string | null = null
  let displayId: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      i++
      return v
    }
    switch (a) {
      case "--amount-centavos":
        amountCentavos = Number(next())
        break
      case "--amount-reais":
        amountReais = Number(next())
        break
      case "--method": {
        const m = next()
        if (m !== "cash" && m !== "pix" && m !== "card") {
          throw new Error(`--method must be cash|pix|card, got ${m}`)
        }
        method = m
        break
      }
      case "--customer-id":
        customerId = next()
        break
      case "--display-id":
        displayId = Number(next())
        break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  const amountInCentavos =
    amountCentavos ??
    (amountReais === undefined ? 10_000 : Math.round(amountReais * 100))
  return { amountInCentavos, method, customerId, displayId }
}

/** EXECUTE / REWRITE are the "authorized-and-committed" decision kinds. */
function assertAuthorized(step: string, decisionKind: string): void {
  if (decisionKind !== "EXECUTE" && decisionKind !== "REWRITE") {
    throw new Error(
      `seed step "${step}" was not authorized by the kernel (decision=${decisionKind}) — refusing to report a partial seed`,
    )
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "seed-refundable-order refuses to run with NODE_ENV=production (it writes real money rows)",
    )
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("seed-refundable-order: DATABASE_URL is not set (source the dev .env first)")
  }

  const args = parseArgs(process.argv.slice(2))
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  // Dedicated test band; jitter keeps parallel runs from colliding on displayId.
  // crypto.randomInt (not Math.random) so no secret/RNG scanner flags a seed id.
  const displayId = args.displayId ?? WS9_DISPLAY_ID_BASE + randomInt(99_999)

  const plan = buildRefundableOrderSeed({
    amountInCentavos: args.amountInCentavos,
    runId,
    displayId,
    customerId: args.customerId,
    method: args.method,
  })

  const orderSvc = createOrderCommandService(undefined, { auditSink: NOOP_SINK })
  const paymentSvc = createPaymentCommandService(undefined, { auditSink: NOOP_SINK })

  // 1) order.projection.create
  const orderEnv = systemEnvelope(
    "order.projection.create",
    plan.orderProjectionPayload,
    "ws9-ops-live-suite",
    `projection:${plan.orderId}`,
  )
  const orderOutcome = await orderSvc.createFromEnvelope(
    orderEnv as never,
    plan.orderProjectionFullInput,
  )
  assertAuthorized("order.projection.create", orderOutcome.decision.kind)

  // 2) payment.create (method -> initial cash_pending / awaiting_payment)
  const paymentEnv = systemEnvelope(
    "payment.create",
    plan.paymentCreatePayload,
    "ws9-ops-live-suite",
    `payment:${plan.orderId}`,
  )
  const paymentOutcome = await paymentSvc.createFromEnvelope(paymentEnv as never)
  assertAuthorized("payment.create", paymentOutcome.decision.kind)
  const paymentId = paymentOutcome.result?.id
  if (!paymentId) {
    throw new Error("payment.create authorized but returned no payment id")
  }

  // 3) payment.status.transition -> paid
  const paidEnv = systemEnvelope(
    "payment.status.transition",
    {
      paymentId,
      newStatus: plan.paidTransition.newStatus,
      actor: plan.paidTransition.actor,
      reason: "ws9-ops-live-suite governed seed",
    },
    "ws9-ops-live-suite",
    `paid:${paymentId}`,
  )
  const paidOutcome = await paymentSvc.transitionStatusFromEnvelope(paidEnv as never)
  assertAuthorized("payment.status.transition->paid", paidOutcome.decision.kind)

  process.stdout.write(
    `${JSON.stringify({
      orderId: plan.orderId,
      displayId: plan.displayId,
      paymentId,
      amountInCentavos: plan.amountInCentavos,
      refundableBalanceCentavos: plan.amountInCentavos,
      method: plan.method,
      status: "paid",
      decisions: {
        order: orderOutcome.decision.kind,
        payment: paymentOutcome.decision.kind,
        paid: paidOutcome.decision.kind,
      },
    })}\n`,
  )
}

const invokedPath = process.argv[1] ?? ""
if (invokedPath !== "" && fileURLToPath(import.meta.url) === invokedPath) {
  // Top-level await (repo entry-script convention) rather than a promise chain.
  try {
    await main()
    await prisma.$disconnect()
    process.exit(0)
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    await prisma.$disconnect().catch(() => {})
    process.exit(1)
  }
}
